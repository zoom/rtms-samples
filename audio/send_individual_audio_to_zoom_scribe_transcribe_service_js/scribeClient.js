import WebSocket from 'ws';
import dotenv from 'dotenv';
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
const FINALIZE_WAIT_MS = 3000;
const DRAIN_POLL_MS = 250;
const WATERMARK_TOLERANCE_MS = 100;
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
  releasePauseMs: envPositiveNumber('SCRIBE_RELEASE_PAUSE_MS', 1500),
  drainTimeoutMs: envPositiveNumber('SCRIBE_DRAIN_TIMEOUT_MS', 4000),
  switchSilenceMs: envPositiveNumber('SCRIBE_SWITCH_SILENCE_MS', 400),
  participantQueueMaxBytes: envPositiveNumber(
    'SCRIBE_PARTICIPANT_QUEUE_MAX_BYTES',
    BYTES_PER_SECOND * 5
  ),
  silenceRmsThreshold: envPositiveNumber('SCRIBE_SILENCE_RMS_THRESHOLD', 250),
  heartbeatIdleMs: envPositiveNumber('SCRIBE_HEARTBEAT_IDLE_MS', 10000),
  heartbeatAudioMs: envPositiveNumber('SCRIBE_HEARTBEAT_AUDIO_MS', 1000),
  reconnectDelayMs: envPositiveNumber('SCRIBE_RECONNECT_DELAY_MS', 2000),
};

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
    releasePauseMs: CONFIG.releasePauseMs,
    drainTimeoutMs: CONFIG.drainTimeoutMs,
    switchSilenceMs: CONFIG.switchSilenceMs,
    participantQueueMaxBytes: CONFIG.participantQueueMaxBytes,
    silenceRmsThreshold: CONFIG.silenceRmsThreshold,
    heartbeatIdleMs: CONFIG.heartbeatIdleMs,
    heartbeatAudioMs: CONFIG.heartbeatAudioMs,
    reconnectDelayMs: CONFIG.reconnectDelayMs,
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
    waitingParticipants: pool.waitingOrder.length,
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
    waitingOrder: [],
    completed: [],
    slots: [],
  };

  for (let index = 0; index < CONFIG.poolSize; index += 1) {
    const slot = createSlot(pool, index + 1);
    pool.slots.push(slot);
    connectSlot(pool, slot);
  }

  pools.set(meetingUuid, pool);
  console.log(`${LOG} Created ${pool.slots.length}-socket pool for meeting ${meetingUuid}`);
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
    transcribedAudioEndMs: 0,
    spans: [],
    sessionId: null,
    reconnectTimer: null,
    releaseTimer: null,
    heartbeatTimer: null,
    lastAudioSentAt: 0,
    connectedAt: 0,
    heartbeatCount: 0,
    drainStartedAt: null,
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
      queued: [],
      queuedBytes: 0,
      waiting: false,
      droppedBytes: 0,
      lastAudioAt: 0,
    };
    pool.participants.set(key, participant);
  } else if (userName) {
    participant.userName = userName;
  }
  return participant;
}

// Route one RTMS individual-audio packet to a sticky participant lease.
export function sendAudioChunk(buffer, meetingUuid, participantInfo = {}) {
  if (!buffer?.length) return;
  const pool = pools.get(meetingUuid);
  if (!pool || pool.stopping) return;

  const info = typeof participantInfo === 'object'
    ? participantInfo
    : { userId: participantInfo };
  const participant = getParticipant(pool, info.userId, info.userName);
  const containsSpeech = isSpeechAudio(buffer, CONFIG.silenceRmsThreshold);
  if (containsSpeech) participant.lastAudioAt = Date.now();
  const item = {
    buffer,
    timestamp: info.timestamp ?? Date.now(),
    receivedAt: Date.now(),
  };

  const assignedSlotId = pool.participantSlots.get(participant.key);
  let slot = assignedSlotId
    ? pool.slots.find((candidate) => candidate.slotId === assignedSlotId)
    : null;

  if (!slot) {
    if (!containsSpeech) return;
    slot = pool.slots.find((candidate) => candidate.state === 'free');
    if (slot) assignSlot(pool, slot, participant);
  }

  if (!slot) {
    queueParticipantAudio(pool, participant, item);
    return;
  }

  if (slot.state === 'draining') {
    if (!containsSpeech) return;
    slot.state = 'assigned';
    slot.drainStartedAt = null;
  }
  slot.activeLease.userName = participant.userName;
  sendOrQueueSlotAudio(slot, item, slot.activeLease);
  scheduleRelease(pool, slot, participant);
}

export function isSpeechAudio(buffer, threshold = CONFIG.silenceRmsThreshold) {
  if (!buffer?.length || buffer.length < 2) return false;
  let sumSquares = 0;
  const sampleCount = Math.floor(buffer.length / 2);
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount) >= threshold;
}

function assignSlot(pool, slot, participant) {
  slot.state = 'assigned';
  participant.lastAudioAt = Date.now();
  slot.leaseSequence += 1;
  slot.drainStartedAt = null;
  slot.activeLease = {
    leaseId: `${slot.slotId}-lease-${slot.leaseSequence}`,
    participantKey: participant.key,
    userId: participant.userId,
    userName: participant.userName,
    acquiredAt: Date.now(),
    sentAudioEndMs: slot.audioCursorMs,
  };
  pool.participantSlots.set(participant.key, slot.slotId);
  participant.waiting = false;

  if (slot.audioCursorMs > 0 && CONFIG.switchSilenceMs > 0) {
    const silence = Buffer.alloc(Math.round(BYTES_PER_SECOND * CONFIG.switchSilenceMs / 1000));
    sendOrQueueSlotAudio(slot, { buffer: silence, timestamp: null, receivedAt: Date.now() }, null);
  }

  while (participant.queued.length > 0) {
    const item = participant.queued.shift();
    participant.queuedBytes -= item.buffer.length;
    sendOrQueueSlotAudio(slot, item, slot.activeLease);
  }
  scheduleRelease(pool, slot, participant);
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

  slot.pendingAudio.push({ ...item, lease });
  slot.pendingBytes += item.buffer.length;
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
    lease.sentAudioEndMs = endMs;
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

function queueParticipantAudio(pool, participant, item) {
  participant.queued.push({ ...item, buffer: Buffer.from(item.buffer) });
  participant.queuedBytes += item.buffer.length;
  if (!participant.waiting) {
    participant.waiting = true;
    pool.waitingOrder.push(participant.key);
    console.log(`${LOG} queued ${participant.userName} (${participant.userId}); all slots are locked`);
  }

  while (
    participant.queuedBytes > CONFIG.participantQueueMaxBytes &&
    participant.queued.length > 0
  ) {
    const dropped = participant.queued.shift();
    participant.queuedBytes -= dropped.buffer.length;
    participant.droppedBytes += dropped.buffer.length;
  }
}

function scheduleRelease(pool, slot, participant) {
  if (slot.releaseTimer) clearTimeout(slot.releaseTimer);
  const elapsed = Date.now() - participant.lastAudioAt;
  const delay = Math.max(CONFIG.releasePauseMs - elapsed, 1);
  slot.releaseTimer = setTimeout(() => tryReleaseSlot(pool, slot), delay);
}

function tryReleaseSlot(pool, slot) {
  slot.releaseTimer = null;
  const lease = slot.activeLease;
  if (!lease || pool.stopping) return;
  const participant = pool.participants.get(lease.participantKey);
  if (!participant) return releaseSlot(pool, slot);

  const silenceMs = Date.now() - participant.lastAudioAt;
  if (silenceMs < CONFIG.releasePauseMs) {
    scheduleRelease(pool, slot, participant);
    return;
  }

  slot.state = 'draining';
  slot.drainStartedAt ??= Date.now();
  const queueEmpty = slot.pendingAudio.length === 0;
  const transcriptCaughtUp =
    slot.transcribedAudioEndMs >= lease.sentAudioEndMs - WATERMARK_TOLERANCE_MS;
  const drainTimedOut = Date.now() - slot.drainStartedAt >= CONFIG.drainTimeoutMs;

  if (queueEmpty && (transcriptCaughtUp || drainTimedOut)) {
    releaseSlot(pool, slot);
    return;
  }

  slot.releaseTimer = setTimeout(() => tryReleaseSlot(pool, slot), DRAIN_POLL_MS);
}

function releaseSlot(pool, slot) {
  const lease = slot.activeLease;
  if (lease && pool.participantSlots.get(lease.participantKey) === slot.slotId) {
    pool.participantSlots.delete(lease.participantKey);
  }
  slot.activeLease = null;
  slot.state = 'free';
  slot.drainStartedAt = null;
  assignNextWaitingParticipant(pool, slot);
}

function assignNextWaitingParticipant(pool, slot) {
  while (pool.waitingOrder.length > 0) {
    const key = pool.waitingOrder.shift();
    const participant = pool.participants.get(key);
    if (!participant || participant.queued.length === 0 || pool.participantSlots.has(key)) continue;
    assignSlot(pool, slot, participant);
    return;
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
    slot.transcribedAudioEndMs = 0;
    slot.spans = [];
    if (slot.activeLease) slot.activeLease.sentAudioEndMs = 0;
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
      slot.transcribedAudioEndMs = Math.max(slot.transcribedAudioEndMs, endMs);
      const attribution = resolveTranscriptAttribution(slot.spans, startMs, endMs);
      const text = event.transcript || '';
      const startTimeEpochMs = calculateTranscriptEpochMs(attribution, startMs);
      const endTimeEpochMs = calculateTranscriptEpochMs(attribution, endMs);
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
        receivedAt: Date.now(),
        text,
      };
      if (text) {
        pool.completed.push(result);
        console.log(
          `${LOG} ${result.userName} (${result.userId ?? 'unknown'}) ` +
          `start_time=${startTimeEpochMs ?? 'unknown'} ` +
          `end_time=${endTimeEpochMs ?? 'unknown'} ${text}`
        );
      }
      if (slot.state === 'draining') tryReleaseSlot(pool, slot);
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
    console.log(`${LOG} Final merged transcript for meeting ${meetingUuid}:`);
    for (const item of transcript) {
      console.log(`${item.userName} (${item.userId ?? 'unknown'}): ${item.text}`);
    }
  }
  pools.delete(meetingUuid);
}

async function closeSlot(slot) {
  slot.stopRequested = true;
  if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
  if (slot.releaseTimer) clearTimeout(slot.releaseTimer);
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
