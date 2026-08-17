import WebSocket from 'ws';
import dotenv from 'dotenv';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { KJUR } from 'jsrsasign';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const LOG = '[ZoomScribePool]';
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
const INITIAL_POOL_SIZE = 2;
const FINALIZE_WAIT_MS = 3000;
const MAX_SPANS_PER_SLOT = 10000;

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
  wordTimeOffsets: envBoolean('SCRIBE_WORD_TIME_OFFSETS', true),
  channelSeparation: envBoolean('SCRIBE_CHANNEL_SEPARATION', false),
  diarization: envBoolean('SCRIBE_DIARIZATION', false),
  profanityFilter: envBoolean('SCRIBE_PROFANITY_FILTER', false),
  outputFormat: process.env.SCRIBE_OUTPUT_FORMAT || 'json',
  poolSize: Math.floor(envPositiveNumber('SCRIBE_POOL_SIZE', 3)),
  pendingAudioMaxBytes: envPositiveNumber(
    'SCRIBE_PENDING_AUDIO_MAX_BYTES',
    BYTES_PER_SECOND * 5
  ),
  heartbeatIdleMs: envPositiveNumber('SCRIBE_HEARTBEAT_IDLE_MS', 10000),
  heartbeatAudioMs: envPositiveNumber('SCRIBE_HEARTBEAT_AUDIO_MS', 1000),
  reconnectDelayMs: envPositiveNumber('SCRIBE_RECONNECT_DELAY_MS', 2000),
  saveDiarizedTranscript: envBoolean('SCRIBE_SAVE_DIARIZED_TRANSCRIPT', false),
  transcriptOutputDir: path.resolve(
    __dirname,
    process.env.SCRIBE_TRANSCRIPT_OUTPUT_DIR || 'diarized_transcripts'
  ),
};

if (CONFIG.poolSize < INITIAL_POOL_SIZE || CONFIG.poolSize > 3) {
  throw new Error('SCRIBE_POOL_SIZE must be 2 or 3');
}

export function buildSessionUpdatePayload() {
  return {
    type: 'session.update',
    audio: { format: 'pcm16' },
    config: {
      language: CONFIG.language,
      word_time_offsets: CONFIG.wordTimeOffsets,
      channel_separation: CONFIG.channelSeparation,
      diarization: CONFIG.diarization,
      profanity_filter: CONFIG.profanityFilter,
      output_format: CONFIG.outputFormat,
    },
  };
}

const pools = new Map();
let webSocketFactory = (url, protocols) => new WebSocket(url, protocols);

export function setWebSocketFactoryForTesting(factory = null) {
  webSocketFactory = factory || ((url, protocols) => new WebSocket(url, protocols));
}

export function liveScribeConfig() {
  return {
    liveUrl: CONFIG.liveUrl,
    language: CONFIG.language,
    wordTimeOffsets: CONFIG.wordTimeOffsets,
    channelSeparation: CONFIG.channelSeparation,
    diarization: CONFIG.diarization,
    profanityFilter: CONFIG.profanityFilter,
    outputFormat: CONFIG.outputFormat,
    poolSize: CONFIG.poolSize,
    initialPoolSize: INITIAL_POOL_SIZE,
    pendingAudioMaxBytes: CONFIG.pendingAudioMaxBytes,
    heartbeatIdleMs: CONFIG.heartbeatIdleMs,
    heartbeatAudioMs: CONFIG.heartbeatAudioMs,
    reconnectDelayMs: CONFIG.reconnectDelayMs,
    saveDiarizedTranscript: CONFIG.saveDiarizedTranscript,
    transcriptOutputDir: CONFIG.transcriptOutputDir,
  };
}

export function activeSessionCount() {
  return [...pools.values()].reduce((count, pool) => count + pool.slots.length, 0);
}

export function getPoolSnapshot(meetingUuid) {
  const pool = pools.get(meetingUuid);
  if (!pool) return null;
  return {
    meetingUuid,
    configuredPoolSize: CONFIG.poolSize,
    connectedSlots: pool.slots.length,
    waitingParticipants: 0,
    excludedParticipants: pool.excludedParticipants.size,
    slots: pool.slots.map((slot) => ({
      slotId: slot.slotId,
      state: slot.state,
      ready: slot.ready,
      userId: slot.activeLease?.userId ?? null,
      userName: slot.activeLease?.userName ?? null,
      leaseId: slot.activeLease?.leaseId ?? null,
      pendingBytes: slot.pendingBytes,
    })),
  };
}

export function initializeLiveScribeSession(meetingUuid) {
  if (!meetingUuid || pools.has(meetingUuid)) return;
  const pool = {
    meetingUuid,
    stopping: false,
    participants: new Map(),
    participantSlots: new Map(),
    excludedParticipants: new Set(),
    completed: [],
    slots: [],
  };

  for (let index = 0; index < INITIAL_POOL_SIZE; index += 1) {
    const slot = createSlot(pool, index + 1);
    pool.slots.push(slot);
    connectSlot(pool, slot);
  }

  pools.set(meetingUuid, pool);
  console.log(
    `${LOG} Created ${pool.slots.length} sockets for meeting ${meetingUuid} ` +
    `(configured capacity=${CONFIG.poolSize})`
  );
}

function createSlot(pool, number) {
  return {
    slotId: `scribe-${number}`,
    meetingUuid: pool.meetingUuid,
    ws: null,
    ready: false,
    stopRequested: false,
    state: 'free',
    activeLease: null,
    leaseSequence: 0,
    pendingAudio: [],
    pendingBytes: 0,
    audioCursorMs: 0,
    spans: [],
    sessionId: null,
    reconnectTimer: null,
    heartbeatTimer: null,
    lastAudioSentAt: 0,
    connectedAt: 0,
    heartbeatCount: 0,
    closedWaiters: [],
    sentBytes: 0,
    chunks: 0,
    connectionGeneration: 0,
  };
}

function participantKey(userId) {
  return String(userId ?? 'unknown');
}

function getParticipant(pool, userId, userName) {
  const key = participantKey(userId);
  let participant = pool.participants.get(key);
  if (!participant) {
    participant = {
      key,
      userId: userId ?? 'unknown',
      userName: userName || 'Unknown participant',
      excluded: false,
    };
    pool.participants.set(key, participant);
  } else if (userName) {
    participant.userName = userName;
  }
  return participant;
}

// Permanently route a participant to one Scribe socket for the meeting.
export function sendAudioChunk(buffer, meetingUuid, participantInfo = {}) {
  if (!buffer?.length) return;
  const pool = pools.get(meetingUuid);
  if (!pool || pool.stopping) return;

  const info = typeof participantInfo === 'object'
    ? participantInfo
    : { userId: participantInfo };
  const participant = getParticipant(pool, info.userId, info.userName);
  if (participant.excluded) return;
  const receivedAt = Date.now();
  const item = {
    buffer,
    timestamp: info.timestamp ?? receivedAt,
    receivedAt,
  };

  const assignedSlotId = pool.participantSlots.get(participant.key);
  let slot = assignedSlotId
    ? pool.slots.find((candidate) => candidate.slotId === assignedSlotId)
    : null;

  if (!slot) {
    slot = pool.slots.find((candidate) => candidate.state === 'free');
    if (!slot && pool.slots.length < CONFIG.poolSize) {
      slot = createSlot(pool, pool.slots.length + 1);
      pool.slots.push(slot);
      assignSlot(pool, slot, participant);
      connectSlot(pool, slot);
    } else if (slot) {
      assignSlot(pool, slot, participant);
    }
  }

  if (!slot) return excludeParticipant(pool, participant);

  slot.activeLease.userName = participant.userName;
  sendOrQueueSlotAudio(slot, item, slot.activeLease);
}

function assignSlot(pool, slot, participant) {
  slot.state = 'assigned';
  slot.leaseSequence += 1;
  slot.activeLease = {
    leaseId: `${slot.slotId}-lease-${slot.leaseSequence}`,
    participantKey: participant.key,
    userId: participant.userId,
    userName: participant.userName,
    acquiredAt: Date.now(),
  };
  pool.participantSlots.set(participant.key, slot.slotId);
}

function excludeParticipant(pool, participant) {
  participant.excluded = true;
  pool.excludedParticipants.add(participant.key);
  console.log(
    `${LOG} No Scribe capacity for ${participant.userName} (${participant.userId}); ` +
    `audio will not be transcribed`
  );
}

function sendOrQueueSlotAudio(slot, item, lease) {
  if (slot.ready && slot.ws?.readyState === WebSocket.OPEN) {
    try {
      transmitSlotAudio(slot, item, lease);
      return;
    } catch (error) {
      console.error(`${LOG} [${slot.slotId}] send failed, queueing: ${error.message}`);
    }
  }

  slot.pendingAudio.push({ ...item, buffer: Buffer.from(item.buffer), lease });
  slot.pendingBytes += item.buffer.length;
  while (slot.pendingBytes > CONFIG.pendingAudioMaxBytes && slot.pendingAudio.length > 0) {
    const dropped = slot.pendingAudio.shift();
    slot.pendingBytes -= dropped.buffer.length;
  }
}

function transmitSlotAudio(slot, item, lease) {
  slot.ws.send(item.buffer);
  slot.lastAudioSentAt = Date.now();
  scheduleHeartbeat(slot);
  const startMs = slot.audioCursorMs;
  const durationMs = item.buffer.length / BYTES_PER_SECOND * 1000;
  const endMs = startMs + durationMs;
  slot.audioCursorMs = endMs;
  slot.sentBytes += item.buffer.length;
  slot.chunks += 1;

  if (lease) {
    slot.spans.push({
      startMs,
      endMs,
      leaseId: lease.leaseId,
      userId: lease.userId,
      userName: lease.userName,
      rtmsTimestamp: item.timestamp,
      receivedAt: item.receivedAt,
    });
    if (slot.spans.length > MAX_SPANS_PER_SLOT) slot.spans.shift();
  }
}

function scheduleHeartbeat(slot) {
  if (
    slot.heartbeatTimer ||
    !slot.ready ||
    slot.stopRequested ||
    slot.ws?.readyState !== WebSocket.OPEN
  ) return;

  const idleMs = Date.now() - slot.lastAudioSentAt;
  const delayMs = Math.max(CONFIG.heartbeatIdleMs - idleMs, 1);
  slot.heartbeatTimer = setTimeout(() => {
    slot.heartbeatTimer = null;
    if (
      !slot.ready ||
      slot.stopRequested ||
      slot.ws?.readyState !== WebSocket.OPEN
    ) return;

    const currentIdleMs = Date.now() - slot.lastAudioSentAt;
    if (currentIdleMs >= CONFIG.heartbeatIdleMs) {
      const silence = Buffer.alloc(
        Math.round(BYTES_PER_SECOND * CONFIG.heartbeatAudioMs / 1000)
      );
      if (typeof slot.ws.ping === 'function') {
        try {
          slot.ws.ping();
        } catch (error) {
          console.warn(`${LOG} [${slot.slotId}] WebSocket ping failed: ${error.message}`);
        }
      }
      try {
        transmitSlotAudio(
          slot,
          { buffer: silence, timestamp: null, receivedAt: Date.now() },
          null
        );
        slot.heartbeatCount += 1;
      } catch (error) {
        console.error(`${LOG} [${slot.slotId}] heartbeat failed: ${error.message}`);
      }
    }
    scheduleHeartbeat(slot);
  }, delayMs);
}

function flushSlotQueue(slot) {
  while (slot.ready && slot.ws?.readyState === WebSocket.OPEN && slot.pendingAudio.length > 0) {
    const item = slot.pendingAudio.shift();
    slot.pendingBytes -= item.buffer.length;
    try {
      transmitSlotAudio(slot, item, item.lease);
    } catch (error) {
      slot.pendingAudio.unshift(item);
      slot.pendingBytes += item.buffer.length;
      console.error(`${LOG} [${slot.slotId}] queue flush failed: ${error.message}`);
      break;
    }
  }
}

export function resolveTranscriptAttribution(spans, startMs, endMs) {
  const normalizedStart = Number(startMs);
  const normalizedEnd = Number(endMs);
  if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd)) return null;

  let best = null;
  let bestOverlap = 0;
  for (const span of spans) {
    const overlap = Math.max(0, Math.min(normalizedEnd, span.endMs) - Math.max(normalizedStart, span.startMs));
    if (overlap > bestOverlap) {
      best = span;
      bestOverlap = overlap;
    }
  }
  return best ? { ...best, overlapMs: bestOverlap } : null;
}

function normalizeEpochMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (Math.abs(number) >= 1e17) return number / 1e6;
  if (Math.abs(number) >= 1e14) return number / 1e3;
  if (Math.abs(number) >= 1e11) return number;
  return null;
}

export function calculateTranscriptEpochMs(attribution, transcriptStartMs) {
  if (!attribution) return null;
  const rtmsBaseMs = normalizeEpochMs(attribution.rtmsTimestamp);
  if (rtmsBaseMs == null) return null;
  return rtmsBaseMs + Math.max(0, transcriptStartMs - attribution.startMs);
}

// Normalize the speaker_segments array Scribe returns when its acoustic
// diarization detects multiple speakers inside a single utterance. Each segment
// carries its own speaker label, transcript, and session-relative timing. Returns
// [] when the field is absent (single acoustic speaker, or diarization disabled).
export function extractSpeakerSegments(event) {
  const nested = event.result && typeof event.result === 'object' ? event.result : {};
  const raw = event.speaker_segments ?? nested.speaker_segments;
  if (!Array.isArray(raw)) return [];
  return raw.map((seg) => {
    const startMs = Number(seg.audio_start_ms ?? 0);
    return {
      speaker: seg.speaker ?? seg.speaker_label ?? seg.speaker_id ?? 'unknown',
      transcript: seg.transcript ?? seg.text ?? seg.text_display ?? '',
      startMs,
      endMs: Number(seg.audio_end_ms ?? seg.audio_start_ms ?? startMs),
    };
  });
}

export function formatNamedUtterance(meetingUuid, result) {
  const utterance = {
    event: 'transcript.utterance',
    source_event: 'transcription.completed',
    meeting_uuid: meetingUuid,
    participant: {
      user_id: result.userId,
      user_name: result.userName,
    },
    start_time: result.startTimeEpochMs,
    end_time: result.endTimeEpochMs,
    received_time: result.receivedAt,
    text: result.text,
  };
  // Participant identity (from RTMS) stays primary. When Scribe additionally
  // returns acoustic speaker_segments for the utterance, attach them as a
  // supplementary breakdown on the same epoch-millisecond timescale.
  if (Array.isArray(result.speakerSegments) && result.speakerSegments.length > 0) {
    utterance.speaker_segments = result.speakerSegments.map((seg) => ({
      speaker: seg.speaker,
      text: seg.text,
      start_time: seg.startTimeEpochMs,
      end_time: seg.endTimeEpochMs,
    }));
  }
  return utterance;
}

export function buildDiarizedTranscript(meetingUuid, transcript, generatedAt = Date.now()) {
  return {
    schema_version: 1,
    event: 'transcript.final',
    meeting_uuid: meetingUuid,
    generated_time: generatedAt,
    utterances: transcript.map((item) => {
      const { event, source_event, meeting_uuid, ...utterance } =
        formatNamedUtterance(meetingUuid, item);
      return utterance;
    }),
  };
}

export async function writeDiarizedTranscript(
  outputDir,
  meetingUuid,
  transcript,
  generatedAt = Date.now()
) {
  const document = buildDiarizedTranscript(meetingUuid, transcript, generatedAt);
  const safeMeetingUuid = String(meetingUuid || 'meeting')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 100) || 'meeting';
  const timestamp = new Date(generatedAt).toISOString().replace(/[:.]/g, '-');
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

function connectSlot(pool, slot) {
  if (pool.stopping || slot.stopRequested) return;
  if (slot.heartbeatTimer) {
    clearTimeout(slot.heartbeatTimer);
    slot.heartbeatTimer = null;
  }
  let jwt;
  try {
    jwt = generateScribeJwt(CONFIG.apiKey, CONFIG.apiSecret);
  } catch (error) {
    console.error(`${LOG} [${slot.slotId}] cannot mint JWT: ${error.message}`);
    return;
  }

  slot.connectionGeneration += 1;
  if (slot.connectionGeneration > 1) {
    slot.audioCursorMs = 0;
    slot.spans = [];
  }

  console.log(`${LOG} [${slot.slotId}] connecting to ${CONFIG.liveUrl}`);
  const ws = webSocketFactory(CONFIG.liveUrl, ['live-asr', `zoom-api-access-token.${jwt}`]);
  slot.ws = ws;
  slot.ready = false;

  ws.on('open', () => {
    if (slot.ws !== ws) return;
    slot.connectedAt = Date.now();
    slot.heartbeatCount = 0;
    ws.send(JSON.stringify(buildSessionUpdatePayload()));
    console.log(`${LOG} [${slot.slotId}] connected; session.update sent`);
  });

  ws.on('message', (data, isBinary) => {
    if (slot.ws === ws && !isBinary) handleServerEvent(pool, slot, data);
  });

  ws.on('error', (error) => {
    console.error(`${LOG} [${slot.slotId}] WebSocket error: ${error.message}`);
  });

  ws.on('close', (code, reason) => {
    if (slot.ws !== ws) return;
    if (slot.heartbeatTimer) {
      clearTimeout(slot.heartbeatTimer);
      slot.heartbeatTimer = null;
    }
    slot.ready = false;
    slot.closedWaiters.splice(0).forEach((resolve) => resolve());
    console.log(
      `${LOG} [${slot.slotId}] closed: ${code} ${reason?.toString() || ''} ` +
      `connectedForMs=${slot.connectedAt ? Date.now() - slot.connectedAt : 'unknown'} ` +
      `audioIdleMs=${slot.lastAudioSentAt ? Date.now() - slot.lastAudioSentAt : 'unknown'} ` +
      `heartbeats=${slot.heartbeatCount}`
    );
    if (!pool.stopping && !slot.stopRequested) {
      slot.reconnectTimer = setTimeout(() => {
        slot.reconnectTimer = null;
        connectSlot(pool, slot);
      }, CONFIG.reconnectDelayMs);
    }
  });
}

function handleServerEvent(pool, slot, raw) {
  let event;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (event.type) {
    case 'session.created':
      slot.sessionId = event.session_id || null;
      console.log(`${LOG} [${slot.slotId}] session.created id=${slot.sessionId}`);
      break;
    case 'session.updated':
      slot.ready = true;
      slot.lastAudioSentAt = Date.now();
      console.log(`${LOG} [${slot.slotId}] session.updated; ready`);
      flushSlotQueue(slot);
      scheduleHeartbeat(slot);
      break;
    case 'transcription.completed': {
      const startMs = Number(event.audio_start_ms ?? 0);
      const endMs = Number(event.audio_end_ms ?? startMs);
      const attribution = resolveTranscriptAttribution(slot.spans, startMs, endMs);
      const text = event.transcript || '';
      const startTimeEpochMs = calculateTranscriptEpochMs(attribution, startMs);
      const endTimeEpochMs = calculateTranscriptEpochMs(attribution, endMs);
      // Convert Scribe's acoustic speaker_segments to the same epoch timescale so
      // consumers get both the RTMS participant and the per-speaker breakdown.
      const speakerSegments = extractSpeakerSegments(event).map((seg) => ({
        speaker: seg.speaker,
        text: seg.transcript,
        startMs: seg.startMs,
        endMs: seg.endMs,
        startTimeEpochMs: calculateTranscriptEpochMs(attribution, seg.startMs),
        endTimeEpochMs: calculateTranscriptEpochMs(attribution, seg.endMs),
      }));
      const receivedAt = Date.now();
      const result = {
        slotId: slot.slotId,
        leaseId: attribution?.leaseId ?? null,
        userId: attribution?.userId ?? null,
        userName: attribution?.userName ?? 'Unknown participant',
        startMs,
        endMs,
        startTimeEpochMs,
        endTimeEpochMs,
        epochTimestampMs: startTimeEpochMs,
        meetingTimestampMs: startTimeEpochMs,
        receivedAt,
        text,
        speakerSegments,
      };
      if (text) {
        pool.completed.push(result);
        console.log(JSON.stringify(formatNamedUtterance(pool.meetingUuid, result), null, 2));
      }
      break;
    }
    case 'error':
      console.error(
        `${LOG} [${slot.slotId}] server error code=${event.error?.code} ` +
        `msg=${event.error?.message} fatal=${event.error?.fatal}`
      );
      break;
    case 'session.closed':
      console.log(`${LOG} [${slot.slotId}] session.closed reason=${event.reason}`);
      slot.closedWaiters.splice(0).forEach((resolve) => resolve());
      break;
    default:
      break;
  }
}

export async function cleanupMeeting(meetingUuid) {
  const pool = pools.get(meetingUuid);
  if (!pool) return;
  pool.stopping = true;
  await Promise.allSettled(pool.slots.map((slot) => closeSlot(slot)));

  const transcript = [...pool.completed].sort((left, right) =>
    (left.meetingTimestampMs ?? left.receivedAt) - (right.meetingTimestampMs ?? right.receivedAt)
  );
  if (transcript.length > 0) {
    const document = buildDiarizedTranscript(meetingUuid, transcript);
    console.log(JSON.stringify(document, null, 2));
    if (CONFIG.saveDiarizedTranscript) {
      try {
        const filePath = await writeDiarizedTranscript(
          CONFIG.transcriptOutputDir,
          meetingUuid,
          transcript,
          document.generated_time
        );
        console.log(`${LOG} Saved diarized transcript to ${filePath}`);
      } catch (error) {
        console.error(`${LOG} Failed to save diarized transcript: ${error.message}`);
      }
    }
  }
  pools.delete(meetingUuid);
}

async function closeSlot(slot) {
  slot.stopRequested = true;
  if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
  if (slot.heartbeatTimer) clearTimeout(slot.heartbeatTimer);
  if (slot.ws?.readyState === WebSocket.OPEN) {
    try { slot.ws.send(JSON.stringify({ type: 'session.close' })); } catch { /* ignore */ }
    await waitForClose(slot, FINALIZE_WAIT_MS);
    try {
      if (slot.ws.readyState === WebSocket.OPEN) slot.ws.close(1000, 'meeting stopped');
    } catch { /* ignore */ }
  } else if (slot.ws) {
    try { slot.ws.terminate(); } catch { /* ignore */ }
  }
}

function waitForClose(slot, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    slot.closedWaiters.push(finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

export async function closeLiveScribe(meetingUuid = null) {
  if (meetingUuid) {
    await cleanupMeeting(meetingUuid);
    return;
  }
  await Promise.allSettled([...pools.keys()].map((uuid) => cleanupMeeting(uuid)));
}
