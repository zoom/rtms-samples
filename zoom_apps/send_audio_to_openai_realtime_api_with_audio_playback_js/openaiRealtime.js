import WebSocket from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const DEFAULT_ZOOM_MCP_TOOLS = [
  'search_meetings',
  'search_zoom',
  'get_meeting_assets',
  'get_recording_resource',
  'get_file_content',
  'recordings_list',
  'create_new_file_with_markdown',
];

const zoomMcpAccessToken = stripBearerPrefix(process.env.ZOOM_MCP_ACCESS_TOKEN || '');
const zoomMcpTokenStatus = inspectJwtExpiration(zoomMcpAccessToken);

const CONFIG = {
  ENABLED: process.env.OPENAI_REALTIME_ENABLED !== 'false',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  MODEL: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
  VOICE: process.env.OPENAI_REALTIME_VOICE || 'marin',
  SAFETY_IDENTIFIER: process.env.OPENAI_SAFETY_IDENTIFIER || '',
  SOURCE_SAMPLE_RATE: Number.parseInt(process.env.AUDIO_SAMPLE_RATE || '48000', 10),
  TARGET_SAMPLE_RATE: Number.parseInt(process.env.OPENAI_AUDIO_SAMPLE_RATE || '24000', 10),
  TARGET_CHUNK_DURATION_MS: Number.parseInt(process.env.TARGET_CHUNK_DURATION_MS || '100', 10),
  MAX_QUEUED_AUDIO_BYTES: Number.parseInt(process.env.OPENAI_MAX_QUEUED_AUDIO_BYTES || '2097152', 10),
  RECONNECT_DELAY_MS: Number.parseInt(process.env.OPENAI_REALTIME_RECONNECT_DELAY_MS || '2000', 10),
  FORCE_RESPONSE_AFTER_SPEECH_STOP_MS: Number.parseInt(process.env.OPENAI_FORCE_RESPONSE_AFTER_SPEECH_STOP_MS || '1800', 10),
  RESPONSE_NO_OUTPUT_WARNING_MS: Number.parseInt(process.env.OPENAI_RESPONSE_NO_OUTPUT_WARNING_MS || '8000', 10),
  MCP_LONG_RUNNING_WARNING_MS: Number.parseInt(process.env.OPENAI_MCP_LONG_RUNNING_WARNING_MS || '10000', 10),
  IGNORE_INTERRUPTS_AFTER_ASSISTANT_AUDIO_START_MS: Number.parseInt(process.env.OPENAI_IGNORE_INTERRUPTS_AFTER_ASSISTANT_AUDIO_START_MS || '700', 10),
  TRANSCRIPTION_ENABLED: process.env.OPENAI_REALTIME_TRANSCRIPTION_ENABLED !== 'false',
  TRANSCRIPTION_MODEL: process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  ZOOM_MCP_SERVER_LABEL: process.env.ZOOM_MCP_SERVER_LABEL || 'zoom',
  ZOOM_MCP_SERVER_URL: process.env.ZOOM_MCP_SERVER_URL || 'https://mcp-us.zoom.us/mcp/zoom/streamable',
  ZOOM_MCP_ACCESS_TOKEN: zoomMcpAccessToken,
  ZOOM_MCP_TOKEN_STATUS: zoomMcpTokenStatus,
  ZOOM_MCP_ALLOWED_TOOLS: parseCsv(process.env.ZOOM_MCP_ALLOWED_TOOLS || DEFAULT_ZOOM_MCP_TOOLS.join(',')),
  ZOOM_MCP_REQUIRE_APPROVAL: process.env.ZOOM_MCP_REQUIRE_APPROVAL || 'never',
  LOG_RAW_MCP_OUTPUT: process.env.OPENAI_REALTIME_LOG_RAW_MCP_OUTPUT === 'true',
  MCP_OUTPUT_PREVIEW_CHARS: Number.parseInt(process.env.OPENAI_REALTIME_MCP_OUTPUT_PREVIEW_CHARS || '500', 10),
  COST_LOGGING_ENABLED: process.env.OPENAI_REALTIME_COST_LOGGING_ENABLED !== 'false',
  PRICING: {
    TEXT_INPUT_PER_1M: parseNumber(process.env.OPENAI_REALTIME_TEXT_INPUT_PRICE_PER_1M, 4),
    TEXT_OUTPUT_PER_1M: parseNumber(process.env.OPENAI_REALTIME_TEXT_OUTPUT_PRICE_PER_1M, 24),
    AUDIO_INPUT_PER_1M: parseNumber(process.env.OPENAI_REALTIME_AUDIO_INPUT_PRICE_PER_1M, 32),
    AUDIO_OUTPUT_PER_1M: parseNumber(process.env.OPENAI_REALTIME_AUDIO_OUTPUT_PRICE_PER_1M, 64),
  },
};

const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const SOURCE_CHUNK_SIZE = Math.max(
  BYTES_PER_SAMPLE,
  Math.floor(CONFIG.SOURCE_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE * CONFIG.TARGET_CHUNK_DURATION_MS / 1000),
);

const sessions = new Map();

let frontendCallbacks = {
  broadcast: () => {},
};

if (CONFIG.ENABLED && !CONFIG.OPENAI_API_KEY) {
  console.error('[OpenAI Realtime] OPENAI_API_KEY is required when OPENAI_REALTIME_ENABLED is true');
  process.exit(1);
}

if (CONFIG.ENABLED && CONFIG.TARGET_SAMPLE_RATE !== 24000) {
  console.error('[OpenAI Realtime] OPENAI_AUDIO_SAMPLE_RATE must be 24000 for Realtime pcm16 input/output');
  process.exit(1);
}

console.log('[OpenAI Realtime] Bridge initialized');
console.log(`[OpenAI Realtime] Model: ${CONFIG.MODEL}`);
console.log(`[OpenAI Realtime] Voice: ${CONFIG.VOICE}`);
console.log(`[OpenAI Realtime] Audio: ${CONFIG.SOURCE_SAMPLE_RATE}Hz RTMS -> ${CONFIG.TARGET_SAMPLE_RATE}Hz OpenAI, chunk ${CONFIG.TARGET_CHUNK_DURATION_MS}ms`);
console.log(`[OpenAI Realtime] Zoom MCP: ${describeMcpStatus()}`);
console.log(`[OpenAI Realtime] Zoom MCP allowed tools: ${CONFIG.ZOOM_MCP_ALLOWED_TOOLS.join(', ') || 'all server tools'}`);
if (CONFIG.ZOOM_MCP_TOKEN_STATUS?.expired) {
  console.warn(`[OpenAI Realtime] Zoom MCP access token expired at ${CONFIG.ZOOM_MCP_TOKEN_STATUS.expiresAtIso}; refresh ZOOM_MCP_ACCESS_TOKEN before expecting tool use.`);
}
if (CONFIG.COST_LOGGING_ENABLED) {
  console.log(`[OpenAI Realtime] Cost logging: enabled, pricing per 1M tokens textIn=$${CONFIG.PRICING.TEXT_INPUT_PER_1M} textOut=$${CONFIG.PRICING.TEXT_OUTPUT_PER_1M} audioIn=$${CONFIG.PRICING.AUDIO_INPUT_PER_1M} audioOut=$${CONFIG.PRICING.AUDIO_OUTPUT_PER_1M}`);
}

export function setRealtimeFrontendCallbacks(callbacks = {}) {
  frontendCallbacks = {
    ...frontendCallbacks,
    ...callbacks,
  };
}

export function initializeRealtimeSession(meetingUuid) {
  if (!CONFIG.ENABLED) {
    console.log('[OpenAI Realtime] Disabled by OPENAI_REALTIME_ENABLED=false');
    return;
  }

  if (sessions.has(meetingUuid)) {
    return;
  }

  const session = {
    meetingUuid,
    ws: null,
    sessionReady: false,
    stopRequested: false,
    sourceAudioBuffer: [],
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
    speechResponseTimer: null,
    responseWatchdogTimer: null,
    mcpWatchdogTimer: null,
    usage: createUsageLedger(),
  };

  sessions.set(meetingUuid, session);
  console.log(`[OpenAI Realtime] Initializing session for meeting ${meetingUuid}`);
  if (CONFIG.ZOOM_MCP_TOKEN_STATUS?.expired) {
    broadcast({
      type: 'error',
      data: `Zoom MCP disabled: access token expired at ${CONFIG.ZOOM_MCP_TOKEN_STATUS.expiresAtIso}`,
    });
  }
  connectRealtime(session);
}

export function sendAudioChunk(buffer, meetingUuid, userId = 0) {
  if (!CONFIG.ENABLED || !buffer || buffer.length === 0) {
    return;
  }

  const session = sessions.get(meetingUuid);
  if (!session || session.stopRequested) {
    return;
  }

  session.totalSourceBytes += buffer.length;
  session.chunkCount += 1;
  session.sourceAudioBuffer.push(buffer);

  let combined = Buffer.concat(session.sourceAudioBuffer);

  while (combined.length >= SOURCE_CHUNK_SIZE) {
    const sourceChunk = combined.subarray(0, SOURCE_CHUNK_SIZE);
    const targetChunk = resamplePcm16Mono(sourceChunk, CONFIG.SOURCE_SAMPLE_RATE, CONFIG.TARGET_SAMPLE_RATE);
    sendRealtimeAudio(session, targetChunk);
    combined = combined.subarray(SOURCE_CHUNK_SIZE);
  }

  session.sourceAudioBuffer = combined.length > 0 ? [combined] : [];

  if (session.chunkCount % 100 === 0) {
    const elapsedSeconds = ((Date.now() - session.startedAt) / 1000).toFixed(1);
    console.log(`[OpenAI Realtime] [${meetingUuid.slice(0, 8)}] chunks=${session.chunkCount} rtmsBytes=${session.totalSourceBytes} openaiBytes=${session.sentAudioBytes} queuedBytes=${session.queuedAudioBytes} ready=${session.sessionReady} ws=${readyStateName(session.ws)} elapsed=${elapsedSeconds}s lastUser=${userId}`);
  }
}

export function sendTextMessageToRealtime(text, meetingUuid = null) {
  const session = getSession(meetingUuid);
  const cleanText = String(text || '').trim();
  if (!session || !cleanText) {
    return false;
  }

  if (!session.sessionReady || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error('OpenAI Realtime session is not ready');
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

export function truncateRealtimeAudioPlayback({
  meetingUuid = null,
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
    console.log(`[OpenAI Realtime] Truncated playback item=${itemId} at ${safeAudioEndMs}ms`);
    return true;
  } catch (error) {
    console.error('[OpenAI Realtime] Failed to truncate playback:', error.message);
    return false;
  }
}

export async function cleanupMeeting(meetingUuid) {
  const session = sessions.get(meetingUuid);
  if (!session) {
    return;
  }

  console.log(`[OpenAI Realtime] Cleaning up meeting ${meetingUuid}`);
  logUsageTotals(session, 'meeting cleanup');
  session.stopRequested = true;

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
  }
  clearSessionTimers(session);

  flushRemainingSourceAudio(session);
  broadcast({
    type: 'interrupt',
    data: 'meeting_stopped',
    metadata: {
      meetingUuid,
    },
  });

  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    try {
      session.ws.close(1000, 'meeting stopped');
    } catch (error) {
      console.error(`[OpenAI Realtime] Error closing WebSocket for meeting ${meetingUuid}: ${error.message}`);
    }
  }

  sessions.delete(meetingUuid);
}

export async function closeOpenAIRealtime(meetingUuid = null) {
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

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(CONFIG.MODEL)}`;
  const headers = {
    Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
  };
  if (CONFIG.SAFETY_IDENTIFIER) {
    headers['OpenAI-Safety-Identifier'] = CONFIG.SAFETY_IDENTIFIER;
  }

  console.log(`[OpenAI Realtime] Connecting for meeting ${session.meetingUuid}`);
  const ws = new WebSocket(url, { headers });
  session.ws = ws;
  session.sessionReady = false;

  ws.on('open', () => {
    console.log(`[OpenAI Realtime] Connected for meeting ${session.meetingUuid}`);
    sendEvent(session, buildSessionUpdateEvent(session.meetingUuid));
  });

  ws.on('message', (message) => {
    handleRealtimeEvent(session, message);
  });

  ws.on('error', (error) => {
    console.error(`[OpenAI Realtime] WebSocket error for meeting ${session.meetingUuid}: ${error.message}`);
  });

  ws.on('close', (code, reason) => {
    const reasonText = reason?.toString() || '';
    console.log(`[OpenAI Realtime] Closed for meeting ${session.meetingUuid}: ${code} ${reasonText}`);
    session.sessionReady = false;

    if (!session.stopRequested && code !== 1000) {
      session.reconnectTimer = setTimeout(() => connectRealtime(session), CONFIG.RECONNECT_DELAY_MS);
    }
  });
}

function buildSessionUpdateEvent(meetingUuid) {
  const session = {
    type: 'realtime',
    model: CONFIG.MODEL,
    output_modalities: ['audio'],
    instructions: buildInstructions(meetingUuid),
    audio: {
      input: {
        format: {
          type: 'audio/pcm',
          rate: 24000,
        },
        noise_reduction: {
          type: 'far_field',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: {
          type: 'audio/pcm',
          rate: 24000,
        },
        voice: CONFIG.VOICE,
      },
    },
    tools: buildTools(),
    tool_choice: 'auto',
  };

  if (CONFIG.TRANSCRIPTION_ENABLED) {
    session.audio.input.transcription = {
      model: CONFIG.TRANSCRIPTION_MODEL,
      language: 'en',
    };
  }

  return {
    type: 'session.update',
    session,
  };
}

function buildInstructions(meetingUuid) {
  return [
    'You are a realtime voice assistant running inside a Zoom App webview and connected to live Zoom RTMS meeting audio.',
    'Speak concise, natural responses. Keep most spoken responses under 20 seconds unless the user asks for detail.',
    ...buildMcpInstructionLines(),
    'When interrupted by new speech, stop your current answer and respond to the latest speaker intent.',
    `Current RTMS meeting id: ${meetingUuid}`,
  ].join(' ');
}

function buildMcpInstructionLines() {
  if (!CONFIG.ZOOM_MCP_ACCESS_TOKEN) {
    return [
      'Zoom MCP tools are not configured in this session because ZOOM_MCP_ACCESS_TOKEN is not set.',
      'If the speaker asks for Zoom data, say that the Zoom MCP token is missing and the backend must be configured.',
    ];
  }

  if (CONFIG.ZOOM_MCP_TOKEN_STATUS?.expired) {
    return [
      `Zoom MCP tools are not available in this session because the configured access token expired at ${CONFIG.ZOOM_MCP_TOKEN_STATUS.expiresAtIso}.`,
      'If the speaker asks for Zoom data, say that the Zoom MCP token is expired and the backend needs a fresh token and process restart.',
    ];
  }

  return [
    'Zoom MCP tools are connected in this session. Use them only when the speaker asks for Zoom information or asks you to retrieve, search, summarize, create, or save Zoom-related content.',
    'Use search_meetings when the user asks about past, recent, upcoming, or named meetings. Ask for a date range if the request is too broad.',
    'Use get_meeting_assets after you have a specific meeting ID or UUID and the user asks for summaries, notes, participants, agenda docs, whiteboards, recordings, or meeting-linked docs.',
    'Use recordings_list when the user asks to find cloud recordings by date, host, or meeting number. Use get_recording_resource when the user asks what was said in a recording, wants transcript details, next steps, summaries, or playback links.',
    'Use search_zoom for broad searches across Zoom Docs, meeting notes, or Team Chat. Use get_file_content only after selecting a specific Zoom Doc file ID.',
    'Use create_new_file_with_markdown only when the user explicitly asks you to create, save, or write a Zoom Doc. Use concise Markdown and choose a clear file name.',
    'Summarize MCP results before responding. Do not read raw JSON, full transcripts, exhaustive participant lists, or complete search payloads aloud unless the user explicitly asks.',
    'If multiple MCP results match, summarize the best matches in at most five concise bullets and ask the user to choose instead of guessing.',
    'When the audio is ordinary conversation, greetings, filler, or unrelated meeting discussion, do not call tools.',
  ];
}

function buildTools() {
  if (!CONFIG.ZOOM_MCP_ACCESS_TOKEN) {
    return [];
  }
  if (CONFIG.ZOOM_MCP_TOKEN_STATUS?.expired) {
    return [];
  }

  const tool = {
    type: 'mcp',
    server_label: CONFIG.ZOOM_MCP_SERVER_LABEL,
    server_url: CONFIG.ZOOM_MCP_SERVER_URL,
    authorization: CONFIG.ZOOM_MCP_ACCESS_TOKEN,
    require_approval: CONFIG.ZOOM_MCP_REQUIRE_APPROVAL,
  };

  if (CONFIG.ZOOM_MCP_ALLOWED_TOOLS.length > 0) {
    tool.allowed_tools = CONFIG.ZOOM_MCP_ALLOWED_TOOLS;
  }

  return [tool];
}

function handleRealtimeEvent(session, rawMessage) {
  let event;
  try {
    event = JSON.parse(rawMessage.toString());
  } catch (error) {
    console.error('[OpenAI Realtime] Failed to parse event:', error.message);
    return;
  }

  switch (event.type) {
    case 'session.created':
      console.log(`[OpenAI Realtime] Session created for meeting ${session.meetingUuid}`);
      break;
    case 'session.updated':
      session.sessionReady = true;
      console.log(`[OpenAI Realtime] Session updated for meeting ${session.meetingUuid}; flushing queuedBytes=${session.queuedAudioBytes}`);
      broadcast({ type: 'status', data: 'OpenAI Realtime session ready' });
      flushQueuedAudio(session);
      break;
    case 'response.created':
      session.activeResponseId = event.response?.id || event.response_id || session.activeResponseId;
      session.activeResponseStartedAt = Date.now();
      session.activeResponseHadOutput = false;
      clearTimer(session, 'speechResponseTimer');
      startResponseWatchdog(session);
      console.log(`[OpenAI Realtime] Response created ${session.activeResponseId || 'unknown'} for meeting ${session.meetingUuid}`);
      break;
    case 'error':
      handleRealtimeError(session, event);
      break;
    case 'input_audio_buffer.speech_started':
      handleSpeechStarted(session, event);
      break;
    case 'input_audio_buffer.speech_stopped':
      handleSpeechStopped(session, event);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      console.log(`[OpenAI Realtime] Transcript: ${event.transcript || ''}`);
      broadcast({
        type: 'transcript',
        data: event.transcript || '',
        metadata: {
          meetingUuid: session.meetingUuid,
          itemId: event.item_id,
        },
      });
      break;
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      handleOutputAudioDelta(session, event);
      break;
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      markResponseOutput(session, 'audio_transcript');
      session.outputTranscriptDeltas += 1;
      broadcast({
        type: 'text',
        data: event.delta || '',
        metadata: {
          stream: true,
          responseId: event.response_id,
          itemId: event.item_id,
        },
      });
      break;
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      console.log(`[OpenAI Realtime] Assistant transcript: ${event.transcript || ''}`);
      broadcast({
        type: 'text_done',
        data: event.transcript || '',
        metadata: {
          responseId: event.response_id,
          itemId: event.item_id,
        },
      });
      break;
    case 'response.output_audio.done':
    case 'response.audio.done':
      broadcast({
        type: 'audio_done',
        metadata: {
          responseId: event.response_id,
          itemId: event.item_id,
        },
      });
      break;
    case 'mcp_list_tools.completed':
      console.log(`[OpenAI Realtime] MCP tool listing complete for item ${event.item_id}`);
      break;
    case 'mcp_list_tools.failed':
      console.error(`[OpenAI Realtime] MCP tool listing failed for item ${event.item_id}: ${summarizeMcpFailure(event)}`);
      broadcast({ type: 'error', data: `Zoom MCP tool listing failed: ${summarizeMcpFailure(event)}` });
      break;
    case 'conversation.item.done':
      handleConversationItemDone(event.item);
      break;
    case 'response.mcp_call_arguments.done':
      console.log(`[OpenAI Realtime] MCP call arguments: ${event.arguments}`);
      break;
    case 'response.mcp_call.in_progress':
      console.log(`[OpenAI Realtime] Running MCP tool for item ${event.item_id}`);
      broadcast({ type: 'status', data: 'Running Zoom MCP tool...' });
      startMcpWatchdog(session, event.item_id);
      break;
    case 'response.mcp_call.failed':
      console.error(`[OpenAI Realtime] MCP tool call failed for item ${event.item_id}`);
      broadcast({ type: 'error', data: 'Zoom MCP tool call failed' });
      clearTimer(session, 'mcpWatchdogTimer');
      break;
    case 'response.output_item.done':
      handleOutputItemDone(session, event.item);
      break;
    case 'response.done':
      logUsage(session, event.response?.usage);
      clearTimer(session, 'responseWatchdogTimer');
      clearTimer(session, 'mcpWatchdogTimer');
      if ((event.response?.id || event.response_id) === session.activeResponseId) {
        session.activeResponseId = null;
        session.activeResponseStartedAt = 0;
        session.activeResponseHadOutput = false;
        session.currentResponseAudioStartedAt = 0;
      }
      break;
    default:
      if (process.env.OPENAI_REALTIME_DEBUG_EVENTS === 'true') {
        console.log(`[OpenAI Realtime] Event: ${event.type}`);
      }
      break;
  }
}

function handleSpeechStarted(session, event) {
  const now = Date.now();
  const audioStartedAt = session.currentResponseAudioStartedAt;
  const assistantAudioAgeMs = audioStartedAt ? now - audioStartedAt : Number.POSITIVE_INFINITY;
  if (assistantAudioAgeMs < CONFIG.IGNORE_INTERRUPTS_AFTER_ASSISTANT_AUDIO_START_MS) {
    console.log(`[OpenAI Realtime] Ignoring speech_started ${Math.round(assistantAudioAgeMs)}ms after assistant audio started to avoid self-interrupt`);
    return;
  }

  console.log(`[OpenAI Realtime] User speech started; interrupting playback for meeting ${session.meetingUuid}`);
  broadcast({
    type: 'interrupt',
    data: 'speech_started',
    metadata: {
      meetingUuid: session.meetingUuid,
      audioStartMs: event.audio_start_ms,
    },
  });
}

function handleSpeechStopped(session, event) {
  console.log(`[OpenAI Realtime] User speech stopped for meeting ${session.meetingUuid} at audioEndMs=${event.audio_end_ms ?? 'unknown'}`);

  if (CONFIG.FORCE_RESPONSE_AFTER_SPEECH_STOP_MS <= 0) {
    return;
  }

  clearTimer(session, 'speechResponseTimer');
  session.speechResponseTimer = setTimeout(() => {
    session.speechResponseTimer = null;
    if (session.stopRequested || !session.sessionReady || session.activeResponseId) {
      return;
    }

    try {
      sendResponseCreate(session, 'speech_stopped_watchdog');
    } catch (error) {
      console.error(`[OpenAI Realtime] Failed to force response after speech stop: ${error.message}`);
    }
  }, CONFIG.FORCE_RESPONSE_AFTER_SPEECH_STOP_MS);
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
  session.outputAudioDeltas += 1;
  session.outputAudioBytes += Buffer.byteLength(event.delta, 'base64');

  if (session.outputAudioDeltas === 1 || session.outputAudioDeltas % 20 === 0) {
    console.log(`[OpenAI Realtime] [${session.meetingUuid.slice(0, 8)}] outputAudioDeltas=${session.outputAudioDeltas} outputAudioBytes=${session.outputAudioBytes} response=${event.response_id || 'unknown'}`);
  }

  broadcast({
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
  console.log(`[OpenAI Realtime] Cancelled active response ${activeResponseId}`);
}

function handleRealtimeError(session, event) {
  const errorEventId = event.event_id || event.error?.event_id;
  const message = event.error?.message || JSON.stringify(event.error || event);

  if (errorEventId && session.ignoredErrorEventIds.delete(errorEventId)) {
    console.warn(`[OpenAI Realtime] Ignored non-fatal cancel error: ${message}`);
    return;
  }

  console.error(`[OpenAI Realtime] API error: ${message}`);
  broadcast({ type: 'error', data: event.error?.message || 'OpenAI Realtime API error' });
}

function handleConversationItemDone(item) {
  if (!item) {
    return;
  }

  if (item.type === 'mcp_list_tools') {
    const names = (item.tools || []).map((tool) => tool.name).join(', ');
    console.log(`[OpenAI Realtime] MCP tools ready on ${item.server_label}: ${names}`);
    broadcast({ type: 'status', data: `Zoom MCP tools ready: ${names}` });
  }

  if (item.type === 'mcp_approval_request') {
    console.log(`[OpenAI Realtime] MCP approval required for ${item.server_label}.${item.name}: ${item.arguments}`);
    broadcast({ type: 'error', data: `MCP approval required for ${item.name}; this sample does not auto-approve.` });
  }
}

function handleOutputItemDone(session, item) {
  if (!item) {
    return;
  }

  if (item.type === 'mcp_call') {
    clearTimer(session, 'mcpWatchdogTimer');
    const rawOutput = safeStringify(item.output);
    console.log(`[OpenAI Realtime] MCP output from ${item.server_label}.${item.name}: ${summarizeMcpOutputForLog(item.output, rawOutput)}`);
    if (CONFIG.LOG_RAW_MCP_OUTPUT) {
      console.log(`[OpenAI Realtime] MCP raw output from ${item.server_label}.${item.name}: ${rawOutput}`);
    }
  }
}

function markResponseOutput(session, outputType) {
  if (!session.activeResponseHadOutput) {
    console.log(`[OpenAI Realtime] First response output type=${outputType} response=${session.activeResponseId || 'unknown'}`);
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
      console.warn(`[OpenAI Realtime] Response ${responseId || 'unknown'} has no audio/text output after ${elapsedSeconds}s`);
      broadcast({ type: 'status', data: 'Still waiting for OpenAI response output...' });
    }
  }, CONFIG.RESPONSE_NO_OUTPUT_WARNING_MS);
}

function startMcpWatchdog(session, itemId) {
  clearTimer(session, 'mcpWatchdogTimer');
  if (CONFIG.MCP_LONG_RUNNING_WARNING_MS <= 0) {
    return;
  }

  session.mcpWatchdogTimer = setTimeout(() => {
    session.mcpWatchdogTimer = null;
    if (!session.stopRequested) {
      console.warn(`[OpenAI Realtime] MCP call still running after ${CONFIG.MCP_LONG_RUNNING_WARNING_MS}ms item=${itemId || 'unknown'}`);
      broadcast({ type: 'status', data: 'Still waiting for Zoom MCP results...' });
    }
  }, CONFIG.MCP_LONG_RUNNING_WARNING_MS);
}

function clearTimer(session, timerName) {
  if (session?.[timerName]) {
    clearTimeout(session[timerName]);
    session[timerName] = null;
  }
}

function clearSessionTimers(session) {
  clearTimer(session, 'speechResponseTimer');
  clearTimer(session, 'responseWatchdogTimer');
  clearTimer(session, 'mcpWatchdogTimer');
}

function summarizeMcpFailure(event) {
  const error = event.error || event.item?.error;
  if (!error) {
    return 'check ZOOM_MCP_ACCESS_TOKEN, scopes, and server URL';
  }

  if (typeof error === 'string') {
    return previewText(error, 240);
  }

  return previewText(error.message || safeStringify(error), 240);
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
    console.error('[OpenAI Realtime] Failed to send audio:', error.message);
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

function flushRemainingSourceAudio(session) {
  if (!session.sourceAudioBuffer.length) {
    return;
  }

  const combined = Buffer.concat(session.sourceAudioBuffer);
  session.sourceAudioBuffer = [];
  if (combined.length >= BYTES_PER_SAMPLE) {
    sendRealtimeAudio(session, resamplePcm16Mono(combined, CONFIG.SOURCE_SAMPLE_RATE, CONFIG.TARGET_SAMPLE_RATE));
  }
}

function sendResponseCreate(session, reason) {
  console.log(`[OpenAI Realtime] Creating response for meeting ${session.meetingUuid}; reason=${reason}`);
  broadcast({ type: 'status', data: 'OpenAI is preparing a response...' });
  sendEvent(session, {
    type: 'response.create',
    response: {
      output_modalities: ['audio'],
    },
  });
}

function sendEvent(session, event) {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error('OpenAI Realtime WebSocket is not open');
  }
  session.ws.send(JSON.stringify(event));
}

function getSession(meetingUuid = null) {
  if (meetingUuid && sessions.has(meetingUuid)) {
    return sessions.get(meetingUuid);
  }
  return sessions.values().next().value || null;
}

function broadcast(message) {
  frontendCallbacks.broadcast?.(message);
}

function resamplePcm16Mono(inputBuffer, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return inputBuffer;
  }

  const inputSamples = Math.floor(inputBuffer.length / BYTES_PER_SAMPLE);
  if (inputSamples === 0) {
    return Buffer.alloc(0);
  }

  const outputSamples = Math.max(1, Math.round(inputSamples * targetRate / sourceRate));
  const outputBuffer = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);

  for (let outputIndex = 0; outputIndex < outputSamples; outputIndex += 1) {
    const sourcePosition = outputIndex * sourceRate / targetRate;
    const sourceIndex = Math.floor(sourcePosition);
    const nextSourceIndex = Math.min(sourceIndex + 1, inputSamples - 1);
    const fraction = sourcePosition - sourceIndex;

    const sample = lerp(
      inputBuffer.readInt16LE(sourceIndex * BYTES_PER_SAMPLE),
      inputBuffer.readInt16LE(nextSourceIndex * BYTES_PER_SAMPLE),
      fraction,
    );

    outputBuffer.writeInt16LE(clampPcm16(Math.round(sample)), outputIndex * BYTES_PER_SAMPLE);
  }

  return outputBuffer;
}

function lerp(a, b, amount) {
  return a + ((b - a) * amount);
}

function clampPcm16(value) {
  if (value > 32767) {
    return 32767;
  }
  if (value < -32768) {
    return -32768;
  }
  return value;
}

function logUsage(session, usage) {
  if (!usage) {
    console.log('[OpenAI Realtime] Response done');
    return;
  }

  const responseUsage = normalizeUsage(usage);
  const estimatedCost = estimateUsageCost(responseUsage);
  addUsage(session.usage, responseUsage, estimatedCost);

  console.log(`[OpenAI Realtime] Response done usage input=${responseUsage.inputTokens} output=${responseUsage.outputTokens} audioIn=${responseUsage.audioInputTokens} textIn=${responseUsage.textInputTokens} audioOut=${responseUsage.audioOutputTokens} textOut=${responseUsage.textOutputTokens} cachedIn=${responseUsage.cachedInputTokens} estimatedCost=$${formatUsd(estimatedCost)} cumulativeEstimatedCost=$${formatUsd(session.usage.estimatedModelCostUsd)}`);
  logUsageTotals(session, 'meeting total');
}

function createUsageLedger() {
  return {
    responses: 0,
    inputTokens: 0,
    outputTokens: 0,
    audioInputTokens: 0,
    textInputTokens: 0,
    audioOutputTokens: 0,
    textOutputTokens: 0,
    cachedInputTokens: 0,
    estimatedModelCostUsd: 0,
  };
}

function normalizeUsage(usage) {
  const inputTokens = usage.input_tokens ?? usage.total_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.total_output_tokens ?? 0;
  const inputDetails = usage.input_token_details || {};
  const outputDetails = usage.output_token_details || {};
  const audioInputTokens = inputDetails.audio_tokens ?? 0;
  const textInputTokens = inputDetails.text_tokens ?? Math.max(inputTokens - audioInputTokens, 0);
  const audioOutputTokens = outputDetails.audio_tokens ?? 0;
  const textOutputTokens = outputDetails.text_tokens ?? Math.max(outputTokens - audioOutputTokens, 0);

  return {
    inputTokens,
    outputTokens,
    audioInputTokens,
    textInputTokens,
    audioOutputTokens,
    textOutputTokens,
    cachedInputTokens: inputDetails.cached_tokens ?? 0,
  };
}

function addUsage(total, usage, estimatedCost) {
  total.responses += 1;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.audioInputTokens += usage.audioInputTokens;
  total.textInputTokens += usage.textInputTokens;
  total.audioOutputTokens += usage.audioOutputTokens;
  total.textOutputTokens += usage.textOutputTokens;
  total.cachedInputTokens += usage.cachedInputTokens;
  total.estimatedModelCostUsd += estimatedCost;
}

function estimateUsageCost(usage) {
  if (!CONFIG.COST_LOGGING_ENABLED) {
    return 0;
  }

  return (
    (usage.textInputTokens * CONFIG.PRICING.TEXT_INPUT_PER_1M) +
    (usage.textOutputTokens * CONFIG.PRICING.TEXT_OUTPUT_PER_1M) +
    (usage.audioInputTokens * CONFIG.PRICING.AUDIO_INPUT_PER_1M) +
    (usage.audioOutputTokens * CONFIG.PRICING.AUDIO_OUTPUT_PER_1M)
  ) / 1_000_000;
}

function logUsageTotals(session, label) {
  if (!CONFIG.COST_LOGGING_ENABLED || !session?.usage || session.usage.responses === 0) {
    return;
  }

  const total = session.usage;
  console.log(`[OpenAI Realtime] ${label} responses=${total.responses} input=${total.inputTokens} output=${total.outputTokens} audioIn=${total.audioInputTokens} textIn=${total.textInputTokens} audioOut=${total.audioOutputTokens} textOut=${total.textOutputTokens} cachedIn=${total.cachedInputTokens} cumulativeEstimatedCost=$${formatUsd(total.estimatedModelCostUsd)}`);
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function describeMcpStatus() {
  if (!CONFIG.ZOOM_MCP_ACCESS_TOKEN) {
    return 'disabled - ZOOM_MCP_ACCESS_TOKEN not set';
  }
  if (CONFIG.ZOOM_MCP_TOKEN_STATUS?.expired) {
    return `disabled - ZOOM_MCP_ACCESS_TOKEN expired at ${CONFIG.ZOOM_MCP_TOKEN_STATUS.expiresAtIso}`;
  }
  if (CONFIG.ZOOM_MCP_TOKEN_STATUS?.expiresAtIso) {
    return `enabled - token expires at ${CONFIG.ZOOM_MCP_TOKEN_STATUS.expiresAtIso}`;
  }
  return 'enabled';
}

function inspectJwtExpiration(token) {
  if (!token || token.split('.').length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1]));
    if (!payload.exp) {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    return {
      exp: payload.exp,
      expired: payload.exp <= nowSeconds,
      expiresAtIso: new Date(payload.exp * 1000).toISOString(),
    };
  } catch (error) {
    console.warn(`[OpenAI Realtime] Could not inspect Zoom MCP token expiration: ${error.message}`);
    return null;
  }
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function stripBearerPrefix(value) {
  return String(value || '').trim().replace(/^Bearer\s+/i, '');
}

function parseNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatUsd(value) {
  return value.toFixed(3);
}

function safeStringify(value) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function summarizeMcpOutputForLog(output, rawOutput = safeStringify(output)) {
  const parsed = parseJsonMaybe(output);
  const byteLength = Buffer.byteLength(rawOutput, 'utf8');
  const prefix = `bytes=${byteLength}`;

  if (parsed === null || parsed === undefined) {
    return `${prefix} empty`;
  }

  if (Array.isArray(parsed)) {
    return `${prefix} arrayItems=${parsed.length} preview=${previewText(summarizeArray(parsed))}`;
  }

  if (typeof parsed === 'object') {
    return `${prefix} ${summarizeObject(parsed)}`;
  }

  return `${prefix} preview=${previewText(String(parsed))}`;
}

function parseJsonMaybe(value) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeObject(value) {
  const keys = Object.keys(value);
  const interestingCounts = [];
  const interestingPreviews = [];

  for (const key of keys) {
    const child = value[key];
    if (Array.isArray(child)) {
      interestingCounts.push(`${key}=${child.length}`);
      if (interestingPreviews.length < 2) {
        interestingPreviews.push(`${key}: ${summarizeArray(child)}`);
      }
    } else if (child && typeof child === 'object') {
      const nestedKeys = Object.keys(child);
      interestingCounts.push(`${key}{${nestedKeys.slice(0, 5).join(',')}}`);
    } else if (child !== null && child !== undefined && interestingPreviews.length < 3) {
      interestingPreviews.push(`${key}=${String(child)}`);
    }
  }

  const keyPreview = keys.slice(0, 8).join(',');
  const counts = interestingCounts.length ? ` counts=${interestingCounts.slice(0, 6).join(' ')}` : '';
  const preview = interestingPreviews.length ? ` preview=${previewText(interestingPreviews.join(' | '))}` : '';
  return `objectKeys=${keyPreview}${counts}${preview}`;
}

function summarizeArray(items) {
  return items.slice(0, 3).map((item, index) => {
    if (!item || typeof item !== 'object') {
      return `${index + 1}. ${String(item)}`;
    }

    const title = firstString(item, ['topic', 'title', 'name', 'file_name', 'meeting_topic', 'summary']);
    const id = firstString(item, ['meeting_uuid', 'meeting_id', 'meeting_number', 'file_id', 'id', 'recording_id']);
    const time = firstString(item, ['start_time', 'schedule_start_time', 'create_time', 'modify_time', 'recording_start']);
    return `${index + 1}. ${[title, id && `id=${id}`, time].filter(Boolean).join(' ') || previewText(safeStringify(item), 120)}`;
  }).join('; ');
}

function firstString(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== null && candidate !== undefined && String(candidate).trim() !== '') {
      return String(candidate);
    }
  }
  return '';
}

function previewText(value, maxLength = CONFIG.MCP_OUTPUT_PREVIEW_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
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

export { CONFIG };
