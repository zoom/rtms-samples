import WebSocket from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createResamplerState, resamplePcm16Mono } from './audioResampler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const CONFIG = {
  ENABLED: process.env.MICROSOFT_VOICE_LIVE_ENABLED !== 'false',
  API_KEY: process.env.MICROSOFT_VOICE_LIVE_API_KEY || '',
  ENDPOINT: process.env.MICROSOFT_VOICE_LIVE_ENDPOINT || '',
  API_VERSION: process.env.MICROSOFT_VOICE_LIVE_API_VERSION || '2026-04-10',
  MODEL: process.env.MICROSOFT_VOICE_LIVE_MODEL || 'gpt-realtime',
  VOICE_NAME: process.env.MICROSOFT_VOICE_NAME || 'en-US-Harper:MAI-Voice-2.1-Flash',
  VOICE_TYPE: process.env.MICROSOFT_VOICE_TYPE || 'azure-standard',
  LANGUAGE: process.env.MICROSOFT_INPUT_LANGUAGE || 'en',
  VAD_TYPE: process.env.MICROSOFT_VAD_TYPE || 'azure_semantic_vad',
  VAD_SILENCE_DURATION_MS: Number.parseInt(process.env.MICROSOFT_VAD_SILENCE_DURATION_MS || '500', 10),
  AUTO_TRUNCATE: process.env.MICROSOFT_AUTO_TRUNCATE !== 'false',
  ENABLE_AUDIO_TIMESTAMPS: process.env.MICROSOFT_ENABLE_AUDIO_TIMESTAMPS !== 'false',
  SOURCE_SAMPLE_RATE: Number.parseInt(process.env.AUDIO_SAMPLE_RATE || '48000', 10),
  TARGET_SAMPLE_RATE: Number.parseInt(process.env.TARGET_AUDIO_SAMPLE_RATE || '24000', 10),
  TARGET_CHUNK_DURATION_MS: Number.parseInt(process.env.TARGET_CHUNK_DURATION_MS || '100', 10),
  MAX_QUEUED_AUDIO_BYTES: Number.parseInt(process.env.MICROSOFT_MAX_QUEUED_AUDIO_BYTES || '2097152', 10),
  RECONNECT_DELAY_MS: Number.parseInt(process.env.MICROSOFT_RECONNECT_DELAY_MS || '2000', 10),
  RESPONSE_NO_OUTPUT_WARNING_MS: Number.parseInt(process.env.MICROSOFT_RESPONSE_NO_OUTPUT_WARNING_MS || '8000', 10),
  IGNORE_INTERRUPTS_AFTER_ASSISTANT_AUDIO_START_MS: Number.parseInt(process.env.MICROSOFT_IGNORE_INTERRUPTS_AFTER_ASSISTANT_AUDIO_START_MS || '700', 10),
  SPEAKER_SAFE_TAIL_COOLDOWN_MS: Number.parseInt(process.env.MICROSOFT_SPEAKER_SAFE_TAIL_COOLDOWN_MS || '450', 10),
  TRANSCRIPTION_MODEL: process.env.MICROSOFT_TRANSCRIPTION_MODEL || 'mai-transcribe-2',
  DEBUG_EVENTS: process.env.MICROSOFT_DEBUG_EVENTS === 'true',
};

const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const SOURCE_CHUNK_SIZE = Math.max(
  BYTES_PER_SAMPLE,
  Math.floor((CONFIG.SOURCE_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CONFIG.TARGET_CHUNK_DURATION_MS) / 1000),
);

const sessions = new Map();

let frontendCallbacks = {
  broadcastToMeeting: () => {},
};

export function validateVoiceLiveConfig() {
  if (!CONFIG.ENABLED) {
    return { valid: true };
  }
  if (!CONFIG.API_KEY || !CONFIG.ENDPOINT) {
    return {
      valid: false,
      error: 'MICROSOFT_VOICE_LIVE_API_KEY and MICROSOFT_VOICE_LIVE_ENDPOINT are required when enabled',
    };
  }
  if (CONFIG.TARGET_SAMPLE_RATE !== 24000) {
    return {
      valid: false,
      error: 'TARGET_AUDIO_SAMPLE_RATE must be 24000 for pcm16 input/output',
    };
  }
  return { valid: true };
}

export function setRealtimeFrontendCallbacks(callbacks = {}) {
  frontendCallbacks = {
    ...frontendCallbacks,
    ...callbacks,
  };
}

export function initializeRealtimeSession(meetingUuid) {
  if (!meetingUuid) {
    return null;
  }

  if (!CONFIG.ENABLED) {
    console.log('[Microsoft Voice Live] Disabled by MICROSOFT_VOICE_LIVE_ENABLED=false');
    return null;
  }

  const validation = validateVoiceLiveConfig();
  if (!validation.valid) {
    console.error(`[Microsoft Voice Live] ${validation.error}`);
    broadcastToMeeting(meetingUuid, { type: 'error', data: validation.error });
    return null;
  }

  if (sessions.has(meetingUuid)) {
    return sessions.get(meetingUuid);
  }

  const session = {
    meetingUuid,
    ws: null,
    sessionReady: false,
    stopRequested: false,
    sourceAudioBuffer: [],
    resamplerState: createResamplerState(),
    queuedAudio: [],
    queuedAudioBytes: 0,
    totalSourceBytes: 0,
    sentAudioBytes: 0,
    chunkCount: 0,
    startedAt: Date.now(),
    reconnectTimer: null,
    currentAudioItem: null,
    activeResponseId: null,
    activeResponseStartedAt: 0,
    activeResponseHadOutput: false,
    ignoredErrorEventIds: new Set(),
    outputAudioDeltas: 0,
    outputAudioBytes: 0,
    outputTranscriptDeltas: 0,
    currentResponseAudioStartedAt: 0,
    responseWatchdogTimer: null,
    speakerSafeMode: false,
    clientPlaybackActive: false,
    assistantAudioTailUntil: 0,
  };

  sessions.set(meetingUuid, session);
  console.log(`[Microsoft Voice Live] Initializing session for meeting ${meetingUuid}`);
  connectRealtime(session);
  return session;
}

export function setSpeakerSafeMode(meetingUuid, enabled) {
  const session = getSession(meetingUuid);
  if (!session) {
    return false;
  }
  session.speakerSafeMode = Boolean(enabled);
  console.log(`[Microsoft Voice Live] [${meetingUuid.slice(0, 8)}] Speaker-Safe half-duplex mode=${session.speakerSafeMode}`);
  return true;
}

export function setClientPlaybackActive(meetingUuid, playing) {
  const session = getSession(meetingUuid);
  if (!session) {
    return false;
  }
  session.clientPlaybackActive = Boolean(playing);
  if (!playing) {
    session.assistantAudioTailUntil = Date.now() + CONFIG.SPEAKER_SAFE_TAIL_COOLDOWN_MS;
  }
  return true;
}

export function shouldSuppressMicAudio(session, now = Date.now()) {
  if (!session?.speakerSafeMode) {
    return false;
  }
  if (session.clientPlaybackActive) {
    return true;
  }
  if (session.assistantAudioTailUntil > now) {
    return true;
  }
  return false;
}

export function sendAudioChunk(buffer, meetingUuid, userId = 0) {
  if (!CONFIG.ENABLED || !buffer || buffer.length === 0 || !meetingUuid) {
    return;
  }

  let session = sessions.get(meetingUuid);
  if (!session) {
    session = initializeRealtimeSession(meetingUuid);
  }
  if (!session || session.stopRequested) {
    return;
  }

  if (shouldSuppressMicAudio(session)) {
    return;
  }

  session.totalSourceBytes += buffer.length;
  session.chunkCount += 1;
  session.sourceAudioBuffer.push(buffer);

  let combined = Buffer.concat(session.sourceAudioBuffer);

  while (combined.length >= SOURCE_CHUNK_SIZE) {
    const sourceChunk = combined.subarray(0, SOURCE_CHUNK_SIZE);
    const targetChunk = resamplePcm16Mono(
      sourceChunk,
      CONFIG.SOURCE_SAMPLE_RATE,
      CONFIG.TARGET_SAMPLE_RATE,
      session.resamplerState,
    );
    sendRealtimeAudio(session, targetChunk);
    combined = combined.subarray(SOURCE_CHUNK_SIZE);
  }

  session.sourceAudioBuffer = combined.length > 0 ? [combined] : [];

  if (session.chunkCount % 100 === 0) {
    const elapsedSeconds = ((Date.now() - session.startedAt) / 1000).toFixed(1);
    console.log(
      `[Microsoft Voice Live] [${meetingUuid.slice(0, 8)}] chunks=${session.chunkCount} rtmsBytes=${session.totalSourceBytes} voiceLiveBytes=${session.sentAudioBytes} queuedBytes=${session.queuedAudioBytes} ready=${session.sessionReady} ws=${readyStateName(session.ws)} elapsed=${elapsedSeconds}s lastUser=${userId}`,
    );
  }
}

export function sendTextMessageToRealtime(text, meetingUuid) {
  const session = getSession(meetingUuid);
  const cleanText = String(text || '').trim();
  if (!session || !cleanText) {
    return false;
  }

  if (!session.sessionReady || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Microsoft Voice Live session is not ready');
  }

  sendEvent(session, {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: cleanText,
        },
      ],
    },
  });

  sendResponseCreate(session, 'text_message');
  return true;
}

/**
 * Reconciles server-side `auto_truncate: true` with manual `conversation.item.truncate`.
 * When `auto_truncate` is enabled and interruption came from server VAD (`skipCancel === true`),
 * Voice Live already truncates automatically — skip sending a duplicate truncate command.
 */
export function truncateRealtimeAudioPlayback({
  meetingUuid,
  responseId = null,
  itemId,
  contentIndex = 0,
  audioEndMs = 0,
  skipCancel = false,
} = {}) {
  const session = getSession(meetingUuid);
  if (!session || !itemId || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  if (CONFIG.AUTO_TRUNCATE && skipCancel) {
    console.log(
      `[Microsoft Voice Live] Skipping manual truncate for item=${itemId} (auto_truncate=true handles server-VAD barge-in)`,
    );
    return false;
  }

  const safeAudioEndMs = Math.max(0, Math.floor(Number(audioEndMs) || 0));
  try {
    if (!skipCancel) {
      cancelRealtimeResponse(session, responseId);
    }

    sendEvent(session, {
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: Number.isInteger(contentIndex) ? contentIndex : 0,
      audio_end_ms: safeAudioEndMs,
    });
    console.log(`[Microsoft Voice Live] Truncated playback item=${itemId} at ${safeAudioEndMs}ms`);
    return true;
  } catch (error) {
    console.error('[Microsoft Voice Live] Failed to truncate playback:', error.message);
    return false;
  }
}

export async function cleanupMeeting(meetingUuid) {
  const session = sessions.get(meetingUuid);
  if (!session) {
    return;
  }

  console.log(`[Microsoft Voice Live] Cleaning up meeting ${meetingUuid}`);
  session.stopRequested = true;
  session.sourceAudioBuffer = [];
  session.queuedAudio = [];
  session.queuedAudioBytes = 0;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
  clearTimer(session, 'responseWatchdogTimer');

  broadcastToMeeting(meetingUuid, {
    type: 'interrupt',
    data: 'meeting_stopped',
    metadata: {
      meetingUuid,
    },
  });

  if (session.ws) {
    try {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.close(1000, 'meeting stopped');
      } else if (session.ws.readyState === WebSocket.CONNECTING) {
        // Close/terminate CONNECTING sockets immediately so no orphan socket leaks
        session.ws.terminate();
      }
    } catch (error) {
      console.error(`[Microsoft Voice Live] Error closing WebSocket for meeting ${meetingUuid}: ${error.message}`);
    }
  }

  sessions.delete(meetingUuid);
}

export async function closeMicrosoftVoiceLive(meetingUuid = null) {
  if (meetingUuid) {
    await cleanupMeeting(meetingUuid);
    return;
  }

  for (const uuid of [...sessions.keys()]) {
    await cleanupMeeting(uuid);
  }
}

function connectRealtime(session) {
  if (session.stopRequested) {
    return;
  }

  const endpoint = new URL(CONFIG.ENDPOINT);
  endpoint.searchParams.set('api-version', CONFIG.API_VERSION);
  endpoint.searchParams.set('model', CONFIG.MODEL);
  const headers = {
    'api-key': CONFIG.API_KEY,
  };

  console.log(`[Microsoft Voice Live] Connecting for meeting ${session.meetingUuid}`);
  const ws = new WebSocket(endpoint, { headers });
  session.ws = ws;
  session.sessionReady = false;

  ws.on('open', () => {
    if (session.stopRequested) {
      ws.close(1000, 'meeting stopped');
      return;
    }
    console.log(`[Microsoft Voice Live] Connected for meeting ${session.meetingUuid}`);
    sendEvent(session, buildSessionUpdateEvent(session.meetingUuid));
  });

  ws.on('message', (message) => {
    handleRealtimeEvent(session, message);
  });

  ws.on('error', (error) => {
    console.error(`[Microsoft Voice Live] WebSocket error for meeting ${session.meetingUuid}: ${error.message}`);
  });

  ws.on('close', (code, reason) => {
    const reasonText = reason?.toString() || '';
    console.log(`[Microsoft Voice Live] Closed for meeting ${session.meetingUuid}: ${code} ${reasonText}`);
    session.sessionReady = false;

    if (!session.stopRequested && code !== 1000) {
      session.reconnectTimer = setTimeout(() => connectRealtime(session), CONFIG.RECONNECT_DELAY_MS);
    }
  });
}

export function buildSessionUpdateEvent(meetingUuid) {
  const session = {
    modalities: ['text', 'audio'],
    instructions: buildInstructions(meetingUuid),
    input_audio_format: 'pcm16',
    input_audio_sampling_rate: CONFIG.TARGET_SAMPLE_RATE,
    input_audio_transcription: {
      model: CONFIG.TRANSCRIPTION_MODEL,
      language: CONFIG.LANGUAGE,
    },
    input_audio_noise_reduction: {
      type: 'azure_deep_noise_suppression',
    },
    input_audio_echo_cancellation: {
      type: 'server_echo_cancellation',
    },
    turn_detection: {
      type: CONFIG.VAD_TYPE,
      silence_duration_ms: CONFIG.VAD_SILENCE_DURATION_MS,
      create_response: true,
      interrupt_response: true,
      auto_truncate: CONFIG.AUTO_TRUNCATE,
    },
    voice: {
      name: CONFIG.VOICE_NAME,
      type: CONFIG.VOICE_TYPE,
    },
  };

  if (CONFIG.ENABLE_AUDIO_TIMESTAMPS) {
    session.output_audio_timestamp_types = ['word'];
  }

  return {
    type: 'session.update',
    session,
  };
}

function buildInstructions(meetingUuid) {
  return [
    'You are a concise realtime voice assistant running inside a Zoom App webview.',
    'Respond naturally to what participants say in the meeting. Keep responses brief unless asked for detail.',
    `Current RTMS meeting id: ${meetingUuid}`,
  ].join(' ');
}

function handleRealtimeEvent(session, rawMessage) {
  let event;
  try {
    event = JSON.parse(rawMessage.toString());
  } catch (error) {
    console.error('[Microsoft Voice Live] Failed to parse event:', error.message);
    return;
  }

  switch (event.type) {
    case 'session.created':
      console.log(`[Microsoft Voice Live] Session created for meeting ${session.meetingUuid}`);
      break;
    case 'session.updated':
      session.sessionReady = true;
      console.log(
        `[Microsoft Voice Live] Session updated for meeting ${session.meetingUuid}; flushing queuedBytes=${session.queuedAudioBytes}`,
      );
      broadcastToMeeting(session.meetingUuid, { type: 'status', data: 'Microsoft Voice Live session ready' });
      flushQueuedAudio(session);
      break;
    case 'response.created':
      session.activeResponseId = event.response?.id || event.response_id || session.activeResponseId;
      session.activeResponseStartedAt = Date.now();
      session.activeResponseHadOutput = false;
      startResponseWatchdog(session);
      console.log(`[Microsoft Voice Live] Response created ${session.activeResponseId || 'unknown'} for meeting ${session.meetingUuid}`);
      break;
    case 'error':
      handleRealtimeError(session, event);
      break;
    case 'input_audio_buffer.speech_started':
      handleSpeechStarted(session, event);
      break;
    case 'input_audio_buffer.speech_stopped':
      console.log(`[Microsoft Voice Live] User speech stopped for meeting ${session.meetingUuid} at audioEndMs=${event.audio_end_ms ?? 'unknown'}`);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      console.log(`[Microsoft Voice Live] Transcript: ${event.transcript || ''}`);
      broadcastToMeeting(session.meetingUuid, {
        type: 'transcript',
        data: event.transcript || '',
        metadata: {
          meetingUuid: session.meetingUuid,
          itemId: event.item_id,
        },
      });
      break;
    case 'response.audio.delta':
      handleOutputAudioDelta(session, event);
      break;
    case 'response.audio_transcript.delta':
      markResponseOutput(session, 'audio_transcript');
      session.outputTranscriptDeltas += 1;
      broadcastToMeeting(session.meetingUuid, {
        type: 'text',
        data: event.delta || '',
        metadata: {
          stream: true,
          responseId: event.response_id,
          itemId: event.item_id,
        },
      });
      break;
    case 'response.audio_transcript.done':
      console.log(`[Microsoft Voice Live] Assistant transcript: ${event.transcript || ''}`);
      broadcastToMeeting(session.meetingUuid, {
        type: 'text_done',
        data: event.transcript || '',
        metadata: {
          responseId: event.response_id,
          itemId: event.item_id,
        },
      });
      break;
    case 'response.audio.done':
      session.assistantAudioTailUntil = Date.now() + CONFIG.SPEAKER_SAFE_TAIL_COOLDOWN_MS;
      broadcastToMeeting(session.meetingUuid, {
        type: 'audio_done',
        metadata: {
          responseId: event.response_id,
          itemId: event.item_id,
        },
      });
      break;
    case 'response.audio_timestamp.delta':
      handleAudioTimestampDelta(session, event);
      break;
    case 'response.audio_timestamp.done':
      broadcastToMeeting(session.meetingUuid, {
        type: 'audio_timestamp_done',
        metadata: {
          meetingUuid: session.meetingUuid,
          responseId: event.response_id,
          itemId: event.item_id,
        },
      });
      break;
    case 'response.done':
      clearTimer(session, 'responseWatchdogTimer');
      if ((event.response?.id || event.response_id) === session.activeResponseId) {
        session.activeResponseId = null;
        session.activeResponseStartedAt = 0;
        session.activeResponseHadOutput = false;
        session.currentResponseAudioStartedAt = 0;
      }
      break;
    default:
      if (CONFIG.DEBUG_EVENTS) {
        console.log(`[Microsoft Voice Live] Event: ${event.type}`);
      }
      break;
  }
}

function handleAudioTimestampDelta(session, event) {
  const wordText = event.text ?? event.delta ?? '';
  if (!wordText) {
    return;
  }

  broadcastToMeeting(session.meetingUuid, {
    type: 'audio_timestamp',
    data: {
      text: String(wordText),
      audioOffsetMs: Number(event.audio_offset_ms ?? 0),
      audioDurationMs: Number(event.audio_duration_ms ?? 0),
      timestampType: event.timestamp_type || 'word',
    },
    metadata: {
      meetingUuid: session.meetingUuid,
      responseId: event.response_id,
      itemId: event.item_id,
      contentIndex: event.content_index ?? 0,
    },
  });
}

function handleSpeechStarted(session, event) {
  const now = Date.now();
  const audioStartedAt = session.currentResponseAudioStartedAt;
  const assistantAudioAgeMs = audioStartedAt ? now - audioStartedAt : Number.POSITIVE_INFINITY;
  if (assistantAudioAgeMs < CONFIG.IGNORE_INTERRUPTS_AFTER_ASSISTANT_AUDIO_START_MS) {
    console.log(
      `[Microsoft Voice Live] Ignoring speech_started ${Math.round(assistantAudioAgeMs)}ms after assistant audio started to avoid self-interrupt`,
    );
    return;
  }

  console.log(`[Microsoft Voice Live] User speech started; interrupting playback for meeting ${session.meetingUuid}`);
  broadcastToMeeting(session.meetingUuid, {
    type: 'interrupt',
    data: 'speech_started',
    metadata: {
      meetingUuid: session.meetingUuid,
      audioStartMs: event.audio_start_ms,
      autoTruncate: CONFIG.AUTO_TRUNCATE,
    },
  });
}

function handleOutputAudioDelta(session, event) {
  if (!event.delta) {
    return;
  }

  markResponseOutput(session, 'audio');
  session.currentAudioItem = {
    responseId: event.response_id,
    itemId: event.item_id,
    outputIndex: event.output_index,
    contentIndex: event.content_index ?? 0,
  };
  session.activeResponseId = event.response_id || session.activeResponseId;
  if (!session.currentResponseAudioStartedAt) {
    session.currentResponseAudioStartedAt = Date.now();
  }
  const decodedBytes = Buffer.byteLength(event.delta, 'base64');
  const chunkDurationMs = (decodedBytes / (CONFIG.TARGET_SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1000;
  session.assistantAudioTailUntil = Math.max(
    session.assistantAudioTailUntil,
    Date.now() + chunkDurationMs + CONFIG.SPEAKER_SAFE_TAIL_COOLDOWN_MS,
  );
  session.outputAudioDeltas += 1;
  session.outputAudioBytes += decodedBytes;

  if (session.outputAudioDeltas === 1 || session.outputAudioDeltas % 20 === 0) {
    console.log(
      `[Microsoft Voice Live] [${session.meetingUuid.slice(0, 8)}] outputAudioDeltas=${session.outputAudioDeltas} outputAudioBytes=${session.outputAudioBytes} response=${event.response_id || 'unknown'}`,
    );
  }

  broadcastToMeeting(session.meetingUuid, {
    type: 'audio',
    data: event.delta,
    metadata: {
      meetingUuid: session.meetingUuid,
      responseId: event.response_id,
      itemId: event.item_id,
      outputIndex: event.output_index,
      contentIndex: event.content_index ?? 0,
      sampleRate: CONFIG.TARGET_SAMPLE_RATE,
      format: 'pcm16',
    },
  });
}

function cancelRealtimeResponse(session, responseId = null) {
  const activeResponseId = responseId || session.activeResponseId;
  if (!activeResponseId) {
    return;
  }

  const eventId = `cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  session.ignoredErrorEventIds.add(eventId);
  sendEvent(session, {
    event_id: eventId,
    type: 'response.cancel',
    response_id: activeResponseId,
  });
  console.log(`[Microsoft Voice Live] Cancelled active response ${activeResponseId}`);
}

function handleRealtimeError(session, event) {
  const errorEventId = event.event_id || event.error?.event_id;
  const message = event.error?.message || JSON.stringify(event.error || event);

  if (errorEventId && session.ignoredErrorEventIds.delete(errorEventId)) {
    console.warn(`[Microsoft Voice Live] Ignored non-fatal cancel error: ${message}`);
    return;
  }

  console.error(`[Microsoft Voice Live] API error: ${message}`);
  broadcastToMeeting(session.meetingUuid, {
    type: 'error',
    data: event.error?.message || 'Microsoft Voice Live API error',
  });
}

function markResponseOutput(session, outputType) {
  if (!session.activeResponseHadOutput) {
    console.log(`[Microsoft Voice Live] First response output type=${outputType} response=${session.activeResponseId || 'unknown'}`);
  }
  session.activeResponseHadOutput = true;
  clearTimer(session, 'responseWatchdogTimer');
}

function startResponseWatchdog(session) {
  clearTimer(session, 'responseWatchdogTimer');
  if (CONFIG.RESPONSE_NO_OUTPUT_WARNING_MS <= 0) {
    return;
  }

  const responseId = session.activeResponseId;
  session.responseWatchdogTimer = setTimeout(() => {
    session.responseWatchdogTimer = null;
    if (!session.stopRequested && responseId === session.activeResponseId && !session.activeResponseHadOutput) {
      const elapsedSeconds = ((Date.now() - session.activeResponseStartedAt) / 1000).toFixed(1);
      console.warn(`[Microsoft Voice Live] Response ${responseId || 'unknown'} has no audio/text output after ${elapsedSeconds}s`);
      broadcastToMeeting(session.meetingUuid, {
        type: 'status',
        data: 'Still waiting for Microsoft Voice Live response output...',
      });
    }
  }, CONFIG.RESPONSE_NO_OUTPUT_WARNING_MS);
}

function clearTimer(session, timerName) {
  if (session?.[timerName]) {
    clearTimeout(session[timerName]);
    session[timerName] = null;
  }
}

function sendRealtimeAudio(session, pcm24k) {
  if (!pcm24k || pcm24k.length === 0) {
    return;
  }

  if (!session.sessionReady || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
    queueAudio(session, pcm24k);
    return;
  }

  try {
    sendEvent(session, {
      type: 'input_audio_buffer.append',
      audio: pcm24k.toString('base64'),
    });
    session.sentAudioBytes += pcm24k.length;
  } catch (error) {
    console.error('[Microsoft Voice Live] Failed to send audio:', error.message);
    queueAudio(session, pcm24k);
  }
}

function queueAudio(session, pcm24k) {
  session.queuedAudio.push(pcm24k);
  session.queuedAudioBytes += pcm24k.length;

  while (session.queuedAudioBytes > CONFIG.MAX_QUEUED_AUDIO_BYTES && session.queuedAudio.length > 0) {
    const dropped = session.queuedAudio.shift();
    session.queuedAudioBytes -= dropped.length;
  }
}

function flushQueuedAudio(session) {
  while (
    session.sessionReady &&
    session.ws &&
    session.ws.readyState === WebSocket.OPEN &&
    session.queuedAudio.length > 0
  ) {
    const chunk = session.queuedAudio.shift();
    session.queuedAudioBytes -= chunk.length;
    sendRealtimeAudio(session, chunk);
  }
}

function sendResponseCreate(session, reason) {
  console.log(`[Microsoft Voice Live] Creating response for meeting ${session.meetingUuid}; reason=${reason}`);
  broadcastToMeeting(session.meetingUuid, {
    type: 'status',
    data: 'Microsoft Voice Live is preparing a response...',
  });
  sendEvent(session, {
    type: 'response.create',
    response: {
      modalities: ['text', 'audio'],
    },
  });
}

function sendEvent(session, event) {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Microsoft Voice Live WebSocket is not open');
  }
  session.ws.send(JSON.stringify(event));
}

/**
 * Strictly meeting-scoped session lookup (no cross-meeting fallback).
 */
export function getSession(meetingUuid) {
  if (!meetingUuid) {
    return null;
  }
  return sessions.get(meetingUuid) || null;
}

function broadcastToMeeting(meetingUuid, message) {
  if (!meetingUuid) {
    return;
  }
  frontendCallbacks.broadcastToMeeting?.(meetingUuid, message);
}

function readyStateName(ws) {
  if (!ws) {
    return 'none';
  }

  const states = {
    [WebSocket.CONNECTING]: 'connecting',
    [WebSocket.OPEN]: 'open',
    [WebSocket.CLOSING]: 'closing',
    [WebSocket.CLOSED]: 'closed',
  };

  return states[ws.readyState] || String(ws.readyState);
}

export { CONFIG, sessions, resamplePcm16Mono };
