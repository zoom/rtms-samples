import WebSocket from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { KJUR } from 'jsrsasign';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env here too: ES module imports are evaluated before the importer's
// body runs, so CONFIG below must see env vars regardless of import order.
dotenv.config({ path: path.join(__dirname, '.env') });

const LOG = '[ZoomScribeLive]';

// Reconnect backoff, the pre-connect audio backlog cap, and how long to wait for
// the final transcript after asking the server to close.
const RECONNECT_DELAY_MS = 2000;
const MAX_QUEUED_AUDIO_BYTES = 5 * 1024 * 1024;
const FINALIZE_WAIT_MS = 3000;

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

// Full WebSocket URL of the live transcription endpoint.
const DEFAULT_LIVE_URL = 'wss://api.zoom.us/v2/aiservices/scribe/live';

const CONFIG = {
  apiKey: process.env.ZOOM_API_KEY,
  apiSecret: process.env.ZOOM_API_SECRET,
  liveUrl: process.env.SCRIBE_LIVE_URL || DEFAULT_LIVE_URL,
  language: process.env.SCRIBE_LANGUAGE || 'en-US',
  wordTimeOffsets: envBoolean('SCRIBE_WORD_TIME_OFFSETS', true),
  channelSeparation: envBoolean('SCRIBE_CHANNEL_SEPARATION', false),
  diarization: envBoolean('SCRIBE_DIARIZATION', false),
  logRawEvents: envBoolean('SCRIBE_LOG_RAW_EVENTS', false),
  profanityFilter: envBoolean('SCRIBE_PROFANITY_FILTER', false),
  outputFormat: process.env.SCRIBE_OUTPUT_FORMAT || 'json',
};

export function buildSessionUpdatePayload() {
  return {
    type: 'session.update',
    language: CONFIG.language,
    audio: { format: 'pcm16' },
    transcription: {
      enable_diarization: CONFIG.diarization,
    },
  };
}

// meetingUuid -> session
const sessions = new Map();

export function liveScribeConfig() {
  return {
    liveUrl: CONFIG.liveUrl,
    language: CONFIG.language,
    wordTimeOffsets: CONFIG.wordTimeOffsets,
    channelSeparation: CONFIG.channelSeparation,
    diarization: CONFIG.diarization,
    logRawEvents: CONFIG.logRawEvents,
    profanityFilter: CONFIG.profanityFilter,
    outputFormat: CONFIG.outputFormat,
  };
}

export function activeSessionCount() {
  return sessions.size;
}

// Open a live transcription WebSocket for a meeting (called on meeting.rtms_started).
export function initializeLiveScribeSession(meetingUuid) {
  if (!meetingUuid || sessions.has(meetingUuid)) return;
  const session = {
    meetingUuid,
    ws: null,
    ready: false,
    stopRequested: false,
    queued: [],
    queuedBytes: 0,
    sentBytes: 0,
    sourceBytes: 0,
    chunks: 0,
    startedAt: Date.now(),
    reconnectTimer: null,
    sessionId: null,
    completed: [],
    closedWaiters: [],
  };
  sessions.set(meetingUuid, session);
  console.log(`${LOG} Initializing live session for meeting ${meetingUuid}`);
  connect(session);
}

// Stream one RTMS audio buffer (16 kHz mono PCM16 LE) as a binary WS frame.
export function sendAudioChunk(buffer, meetingUuid, userId = 0) {
  if (!buffer || buffer.length === 0) return;
  const session = sessions.get(meetingUuid);
  if (!session || session.stopRequested) return;

  session.chunks += 1;
  session.sourceBytes += buffer.length;

  if (session.ready && session.ws && session.ws.readyState === WebSocket.OPEN) {
    try {
      session.ws.send(buffer);
      session.sentBytes += buffer.length;
    } catch (error) {
      console.error(`${LOG} send failed, queuing: ${error.message}`);
      queueAudio(session, buffer);
    }
  } else {
    // Not connected/ready yet (handshake + session.update in flight): buffer it.
    queueAudio(session, buffer);
  }

  if (session.chunks % 200 === 0) {
    const elapsed = ((Date.now() - session.startedAt) / 1000).toFixed(1);
    console.log(
      `${LOG} [${String(meetingUuid).slice(0, 8)}] chunks=${session.chunks} rtmsBytes=${session.sourceBytes} ` +
      `sentBytes=${session.sentBytes} queuedBytes=${session.queuedBytes} elapsed=${elapsed}s lastUser=${userId}`
    );
  }
}

function queueAudio(session, buffer) {
  session.queued.push(buffer);
  session.queuedBytes += buffer.length;
  // Bound the pre-connect backlog: drop oldest audio if we exceed the cap.
  while (session.queuedBytes > MAX_QUEUED_AUDIO_BYTES && session.queued.length > 0) {
    session.queuedBytes -= session.queued.shift().length;
  }
}

function flushQueue(session) {
  while (
    session.ready &&
    session.ws &&
    session.ws.readyState === WebSocket.OPEN &&
    session.queued.length > 0
  ) {
    const buf = session.queued.shift();
    session.queuedBytes -= buf.length;
    try {
      session.ws.send(buf);
      session.sentBytes += buf.length;
    } catch (error) {
      console.error(`${LOG} flush failed: ${error.message}`);
      session.queued.unshift(buf);
      session.queuedBytes += buf.length;
      break;
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
  const ws = new WebSocket(CONFIG.liveUrl, ['live-asr', `zoom-api-access-token.${jwt}`]);
  session.ws = ws;
  session.ready = false;

  ws.on('open', () => {
    console.log(`${LOG} Connected for meeting ${session.meetingUuid}`);
    try {
      const payload = buildSessionUpdatePayload();
      ws.send(JSON.stringify(payload));
      console.log(`${LOG} Sent session.update ${JSON.stringify(payload)}`);
    } catch (error) {
      console.error(`${LOG} session.update send failed: ${error.message}`);
    }
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) handleServerEvent(session, data);
  });

  ws.on('error', (error) => {
    console.error(`${LOG} WebSocket error for meeting ${session.meetingUuid}: ${error.message}`);
  });

  ws.on('close', (code, reason) => {
    session.ready = false;
    console.log(`${LOG} Closed for meeting ${session.meetingUuid}: ${code} ${reason?.toString() || ''}`);
    session.closedWaiters.splice(0).forEach((resolve) => resolve());
    // Reconnect only on abnormal closes while the meeting is still active.
    if (!session.stopRequested && code !== 1000) {
      session.reconnectTimer = setTimeout(() => connect(session), RECONNECT_DELAY_MS);
    }
  });
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

  switch (event.type) {
    case 'session.created':
      session.sessionId = event.session_id || null;
      console.log(`${LOG} ${tag} session.created id=${session.sessionId}`);
      break;
    case 'session.updated':
      session.ready = true;
      console.log(
        `${LOG} ${tag} session.updated; streaming audio response=${JSON.stringify(event)}`
      );
      flushQueue(session);
      break;
    case 'transcription.completed': {
      const text = event.transcript || '';
      const speakerSegments = extractSpeakerSegments(event);
      const startSec = ((event.audio_start_ms ?? 0) / 1000).toFixed(1);
      const endSec = ((event.audio_end_ms ?? 0) / 1000).toFixed(1);

      if (CONFIG.diarization) {
        // Accumulate the final transcript with speaker labels. When several
        // speakers share one utterance, Scribe returns speaker_segments; otherwise
        // the whole utterance carries a single top-level speaker label.
        if (speakerSegments.length > 0) {
          for (const seg of speakerSegments) {
            if (seg.transcript) session.completed.push(`${seg.speaker}: ${seg.transcript}`);
          }
        } else if (text) {
          session.completed.push(`${topLevelSpeaker(event) || 'unknown'}: ${text}`);
        }

        console.log(
          `${LOG} ${tag} diarized transcription:\n${JSON.stringify(
            buildDiarizationLog(event, speakerSegments),
            null,
            2
          )}`
        );

        // Human-readable speaker breakdown, mirroring the multi-speaker case.
        if (speakerSegments.length > 0) {
          console.log(`${LOG} ${tag} multi-speaker utterance (${speakerSegments.length} segments):`);
          for (const seg of speakerSegments) {
            const s = ((seg.audio_start_ms ?? 0) / 1000).toFixed(1);
            const e = ((seg.audio_end_ms ?? 0) / 1000).toFixed(1);
            console.log(`${LOG} ${tag}   [${s}s-${e}s] ${seg.speaker}: ${seg.transcript}`);
          }
        } else {
          console.log(`${LOG} ${tag} [${startSec}s-${endSec}s] ${topLevelSpeaker(event) || 'unknown'}: ${text}`);
        }
      } else {
        if (text) session.completed.push(text);
        console.log(`${LOG} ${tag} [${startSec}s-${endSec}s] ${text}`);
      }
      break;
    }
    case 'error':
      console.error(
        `${LOG} ${tag} server error code=${event.error?.code} ` +
        `msg=${event.error?.message} fatal=${event.error?.fatal}`
      );
      break;
    case 'session.closed':
      console.log(`${LOG} ${tag} session.closed reason=${event.reason}`);
      session.closedWaiters.splice(0).forEach((resolve) => resolve());
      break;
    default:
      if (CONFIG.diarization) {
        console.log(
          `${LOG} ${tag} unhandled Live Scribe event:\n${JSON.stringify(event, null, 2)}`
        );
      }
      break;
  }
}

// Top-level speaker label for a single-speaker utterance (Scribe has used a few
// different field names for this across versions).
function topLevelSpeaker(event) {
  return event.speaker ?? event.speaker_label ?? event.speaker_id ?? null;
}

// Normalize the speaker_segments array Scribe returns when multiple speakers
// share a single utterance. Each segment carries its own speaker label,
// transcript, and timing. Returns [] when the field is absent (single speaker).
function extractSpeakerSegments(event) {
  const result = event.result && typeof event.result === 'object' ? event.result : {};
  const raw = event.speaker_segments ?? result.speaker_segments;
  if (!Array.isArray(raw)) return [];
  return raw.map((seg) => ({
    speaker: seg.speaker ?? seg.speaker_label ?? seg.speaker_id ?? 'unknown',
    transcript: seg.transcript ?? seg.text ?? seg.text_display ?? '',
    audio_start_ms: seg.audio_start_ms ?? null,
    audio_end_ms: seg.audio_end_ms ?? null,
  }));
}

function buildDiarizationLog(event, speakerSegments = extractSpeakerSegments(event)) {
  const result = event.result && typeof event.result === 'object' ? event.result : {};

  return {
    transcript: event.transcript || result.text_display || '',
    audio_start_ms: event.audio_start_ms ?? null,
    audio_end_ms: event.audio_end_ms ?? null,
    transcription_latency_ms: event.transcription_latency_ms ?? null,
    speaker: topLevelSpeaker(event),
    speaker_segments: speakerSegments.length > 0 ? speakerSegments : null,
    speakers: event.speakers ?? result.speakers ?? null,
    segments: event.segments ?? result.segments ?? null,
    words: event.words ?? result.words ?? null,
    response_fields: Object.keys(event),
  };
}

// Gracefully end a meeting's live session (called on meeting.rtms_stopped).
export async function cleanupMeeting(meetingUuid) {
  const session = sessions.get(meetingUuid);
  if (!session) return;

  console.log(
    `${LOG} Cleaning up meeting ${meetingUuid} (chunks=${session.chunks}, sentBytes=${session.sentBytes})`
  );
  session.stopRequested = true;
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    // Ask the server to finalize; the final utterance is transcribed on close.
    try { session.ws.send(JSON.stringify({ type: 'session.close' })); } catch { /* ignore */ }
    await waitForClose(session, FINALIZE_WAIT_MS);
    try {
      if (session.ws.readyState === WebSocket.OPEN) session.ws.close(1000, 'meeting stopped');
    } catch { /* ignore */ }
  } else if (session.ws) {
    try { session.ws.terminate(); } catch { /* ignore */ }
  }

  if (session.completed.length > 0) {
    console.log(`${LOG} Final transcript for meeting ${meetingUuid}:\n${session.completed.join(' ')}`);
  }
  sessions.delete(meetingUuid);
}

function waitForClose(session, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    session.closedWaiters.push(finish);
    setTimeout(finish, timeoutMs);
  });
}

// Close every active session (called on process shutdown).
export async function closeLiveScribe(meetingUuid = null) {
  if (meetingUuid) {
    await cleanupMeeting(meetingUuid);
    return;
  }
  for (const uuid of [...sessions.keys()]) {
    await cleanupMeeting(uuid);
  }
}
