import WebSocket from 'ws';
import dotenv from 'dotenv';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { KJUR } from 'jsrsasign';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env here too: ES module imports are evaluated before the importer's
// body runs, so CONFIG below must see env vars regardless of import order.
dotenv.config({ path: path.join(__dirname, '.env') });

const LOG = '[ZoomScribeMultitrack]';
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;

// How long cleanup waits for session.closed after session.close. In multitrack
// the gateway withholds session.closed until every lane has drained its open
// utterance, so allow more time than a single-pipeline session needs.
const FINALIZE_WAIT_MS = 5000;

// The session reconnects on: an abnormal WS close, a handshake rejection (e.g.
// capacity_exceeded/503, rate_limited/429), an in-band capacity_exceeded or
// rate_limited error (fatal, or a rejected session.update), or a session.closed
// with reason=server_shutting_down. Each counts against MAX_RECONNECT_ATTEMPTS
// with exponential backoff off CONFIG.reconnectDelayMs (base * 2^n); the counter
// resets once a reconnect fully succeeds (session.updated). A 429's Retry-After
// header is honored as a floor under that backoff.
const MAX_RECONNECT_ATTEMPTS = 3;

// `mixed` is deliberately not offered: per-participant RTMS audio overlaps
// whenever two people talk at once, which a mixed session rejects with a fatal
// concurrent_sources error.
const INPUT_MODES = new Set(['multitrack', 'auto']);

function requireValue(value, name) {
  if (!value || String(value).trim() === '') throw new Error(`${name} is required`);
}

function envBoolean(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value.trim() === '') return defaultValue;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function envPositiveNumber(name, defaultValue) {
  const value = Number(process.env[name] ?? defaultValue);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function envInputMode(name, defaultValue) {
  const value = (process.env[name] || defaultValue).trim().toLowerCase();
  if (!INPUT_MODES.has(value)) throw new Error(`${name} must be multitrack or auto`);
  return value;
}

// A 429's Retry-After header is either delta-seconds ("120") or an HTTP-date
// ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns null when absent/unparseable, so
// the caller falls back to the normal exponential backoff.
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

export function parseVocabulary(value) {
  if (value == null || String(value).trim() === '') return null;

  let vocabulary;
  try {
    vocabulary = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(`SCRIBE_VOCABULARY_JSON must be valid JSON: ${error.message}`);
  }

  if (!vocabulary || typeof vocabulary !== 'object' || Array.isArray(vocabulary)) {
    throw new Error('SCRIBE_VOCABULARY_JSON must be a JSON object');
  }

  const allowedKeys = new Set(['phrases', 'pronunciations', 'aliases']);
  const unknownKey = Object.keys(vocabulary).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`SCRIBE_VOCABULARY_JSON contains unsupported field: ${unknownKey}`);
  }

  const result = {};
  if (vocabulary.phrases != null) {
    if (!Array.isArray(vocabulary.phrases) ||
        vocabulary.phrases.some((phrase) => typeof phrase !== 'string' || !phrase.trim())) {
      throw new Error('SCRIBE_VOCABULARY_JSON phrases must be an array of non-empty strings');
    }
    if (vocabulary.phrases.length > 0) result.phrases = vocabulary.phrases;
  }

  if (vocabulary.pronunciations != null) {
    if (!Array.isArray(vocabulary.pronunciations) ||
        vocabulary.pronunciations.some((entry) =>
          !entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.phrase !== 'string' || !entry.phrase.trim() ||
          typeof entry.pronunciation !== 'string' || !entry.pronunciation.trim()
        )) {
      throw new Error(
        'SCRIBE_VOCABULARY_JSON pronunciations must contain phrase and pronunciation strings'
      );
    }
    if (vocabulary.pronunciations.length > 0) {
      result.pronunciations = vocabulary.pronunciations;
    }
  }

  if (vocabulary.aliases != null) {
    if (!Array.isArray(vocabulary.aliases) ||
        vocabulary.aliases.some((entry) =>
          !entry || typeof entry !== 'object' || Array.isArray(entry) ||
          typeof entry.canonical !== 'string' || !entry.canonical.trim() ||
          !Array.isArray(entry.variants) || entry.variants.length === 0 ||
          entry.variants.some((variant) => typeof variant !== 'string' || !variant.trim())
        )) {
      throw new Error(
        'SCRIBE_VOCABULARY_JSON aliases must contain a canonical string and non-empty variants array'
      );
    }
    if (vocabulary.aliases.length > 0) result.aliases = vocabulary.aliases;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Zoom AI Services Scribe uses a Build-platform HS256 JWT: `iss` is ZOOM_API_KEY
// and the token is signed with ZOOM_API_SECRET.
export function generateScribeJwt(apiKey, apiSecret) {
  requireValue(apiKey, 'ZOOM_API_KEY');
  requireValue(apiSecret, 'ZOOM_API_SECRET');
  const iat = Math.round(Date.now() / 1000) - 30;
  const exp = iat + 60 * 60;
  return KJUR.jws.JWS.sign(
    'HS256',
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    JSON.stringify({ iss: apiKey, iat, exp }),
    apiSecret
  );
}

const CONFIG = {
  apiKey: process.env.ZOOM_API_KEY,
  apiSecret: process.env.ZOOM_API_SECRET,
  liveUrl: process.env.SCRIBE_LIVE_URL || 'wss://api.zoom.us/v2/aiservices/scribe/live',
  language: process.env.SCRIBE_LANGUAGE || 'en-US',
  inputMode: envInputMode('SCRIBE_INPUT_MODE', 'multitrack'),
  wordTimeOffsets: envBoolean('SCRIBE_WORD_TIME_OFFSETS', true),
  diarization: envBoolean('SCRIBE_DIARIZATION', false),
  interimResults: envBoolean('SCRIBE_INTERIM_RESULTS', false),
  profanityFilter: envBoolean('SCRIBE_PROFANITY_FILTER', false),
  vocabulary: parseVocabulary(process.env.SCRIBE_VOCABULARY_JSON),
  logRawEvents: envBoolean('SCRIBE_LOG_RAW_EVENTS', false),
  pingIntervalMs: envPositiveNumber('SCRIBE_PING_INTERVAL_MS', 15000),
  heartbeatIdleMs: envPositiveNumber('SCRIBE_HEARTBEAT_IDLE_MS', 10000),
  heartbeatAudioMs: envPositiveNumber('SCRIBE_HEARTBEAT_AUDIO_MS', 1000),
  reconnectDelayMs: envPositiveNumber('SCRIBE_RECONNECT_DELAY_MS', 2000),
  // Kept under the gateway's ~2 s per-participant admission buffer, so a backlog
  // flushed in one burst after (re)connecting is not dropped as multitrack_capacity.
  pendingAudioMs: envPositiveNumber('SCRIBE_PENDING_AUDIO_MS', 1500),
  saveDiarizedTranscript: envBoolean('SCRIBE_SAVE_DIARIZED_TRANSCRIPT', false),
  transcriptOutputDir: path.resolve(
    __dirname,
    process.env.SCRIBE_TRANSCRIPT_OUTPUT_DIR || 'diarized_transcripts'
  ),
};

const PENDING_BYTES_PER_PARTICIPANT = Math.round(CONFIG.pendingAudioMs * BYTES_PER_SECOND / 1000);

export function buildSessionUpdatePayload() {
  return {
    type: 'session.update',
    // input_mode is sent explicitly so session.updated echoes the resolved mode.
    audio: { format: 'pcm16', input_mode: CONFIG.inputMode },
    config: {
      language: CONFIG.language,
      word_time_offsets: CONFIG.wordTimeOffsets,
      diarization: CONFIG.diarization,
      interim_results: CONFIG.interimResults,
      profanity_filter: CONFIG.profanityFilter,
      ...(CONFIG.vocabulary ? { vocabulary: CONFIG.vocabulary } : {}),
    },
  };
}

// RTMS stamps audio with epoch milliseconds, but tolerate micro/nanosecond
// clocks. The gateway rejects a non-integer timestamp, so always round.
export function normalizeEpochMs(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (Math.abs(number) >= 1e17) return Math.round(number / 1e6);
  if (Math.abs(number) >= 1e14) return Math.round(number / 1e3);
  if (Math.abs(number) >= 1e11) return Math.round(number);
  return null;
}

// The input_audio_buffer.append that binds RTMS metadata to the next binary
// frame. user_id is the source identity the gateway demultiplexes on; user_name
// is echoed back but never interpreted. Returns null when there is no identity,
// because multitrack rejects a frame it cannot assign to a source.
export function buildAppendMessage({ userId, userName, timestamp } = {}) {
  if (userId == null || userId === '') return null;
  const metadata = {};
  const epochMs = normalizeEpochMs(timestamp);
  if (epochMs != null) metadata.timestamp = epochMs;
  metadata.user_id = userId;
  if (userName) metadata.user_name = userName;
  return { type: 'input_audio_buffer.append', metadata };
}

// Lanes 1+ prefix item_ids with `l<n>:`. Lane 0 is unprefixed in auto mode, so
// the first prefixed lane above 0 is the visible sign that auto switched to lanes.
export function laneOf(itemId) {
  const match = /^l(\d+):/.exec(String(itemId ?? ''));
  return match ? Number(match[1]) : null;
}

// Pings prove liveness to a multitrack session, and to an auto session once it
// has switched to lanes. Before that, auto only counts audio as activity.
export function needsSilenceHeartbeat({ inputMode, lanesObserved, idleMs, heartbeatIdleMs }) {
  return inputMode === 'auto' && !lanesObserved && idleMs >= heartbeatIdleMs;
}

// The gateway echoes the metadata this sample sent, so user_id is the identity.
// `{}` marks audio no participant was attributed to.
function participantOf(metadata) {
  if (!metadata || typeof metadata !== 'object' || metadata.user_id == null) return null;
  return { user_id: metadata.user_id, user_name: metadata.user_name ?? null };
}

// Offsets inside one utterance map linearly onto the gateway's absolute clock,
// anchored at the utterance's own start_timestamp.
function offsetToEpochMs(event, offsetMs) {
  if (typeof event.start_timestamp !== 'number' || offsetMs == null) return null;
  const offset = Number(offsetMs);
  if (!Number.isFinite(offset)) return null;
  return event.start_timestamp + (offset - Number(event.audio_start_ms ?? 0));
}

function dominantParticipant(metadataSegments) {
  let best = null;
  let bestDuration = -1;
  for (const segment of metadataSegments) {
    const participant = participantOf(segment.metadata);
    const duration = Number(segment.audio_end_ms ?? 0) - Number(segment.audio_start_ms ?? 0);
    if (participant && duration > bestDuration) {
      best = participant;
      bestDuration = duration;
    }
  }
  return best;
}

// Normalize a transcription.completed event. The RTMS participant comes from the
// gateway's metadata echo; Scribe's diarization label, when present, is reported
// beside it rather than merged into it, because one RTMS source can be a shared
// room with several voices.
export function formatUtterance(meetingUuid, event, receivedAt = Date.now()) {
  const metadataSegments = Array.isArray(event.metadata_segments) ? event.metadata_segments : [];
  const utterance = {
    event: 'transcript.utterance',
    source_event: 'transcription.completed',
    meeting_uuid: meetingUuid,
    item_id: event.item_id ?? null,
    participant: participantOf(event.metadata) ?? dominantParticipant(metadataSegments),
    start_time: typeof event.start_timestamp === 'number' ? event.start_timestamp : null,
    end_time: typeof event.end_timestamp === 'number' ? event.end_timestamp : null,
    received_time: receivedAt,
    text: event.transcript || '',
  };

  // More than one source fed this utterance (a fast handover on a mixed timeline).
  if (metadataSegments.length > 0) {
    utterance.participant_segments = metadataSegments.map((segment) => ({
      participant: participantOf(segment.metadata),
      start_time: offsetToEpochMs(event, segment.audio_start_ms),
      end_time: offsetToEpochMs(event, segment.audio_end_ms),
    }));
  }

  if (typeof event.speaker === 'string' && event.speaker) utterance.speaker = event.speaker;
  if (Array.isArray(event.speaker_segments) && event.speaker_segments.length > 0) {
    utterance.speaker_segments = event.speaker_segments.map((segment) => ({
      speaker: segment.speaker ?? 'unknown',
      text: segment.transcript ?? segment.text ?? '',
      start_time: offsetToEpochMs(event, segment.audio_start_ms),
      end_time: offsetToEpochMs(event, segment.audio_end_ms),
    }));
  }
  if (Number.isFinite(event.source_speaker_count)) {
    utterance.source_speaker_count = event.source_speaker_count;
  }
  return utterance;
}

// Lanes complete asynchronously, so finals arrive in arrival order, not time
// order. Sort by the gateway's absolute start time for the meeting transcript.
export function buildDiarizedTranscript(meetingUuid, utterances, generatedAt = Date.now()) {
  const sortKey = (item) => item.start_time ?? item.received_time;
  return {
    schema_version: 1,
    event: 'transcript.final',
    meeting_uuid: meetingUuid,
    generated_time: generatedAt,
    utterances: [...utterances]
      .sort((left, right) => sortKey(left) - sortKey(right))
      .map(({ event, source_event, meeting_uuid, ...utterance }) => utterance),
  };
}

export async function writeDiarizedTranscript(outputDir, document) {
  const safeMeetingUuid = String(document.meeting_uuid || 'meeting')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 100) || 'meeting';
  const timestamp = new Date(document.generated_time).toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outputDir, `${safeMeetingUuid}-${timestamp}.json`);
  const temporaryPath = `${filePath}.tmp`;

  await mkdir(outputDir, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
  return filePath;
}

// meetingUuid -> session
const sessions = new Map();
let webSocketFactory = (url, protocols) => new WebSocket(url, protocols);

export function setWebSocketFactoryForTesting(factory = null) {
  webSocketFactory = factory || ((url, protocols) => new WebSocket(url, protocols));
}

export function liveScribeConfig() {
  return {
    liveUrl: CONFIG.liveUrl,
    language: CONFIG.language,
    inputMode: CONFIG.inputMode,
    wordTimeOffsets: CONFIG.wordTimeOffsets,
    diarization: CONFIG.diarization,
    interimResults: CONFIG.interimResults,
    profanityFilter: CONFIG.profanityFilter,
    vocabulary: CONFIG.vocabulary,
    logRawEvents: CONFIG.logRawEvents,
    pingIntervalMs: CONFIG.pingIntervalMs,
    heartbeatIdleMs: CONFIG.heartbeatIdleMs,
    heartbeatAudioMs: CONFIG.heartbeatAudioMs,
    reconnectDelayMs: CONFIG.reconnectDelayMs,
    pendingAudioMs: CONFIG.pendingAudioMs,
    saveDiarizedTranscript: CONFIG.saveDiarizedTranscript,
    transcriptOutputDir: CONFIG.transcriptOutputDir,
  };
}

export function activeSessionCount() {
  return sessions.size;
}

export function getSessionSnapshot(meetingUuid) {
  const session = sessions.get(meetingUuid);
  if (!session) return null;
  return {
    meetingUuid,
    inputMode: CONFIG.inputMode,
    resolvedInputMode: session.resolvedInputMode,
    ready: session.ready,
    sessionId: session.sessionId,
    participants: session.participants.size,
    lanesSeen: [...session.lanesSeen].sort((left, right) => left - right),
    sentBytes: session.sentBytes,
    queuedBytes: session.queuedBytes,
    droppedFrames: session.droppedFrames,
    capacityWarnings: session.capacityWarnings,
    completedUtterances: session.completed.length,
    reconnectAttempts: session.reconnectAttempts,
  };
}

// Open one live transcription WebSocket for the whole meeting (called on
// meeting.rtms_started). Every participant shares it; the gateway demultiplexes.
export function initializeLiveScribeSession(meetingUuid) {
  if (!meetingUuid || sessions.has(meetingUuid)) return;
  const session = {
    meetingUuid,
    ws: null,
    ready: false,
    stopRequested: false,
    sessionId: null,
    resolvedInputMode: null,
    lanesObserved: false,
    lanesSeen: new Set(),
    participants: new Map(),
    queued: [],
    queuedBytes: 0,
    queuedBytesByKey: new Map(),
    sentBytes: 0,
    sourceBytes: 0,
    chunks: 0,
    droppedFrames: 0,
    capacityWarnings: 0,
    missingSourceWarned: false,
    lastAudioSentAt: 0,
    lastPingAt: 0,
    livenessTimer: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    pendingReconnectReason: null,
    startedAt: Date.now(),
    completed: [],
    closedWaiters: [],
  };
  sessions.set(meetingUuid, session);
  console.log(`${LOG} Initializing ${CONFIG.inputMode} session for meeting ${meetingUuid}`);
  connect(session);
}

// Stream one participant's RTMS audio packet (16 kHz mono PCM16 LE), paired with
// the append that tells the gateway whose audio it is.
export function sendAudioChunk(buffer, meetingUuid, participantInfo = {}) {
  if (!buffer?.length) return;
  const session = sessions.get(meetingUuid);
  if (!session || session.stopRequested) return;

  const append = buildAppendMessage(participantInfo);
  if (!append) {
    session.droppedFrames += 1;
    if (!session.missingSourceWarned) {
      session.missingSourceWarned = true;
      console.warn(`${LOG} RTMS audio arrived without a user_id; it cannot be assigned to a lane and is dropped`);
    }
    return;
  }

  const key = String(append.metadata.user_id);
  session.participants.set(key, append.metadata.user_name ?? null);
  session.chunks += 1;
  session.sourceBytes += buffer.length;
  const frame = { key, append: JSON.stringify(append), buffer };

  // Anything already queued must go first so each participant stays in order.
  if (session.ready && session.ws?.readyState === WebSocket.OPEN && session.queued.length === 0) {
    try {
      transmitFrame(session, frame);
    } catch (error) {
      console.error(`${LOG} send failed, queuing: ${error.message}`);
      queueFrame(session, { ...frame, buffer: Buffer.from(buffer) });
    }
  } else {
    // Not connected/ready yet (handshake + session.update in flight). Copy:
    // queued audio outlives this callback.
    queueFrame(session, { ...frame, buffer: Buffer.from(buffer) });
  }

  if (session.chunks % 200 === 0) {
    const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(1);
    console.log(
      `${LOG} [${String(meetingUuid).slice(0, 8)}] chunks=${session.chunks} participants=${session.participants.size} ` +
      `lanesSeen=${[...session.lanesSeen].join(',') || '-'} sentBytes=${session.sentBytes} ` +
      `queuedBytes=${session.queuedBytes} dropped=${session.droppedFrames} elapsed=${elapsed}s`
    );
  }
}

// The append and its audio go out back to back. WebSocket preserves frame
// order, which is the whole pairing contract.
function transmitFrame(session, frame) {
  session.ws.send(frame.append);
  session.ws.send(frame.buffer);
  session.sentBytes += frame.buffer.length;
  session.lastAudioSentAt = Date.now();
}

function queueFrame(session, frame) {
  session.queued.push(frame);
  session.queuedBytes += frame.buffer.length;
  session.queuedBytesByKey.set(
    frame.key,
    (session.queuedBytesByKey.get(frame.key) ?? 0) + frame.buffer.length
  );
  // Bound the backlog per participant, dropping that participant's oldest audio.
  while ((session.queuedBytesByKey.get(frame.key) ?? 0) > PENDING_BYTES_PER_PARTICIPANT) {
    const index = session.queued.findIndex((queued) => queued.key === frame.key);
    if (index < 0) break;
    removeQueued(session, index);
    session.droppedFrames += 1;
  }
}

function removeQueued(session, index) {
  const [removed] = session.queued.splice(index, 1);
  session.queuedBytes -= removed.buffer.length;
  const remaining = (session.queuedBytesByKey.get(removed.key) ?? 0) - removed.buffer.length;
  if (remaining > 0) session.queuedBytesByKey.set(removed.key, remaining);
  else session.queuedBytesByKey.delete(removed.key);
}

function flushQueue(session) {
  while (session.ready && session.ws?.readyState === WebSocket.OPEN && session.queued.length > 0) {
    try {
      transmitFrame(session, session.queued[0]);
    } catch (error) {
      console.error(`${LOG} flush failed: ${error.message}`);
      break;
    }
    removeQueued(session, 0);
  }
}

function startLiveness(session) {
  stopLiveness(session);
  const tickMs = Math.max(10, Math.min(1000, CONFIG.pingIntervalMs, CONFIG.heartbeatIdleMs));
  session.livenessTimer = setInterval(() => livenessTick(session), tickMs);
  session.livenessTimer.unref?.();
}

function stopLiveness(session) {
  if (session.livenessTimer) clearInterval(session.livenessTimer);
  session.livenessTimer = null;
}

// RTMS participant streams are gated: a muted or silent participant sends
// nothing. The session must stay alive through those stretches without
// inventing audio, so liveness is a WebSocket ping wherever the gateway accepts one.
function livenessTick(session) {
  const ws = session.ws;
  if (!session.ready || ws?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();

  if (now - session.lastPingAt >= CONFIG.pingIntervalMs) {
    try {
      ws.ping();
      session.lastPingAt = now;
    } catch (error) {
      console.warn(`${LOG} WebSocket ping failed: ${error.message}`);
    }
  }

  if (needsSilenceHeartbeat({
    inputMode: CONFIG.inputMode,
    lanesObserved: session.lanesObserved,
    idleMs: now - session.lastAudioSentAt,
    heartbeatIdleMs: CONFIG.heartbeatIdleMs,
  })) {
    // Unattributed on purpose: in auto mode before any overlap this lands on the
    // mixed timeline. Whole samples only.
    const bytes = Math.round(BYTES_PER_SECOND * CONFIG.heartbeatAudioMs / 1000 / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;
    try {
      ws.send(Buffer.alloc(bytes));
      session.lastAudioSentAt = now;
    } catch (error) {
      console.error(`${LOG} silence heartbeat failed: ${error.message}`);
    }
  }
}

function connect(session) {
  if (session.stopRequested) return;

  let jwt;
  try {
    jwt = generateScribeJwt(CONFIG.apiKey, CONFIG.apiSecret);
  } catch (error) {
    console.error(`${LOG} cannot mint Scribe JWT: ${error.message}`);
    return;
  }

  // Auth is carried in the WebSocket subprotocol list: "live-asr" is the real
  // subprotocol; "zoom-api-access-token.<jwt>" presents the credential.
  console.log(`${LOG} Connecting to ${CONFIG.liveUrl} for meeting ${session.meetingUuid}`);
  const ws = webSocketFactory(CONFIG.liveUrl, ['live-asr', `zoom-api-access-token.${jwt}`]);
  session.ws = ws;
  session.ready = false;
  session.resolvedInputMode = null;
  // A new server session starts on a single timeline again in auto mode.
  session.lanesObserved = false;

  ws.on('open', () => {
    if (session.ws !== ws) return;
    console.log(`${LOG} Connected for meeting ${session.meetingUuid}`);
    try {
      const payload = buildSessionUpdatePayload();
      ws.send(JSON.stringify(payload));
      console.log(`${LOG} Sent session.update ${JSON.stringify(payload)}`);
    } catch (error) {
      console.error(`${LOG} session.update send failed: ${error.message}`);
    }
    startLiveness(session);
  });

  ws.on('message', (data, isBinary) => {
    if (session.ws === ws && !isBinary) handleServerEvent(session, data);
  });

  ws.on('error', (error) => {
    console.error(`${LOG} WebSocket error for meeting ${session.meetingUuid}: ${error.message}`);
  });

  // A non-101 handshake response (e.g. 503 capacity_exceeded, 429 rate_limited)
  // lands here instead of 'open'/'close': with this listener attached, `ws`
  // does not tear itself down or emit 'close', so we must drain the response
  // and drive reconnection ourselves.
  ws.on('unexpected-response', (req, res) => {
    if (session.ws !== ws) return;
    res.resume(); // drain so the underlying socket can close cleanly
    const statusCode = res.statusCode;
    let reason;
    let minDelayMs = 0;
    if (statusCode === 503) {
      reason = 'capacity_exceeded';
    } else if (statusCode === 429) {
      reason = 'rate_limited';
      minDelayMs = parseRetryAfterMs(res.headers['retry-after']) ?? 0;
    } else {
      reason = `http_${statusCode}`;
    }
    console.error(
      `${LOG} Handshake rejected for meeting ${session.meetingUuid}: ${reason} (HTTP ${statusCode})` +
      (minDelayMs > 0 ? ` retry_after=${minDelayMs}ms` : '')
    );
    scheduleReconnect(session, reason, minDelayMs);
  });

  ws.on('close', (code, reason) => {
    if (session.ws !== ws) return;
    session.ready = false;
    stopLiveness(session);
    const reasonText = reason?.toString() || '';
    console.log(`${LOG} Closed for meeting ${session.meetingUuid}: ${code} ${reasonText}`);
    session.closedWaiters.splice(0).forEach((resolve) => resolve());
    if (session.stopRequested) return;
    // A clean, unflagged close (code 1000, no server_shutting_down/capacity_exceeded
    // reason recorded via handleServerEvent) is treated as intentional -- don't reconnect.
    if (code === 1000 && !session.pendingReconnectReason) return;
    const reconnectReason = session.pendingReconnectReason || reasonText || `close_code_${code}`;
    session.pendingReconnectReason = null;
    scheduleReconnect(session, reconnectReason);
  });
}

// Reconnect with exponential backoff (reconnectDelayMs * 2^attempt), up to
// MAX_RECONNECT_ATTEMPTS consecutive failures, then give up on the session.
// `minDelayMs` (e.g. a 429's Retry-After) raises the floor under that backoff.
function scheduleReconnect(session, reason, minDelayMs = 0) {
  if (session.stopRequested || session.reconnectTimer) return;
  if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    failSession(
      session,
      `gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempt(s), last reason: ${reason}`
    );
    return;
  }
  session.reconnectAttempts += 1;
  const backoffMs = CONFIG.reconnectDelayMs * 2 ** (session.reconnectAttempts - 1);
  const delay = Math.max(backoffMs, minDelayMs);
  console.warn(
    `${LOG} Reconnecting for meeting ${session.meetingUuid} in ${delay}ms ` +
    `(attempt ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, reason: ${reason})`
  );
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    connect(session);
  }, delay);
}

// Stop retrying, tear down the socket, and surface a hard, unmistakable failure
// in the logs (this service has no interactive terminal, so this IS the prompt).
function failSession(session, detail) {
  console.error(`${LOG} CONNECTION FAILED for meeting ${session.meetingUuid}: ${detail}.`);
  session.stopRequested = true;
  stopLiveness(session);
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
  try { session.ws?.terminate(); } catch { /* ignore */ }
  sessions.delete(session.meetingUuid);
}

function handleServerEvent(session, raw) {
  const tag = `[${String(session.meetingUuid).slice(0, 8)}]`;
  const rawText = raw.toString();
  if (CONFIG.logRawEvents) {
    console.log(`${LOG} ${tag} RAW ${rawText}`);
  }

  let event;
  try {
    event = JSON.parse(rawText);
  } catch {
    return;
  }

  // The lane is an implementation detail -- the participant comes from the
  // metadata echo -- but it shows the pool at work and reveals auto's switch.
  const lane = laneOf(event.item_id);
  if (lane != null) session.lanesSeen.add(lane);
  if (lane != null && lane > 0 && !session.lanesObserved) {
    session.lanesObserved = true;
    if (CONFIG.inputMode === 'auto') {
      console.log(`${LOG} ${tag} participants overlapped; auto session switched to per-participant lanes`);
    }
  }

  switch (event.type) {
    case 'session.created':
      session.sessionId = event.session_id || null;
      console.log(`${LOG} ${tag} session.created id=${session.sessionId}`);
      break;
    case 'session.updated':
      session.ready = true;
      session.reconnectAttempts = 0; // fully re-established -- reset the retry budget
      session.resolvedInputMode = event.input_mode ?? null;
      session.lastAudioSentAt = Date.now();
      session.lastPingAt = Date.now();
      console.log(
        `${LOG} ${tag} session.updated input_mode=${event.input_mode} ` +
        `diarization_enabled=${event.diarization_enabled}; streaming audio`
      );
      if (event.input_mode && event.input_mode !== CONFIG.inputMode) {
        console.warn(
          `${LOG} ${tag} requested input_mode=${CONFIG.inputMode} but the server resolved ${event.input_mode}`
        );
      }
      flushQueue(session);
      break;
    case 'transcription.delta':
      if (CONFIG.interimResults) {
        const who = participantOf(event.metadata)?.user_name ?? 'Unknown participant';
        console.log(`${LOG} ${tag} partial ${who}: ${event.delta ?? ''}`);
      }
      break;
    case 'transcription.completed': {
      const utterance = formatUtterance(session.meetingUuid, event);
      if (utterance.text) {
        session.completed.push(utterance);
        console.log(JSON.stringify(utterance, null, 2));
      }
      break;
    }
    case 'error':
      handleErrorEvent(session, tag, event.error || {});
      break;
    case 'session.closed':
      console.log(`${LOG} ${tag} session.closed reason=${event.reason}`);
      if (event.reason === 'server_shutting_down') {
        // Rolling update evicted this pod, not a real failure -- flag for the
        // 'close' handler so it reconnects even if the transport close code is 1000.
        session.pendingReconnectReason = 'server_shutting_down';
        console.warn(`${LOG} ${tag} server is shutting down this session; will reconnect`);
      }
      session.closedWaiters.splice(0).forEach((resolve) => resolve());
      break;
    default:
      break;
  }
}

function handleErrorEvent(session, tag, error) {
  const { code, message, fatal } = error;

  if (code === 'multitrack_capacity') {
    // Non-fatal: every lane stayed busy past the gateway's admission window and
    // a frame was dropped. Expected only under heavy crosstalk; don't flood logs.
    session.capacityWarnings += 1;
    if (session.capacityWarnings === 1 || session.capacityWarnings % 50 === 0) {
      console.warn(`${LOG} ${tag} multitrack_capacity (${session.capacityWarnings} so far): ${message}`);
    }
    return;
  }

  console.error(`${LOG} ${tag} server error code=${code} msg=${message} fatal=${fatal}`);

  // A session.update the gateway cannot apply -- e.g. it could not reserve the
  // extra lanes -- is answered with a non-fatal error and no session.updated,
  // leaving a socket that never becomes ready.
  const updateRejected = !session.ready && !fatal;

  if ((code === 'capacity_exceeded' || code === 'rate_limited') && (fatal || updateRejected)) {
    // Flag the reason for the 'close' handler and proactively close rather than
    // waiting on the server.
    session.pendingReconnectReason = code;
    console.warn(`${LOG} ${tag} ${code}; closing and reconnecting`);
    try { session.ws?.close(); } catch { /* ignore */ }
    return;
  }

  if (code === 'invalid_config' && updateRejected) {
    // Retrying the same configuration cannot succeed.
    failSession(
      session,
      `session.update rejected (${message}); check that this endpoint supports ` +
      `audio.input_mode=${CONFIG.inputMode}`
    );
    return;
  }

  if (code === 'concurrent_sources') {
    console.error(
      `${LOG} ${tag} overlapping participant audio needs per-participant lanes; ` +
      'use SCRIBE_INPUT_MODE=multitrack'
    );
  }
}

// Gracefully end a meeting's live session (called on meeting.rtms_stopped).
export async function cleanupMeeting(meetingUuid) {
  const session = sessions.get(meetingUuid);
  if (!session) return;

  console.log(
    `${LOG} Cleaning up meeting ${meetingUuid} (chunks=${session.chunks}, sentBytes=${session.sentBytes}, ` +
    `participants=${session.participants.size}, lanesSeen=${[...session.lanesSeen].join(',') || '-'})`
  );
  session.stopRequested = true;
  stopLiveness(session);
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;

  if (session.ws?.readyState === WebSocket.OPEN) {
    // Ask the server to finalize: every lane flushes its open utterance first.
    try { session.ws.send(JSON.stringify({ type: 'session.close' })); } catch { /* ignore */ }
    await waitForClose(session, FINALIZE_WAIT_MS);
    try {
      if (session.ws.readyState === WebSocket.OPEN) session.ws.close(1000, 'meeting stopped');
    } catch { /* ignore */ }
  } else if (session.ws) {
    try { session.ws.terminate(); } catch { /* ignore */ }
  }

  if (session.completed.length > 0) {
    const document = buildDiarizedTranscript(meetingUuid, session.completed);
    console.log(JSON.stringify(document, null, 2));
    if (CONFIG.saveDiarizedTranscript) {
      try {
        const filePath = await writeDiarizedTranscript(CONFIG.transcriptOutputDir, document);
        console.log(`${LOG} Saved diarized transcript to ${filePath}`);
      } catch (error) {
        console.error(`${LOG} Failed to save diarized transcript: ${error.message}`);
      }
    }
  }
  sessions.delete(meetingUuid);
}

function waitForClose(session, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    session.closedWaiters.push(finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// Close every active session (called on process shutdown).
export async function closeLiveScribe(meetingUuid = null) {
  if (meetingUuid) {
    await cleanupMeeting(meetingUuid);
    return;
  }
  await Promise.allSettled([...sessions.keys()].map((uuid) => cleanupMeeting(uuid)));
}
