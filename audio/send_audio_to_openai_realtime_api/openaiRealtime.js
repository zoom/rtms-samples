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

const CONFIG = {
  ENABLED: process.env.OPENAI_REALTIME_ENABLED !== 'false',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  MODEL: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
  SAFETY_IDENTIFIER: process.env.OPENAI_SAFETY_IDENTIFIER || '',
  SOURCE_SAMPLE_RATE: Number.parseInt(process.env.AUDIO_SAMPLE_RATE || '48000', 10),
  TARGET_SAMPLE_RATE: Number.parseInt(process.env.OPENAI_AUDIO_SAMPLE_RATE || '24000', 10),
  TARGET_CHUNK_DURATION_MS: Number.parseInt(process.env.TARGET_CHUNK_DURATION_MS || '100', 10),
  MAX_QUEUED_AUDIO_BYTES: Number.parseInt(process.env.OPENAI_MAX_QUEUED_AUDIO_BYTES || '2097152', 10),
  RECONNECT_DELAY_MS: Number.parseInt(process.env.OPENAI_REALTIME_RECONNECT_DELAY_MS || '2000', 10),
  TRANSCRIPTION_ENABLED: process.env.OPENAI_REALTIME_TRANSCRIPTION_ENABLED !== 'false',
  TRANSCRIPTION_MODEL: process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
  ZOOM_MCP_SERVER_LABEL: process.env.ZOOM_MCP_SERVER_LABEL || 'zoom',
  ZOOM_MCP_SERVER_URL: process.env.ZOOM_MCP_SERVER_URL || 'https://mcp.zoom.us/mcp/zoom/streamable',
  ZOOM_MCP_ACCESS_TOKEN: stripBearerPrefix(process.env.ZOOM_MCP_ACCESS_TOKEN || ''),
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

if (CONFIG.ENABLED && !CONFIG.OPENAI_API_KEY) {
  console.error('[OpenAI Realtime] OPENAI_API_KEY is required when OPENAI_REALTIME_ENABLED is true');
  process.exit(1);
}

if (CONFIG.ENABLED && CONFIG.TARGET_SAMPLE_RATE !== 24000) {
  console.error('[OpenAI Realtime] OPENAI_AUDIO_SAMPLE_RATE must be 24000 for Realtime pcm16 input');
  process.exit(1);
}

console.log('[OpenAI Realtime] Bridge initialized');
console.log(`[OpenAI Realtime] Model: ${CONFIG.MODEL}`);
console.log(`[OpenAI Realtime] Audio: ${CONFIG.SOURCE_SAMPLE_RATE}Hz RTMS -> ${CONFIG.TARGET_SAMPLE_RATE}Hz OpenAI, chunk ${CONFIG.TARGET_CHUNK_DURATION_MS}ms`);
console.log(`[OpenAI Realtime] Zoom MCP: ${CONFIG.ZOOM_MCP_ACCESS_TOKEN ? 'enabled' : 'disabled - ZOOM_MCP_ACCESS_TOKEN not set'}`);
console.log(`[OpenAI Realtime] Zoom MCP allowed tools: ${CONFIG.ZOOM_MCP_ALLOWED_TOOLS.join(', ') || 'all server tools'}`);
if (CONFIG.COST_LOGGING_ENABLED) {
  console.log(`[OpenAI Realtime] Cost logging: enabled, model-token estimate only, pricing per 1M tokens textIn=$${CONFIG.PRICING.TEXT_INPUT_PER_1M} textOut=$${CONFIG.PRICING.TEXT_OUTPUT_PER_1M} audioIn=$${CONFIG.PRICING.AUDIO_INPUT_PER_1M} audioOut=$${CONFIG.PRICING.AUDIO_OUTPUT_PER_1M}`);
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
    usage: createUsageLedger(),
  };

  sessions.set(meetingUuid, session);
  console.log(`[OpenAI Realtime] Initializing session for meeting ${meetingUuid}`);
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
    console.log(`[OpenAI Realtime] [${meetingUuid.slice(0, 8)}] chunks=${session.chunkCount} rtmsBytes=${session.totalSourceBytes} openaiBytes=${session.sentAudioBytes} elapsed=${elapsedSeconds}s lastUser=${userId}`);
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

  flushRemainingSourceAudio(session);

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
    output_modalities: ['text'],
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
          silence_duration_ms: 600,
          create_response: true,
          interrupt_response: false,
        },
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
    'You are a realtime Zoom meeting assistant connected to live RTMS meeting audio.',
    'Listen for explicit requests related to Zoom content, meetings, recordings, meeting assets, Zoom Docs, or Team Chat.',
    'Use the Zoom MCP tools only when the speaker asks for Zoom information or asks you to retrieve, search, summarize, or create Zoom-related content.',
    'Use search_meetings when the user asks about past, recent, upcoming, or named meetings. Ask for a date range if the request is too broad.',
    'Use get_meeting_assets after you have a specific meeting ID or UUID and the user asks for summaries, notes, participants, agenda docs, whiteboards, recordings, or meeting-linked docs.',
    'Use recordings_list when the user asks to find cloud recordings by date, host, or meeting number. Use get_recording_resource when the user asks what was said in a recording, wants transcript details, next steps, summaries, or playback links.',
    'Use search_zoom for broad searches across Zoom Docs, meeting notes, or Team Chat. Use get_file_content only after selecting a specific Zoom Doc file ID.',
    'Use create_new_file_with_markdown only when the user explicitly asks you to create, save, or write a Zoom Doc. Use concise Markdown and choose a clear file name.',
    'Summarize MCP results before responding. Do not dump raw JSON, full transcripts, exhaustive participant lists, or complete search payloads unless the user explicitly asks for raw output.',
    'If multiple MCP results match, summarize the best matches in at most five concise bullets and ask the user to choose instead of guessing.',
    'When summarizing recordings, transcripts, or meeting assets, include only the most relevant decisions, action items, dates, names, and links. Keep sensitive or unrelated details out of the response.',
    'Do not create or modify Zoom content unless a write tool is explicitly allowed and the user clearly asks for that write action.',
    'When the audio is ordinary conversation, status chatter, greetings, filler, or unrelated meeting discussion, do not call tools.',
    'Keep responses concise and text-only. Do not attempt to produce audio.',
    'If the transcript is unclear or lacks required details such as a date range, ask a short clarification instead of guessing.',
    `Current RTMS meeting id: ${meetingUuid}`,
  ].join(' ');
}

function buildTools() {
  if (!CONFIG.ZOOM_MCP_ACCESS_TOKEN) {
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
    console.error(`[OpenAI Realtime] Failed to parse event: ${error.message}`);
    return;
  }

  switch (event.type) {
    case 'session.created':
      console.log(`[OpenAI Realtime] Session created for meeting ${session.meetingUuid}`);
      break;
    case 'session.updated':
      session.sessionReady = true;
      console.log(`[OpenAI Realtime] Session updated for meeting ${session.meetingUuid}`);
      flushQueuedAudio(session);
      break;
    case 'error':
      console.error(`[OpenAI Realtime] API error: ${event.error?.message || JSON.stringify(event.error || event)}`);
      break;
    case 'conversation.item.input_audio_transcription.completed':
      console.log(`[OpenAI Realtime] Transcript: ${event.transcript || ''}`);
      break;
    case 'mcp_list_tools.in_progress':
      console.log(`[OpenAI Realtime] Listing MCP tools for item ${event.item_id}`);
      break;
    case 'mcp_list_tools.completed':
      console.log(`[OpenAI Realtime] MCP tool listing complete for item ${event.item_id}`);
      break;
    case 'mcp_list_tools.failed':
      console.error(`[OpenAI Realtime] MCP tool listing failed for item ${event.item_id}`);
      break;
    case 'conversation.item.done':
      handleConversationItemDone(event.item);
      break;
    case 'response.mcp_call_arguments.done':
      console.log(`[OpenAI Realtime] MCP call arguments: ${event.arguments}`);
      break;
    case 'response.mcp_call.in_progress':
      console.log(`[OpenAI Realtime] Running MCP tool for item ${event.item_id}`);
      break;
    case 'response.mcp_call.failed':
      console.error(`[OpenAI Realtime] MCP tool call failed for item ${event.item_id}`);
      break;
    case 'response.output_text.delta':
      process.stdout.write(event.delta || '');
      break;
    case 'response.output_text.done':
      process.stdout.write('\n');
      break;
    case 'response.output_item.done':
      handleOutputItemDone(event.item);
      break;
    case 'response.done':
      logUsage(session, event.response?.usage);
      break;
    default:
      if (process.env.OPENAI_REALTIME_DEBUG_EVENTS === 'true') {
        console.log(`[OpenAI Realtime] Event: ${event.type}`);
      }
      break;
  }
}

function handleConversationItemDone(item) {
  if (!item) {
    return;
  }

  if (item.type === 'mcp_list_tools') {
    const names = (item.tools || []).map((tool) => tool.name).join(', ');
    console.log(`[OpenAI Realtime] MCP tools ready on ${item.server_label}: ${names}`);
  }

  if (item.type === 'mcp_approval_request') {
    console.log(`[OpenAI Realtime] MCP approval required for ${item.server_label}.${item.name}: ${item.arguments}`);
    console.log('[OpenAI Realtime] This sample logs approval requests but does not auto-approve them.');
  }
}

function handleOutputItemDone(item) {
  if (!item) {
    return;
  }

  if (item.type === 'mcp_call') {
    const rawOutput = safeStringify(item.output);
    console.log(`[OpenAI Realtime] MCP output from ${item.server_label}.${item.name}: ${summarizeMcpOutputForLog(item.output, rawOutput)}`);
    if (CONFIG.LOG_RAW_MCP_OUTPUT) {
      console.log(`[OpenAI Realtime] MCP raw output from ${item.server_label}.${item.name}: ${rawOutput}`);
    }
    return;
  }

  if (item.type === 'message') {
    const text = extractOutputText(item);
    if (text) {
      console.log(`[OpenAI Realtime] Assistant: ${text}`);
    }
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
    console.error(`[OpenAI Realtime] Failed to send audio: ${error.message}`);
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

function sendEvent(session, event) {
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error('OpenAI Realtime WebSocket is not open');
  }
  session.ws.send(JSON.stringify(event));
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

function extractOutputText(item) {
  return (item.content || [])
    .filter((part) => part.type === 'output_text' || part.type === 'text')
    .map((part) => part.text || '')
    .join('');
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

export { CONFIG };
