import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';
import express, { type Request } from 'express';
import WebSocket from 'ws';
import { installGracefulShutdown } from './gracefulShutdown.js';
import { TranscriptBatcher } from './transcriptBatcher.js';
import { isWebhookTenantAuthorized, safeErrorCode, verifyZoomWebhook } from './webhookSecurity.js';

dotenv.config({ quiet: true });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} has an invalid value`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

const config = {
  port: integer('PORT', 3000, 1),
  webhookPath: process.env.WEBHOOK_PATH?.trim() || '/webhook',
  webhookToleranceSeconds: integer('WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', 300, 0),
  zoomSecretToken: required('ZOOM_SECRET_TOKEN'),
  zoomClientId: required('ZOOM_CLIENT_ID'),
  zoomClientSecret: required('ZOOM_CLIENT_SECRET'),
  zoomAccountId: required('ZOOM_ACCOUNT_ID'),
  routerUrl: process.env.LLM_MCP_SERVER_URL?.trim() || 'http://127.0.0.1:3100/mcp',
  routerToken: required('LLM_ROUTER_AUTH_TOKEN'),
  allowInsecureRouterHttp: boolean('ALLOW_INSECURE_ROUTER_HTTP', false),
  transcriptBatchWindowMs: integer('TRANSCRIPT_BATCH_WINDOW_MS', 5000, 100),
  transcriptBatchMaxCharacters: integer('TRANSCRIPT_BATCH_MAX_CHARACTERS', 12000, 1),
  maxDuplicateRetries: integer('MAX_DUPLICATE_SIGNAL_RETRIES', 3, 0),
  duplicateRetryDelayMs: integer('INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS', 1500, 100)
};

const routerUrl = new URL(config.routerUrl);
const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(routerUrl.hostname);
if (routerUrl.protocol !== 'https:' && !isLoopback && !config.allowInsecureRouterHttp) {
  throw new Error('LLM_MCP_SERVER_URL must use HTTPS outside loopback; explicitly opt in only on a trusted private network');
}

type RawRequest = Request & { rawBody?: Buffer };
type StreamState = {
  accountId: string;
  meetingId: string;
  streamId: string;
  serverUrl: string;
  signaling?: WebSocket;
  media?: WebSocket;
  retryCount: number;
  retryTimer?: NodeJS.Timeout;
  stopped: boolean;
};

const streams = new Map<string, StreamState>();
const routerTransport = new StreamableHTTPClientTransport(routerUrl, {
  requestInit: { headers: { Authorization: `Bearer ${config.routerToken}` } }
});
const routerClient = new Client({ name: 'zoom-rtms-transcript-client', version: '2.0.0' });
await routerClient.connect(routerTransport);

function audit(event: string, fields: Record<string, string | number> = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: 'rtms-mcp-client', event, ...fields }));
}

async function sendTranscript(streamId: string, transcript: string): Promise<void> {
  const state = streams.get(streamId);
  if (!state || state.stopped) return;
  const requestId = crypto.randomUUID();
  audit('transcript_route', { requestId, outcome: 'started', inputCharacters: transcript.length });
  try {
    const result = await routerClient.callTool({
      name: 'ask-llm',
      arguments: { message: transcript, tenantId: state.accountId }
    });
    audit('transcript_route', { requestId, outcome: result.isError ? 'error' : 'success' });
  } catch (error) {
    audit('transcript_route', { requestId, outcome: 'error', errorCode: safeErrorCode(error) });
  }
}

const transcriptBatcher = new TranscriptBatcher({
  windowMs: config.transcriptBatchWindowMs,
  maxCharacters: config.transcriptBatchMaxCharacters,
  onFlush: sendTranscript
});

function zoomSocketUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Zoom WebSocket URL is missing');
  const url = new URL(value);
  if (url.protocol !== 'wss:' || !(url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us'))) {
    throw new Error('Zoom WebSocket URL is not an allowed secure Zoom endpoint');
  }
  return url.toString();
}

function generateSignature(meetingId: string, streamId: string): string {
  return crypto
    .createHmac('sha256', config.zoomClientSecret)
    .update(`${config.zoomClientId},${meetingId},${streamId}`)
    .digest('hex');
}

function closeStream(streamId: string): void {
  const state = streams.get(streamId);
  if (!state) return;
  state.stopped = true;
  if (state.retryTimer) clearTimeout(state.retryTimer);
  transcriptBatcher.discard(streamId);
  state.signaling?.close(1000, 'RTMS stopped');
  state.media?.close(1000, 'RTMS stopped');
  streams.delete(streamId);
  audit('rtms_stream', { outcome: 'stopped' });
}

function connectMedia(state: StreamState, mediaUrl: string): void {
  if (state.stopped || state.media?.readyState === WebSocket.OPEN) return;
  const ws = new WebSocket(zoomSocketUrl(mediaUrl));
  state.media = ws;

  ws.on('open', () => {
    ws.send(JSON.stringify({
      msg_type: 3,
      protocol_version: 1,
      meeting_uuid: state.meetingId,
      rtms_stream_id: state.streamId,
      signature: generateSignature(state.meetingId, state.streamId),
      media_type: 8,
      payload_encryption: false,
      media_params: { transcript: { content_type: 5 } }
    }));
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.msg_type === 4 && message.status_code === 0 && state.signaling?.readyState === WebSocket.OPEN) {
        state.signaling.send(JSON.stringify({ msg_type: 7, rtms_stream_id: state.streamId }));
      } else if (message.msg_type === 12) {
        ws.send(JSON.stringify({ msg_type: 13, timestamp: message.timestamp }));
      } else if (message.msg_type === 17 && typeof message.content?.data === 'string') {
        transcriptBatcher.add(state.streamId, message.content.data);
      }
    } catch (error) {
      audit('media_message', { outcome: 'error', errorCode: safeErrorCode(error) });
    }
  });
  ws.on('error', (error) => audit('media_socket', { outcome: 'error', errorCode: safeErrorCode(error) }));
  ws.on('close', () => {
    if (state.media === ws) state.media = undefined;
  });
}

function scheduleSignalingRetry(state: StreamState): void {
  if (state.stopped || state.retryCount >= config.maxDuplicateRetries) {
    audit('signaling_retry', { outcome: 'exhausted' });
    return;
  }
  const delay = config.duplicateRetryDelayMs * (2 ** state.retryCount);
  state.retryCount += 1;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = undefined;
    connectSignaling(state);
  }, delay);
  state.retryTimer.unref?.();
  audit('signaling_retry', { outcome: 'scheduled', delayMs: delay });
}

function connectSignaling(state: StreamState): void {
  if (state.stopped || (state.signaling && state.signaling.readyState !== WebSocket.CLOSED)) return;
  const ws = new WebSocket(zoomSocketUrl(state.serverUrl));
  state.signaling = ws;

  ws.on('open', () => {
    ws.send(JSON.stringify({
      msg_type: 1,
      protocol_version: 1,
      meeting_uuid: state.meetingId,
      rtms_stream_id: state.streamId,
      sequence: crypto.randomInt(1_000_000_000),
      signature: generateSignature(state.meetingId, state.streamId),
      buffer_data: false
    }));
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (message.msg_type === 2 && message.status_code === 0) {
        state.retryCount = 0;
        const mediaUrl = message.media_server?.server_urls?.transcript || message.media_server?.server_urls?.all;
        connectMedia(state, mediaUrl);
      } else if (message.msg_type === 2) {
        const duplicate = String(message.reason || '').toLowerCase().includes('duplicate signal request');
        audit('signaling_handshake', { outcome: 'error', statusCode: Number(message.status_code) || -1 });
        ws.close();
        if (duplicate) scheduleSignalingRetry(state);
      } else if (message.msg_type === 12) {
        ws.send(JSON.stringify({ msg_type: 13, timestamp: message.timestamp }));
      }
    } catch (error) {
      audit('signaling_message', { outcome: 'error', errorCode: safeErrorCode(error) });
    }
  });
  ws.on('error', (error) => audit('signaling_socket', { outcome: 'error', errorCode: safeErrorCode(error) }));
  ws.on('close', () => {
    if (state.signaling === ws) state.signaling = undefined;
  });
}

function handleWebhookEvent(event: string, payload: Record<string, unknown>): void {
  if (event === 'meeting.rtms_started') {
    const streamId = String(payload.rtms_stream_id || '');
    const meetingId = String(payload.meeting_uuid || '');
    if (!streamId || !meetingId || streams.has(streamId)) return;
    try {
      const state: StreamState = {
        accountId: String(payload.account_id),
        meetingId,
        streamId,
        serverUrl: zoomSocketUrl(payload.server_urls),
        retryCount: 0,
        stopped: false
      };
      streams.set(streamId, state);
      connectSignaling(state);
      audit('rtms_stream', { outcome: 'started' });
    } catch (error) {
      audit('rtms_stream', { outcome: 'error', errorCode: safeErrorCode(error) });
    }
  } else if (event === 'meeting.rtms_stopped') {
    closeStream(String(payload.rtms_stream_id || ''));
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => { (req as RawRequest).rawBody = Buffer.from(buffer); }
}));

app.post(config.webhookPath, (req: RawRequest, res) => {
  const { event, payload } = req.body || {};
  if (event === 'endpoint.url_validation' && payload?.plainToken) {
    const encryptedToken = crypto.createHmac('sha256', config.zoomSecretToken).update(payload.plainToken).digest('hex');
    res.json({ plainToken: payload.plainToken, encryptedToken });
    return;
  }

  if (!verifyZoomWebhook(req.headers, req.rawBody, config.zoomSecretToken, config.webhookToleranceSeconds)) {
    audit('webhook', { outcome: 'authentication_denied' });
    res.status(401).json({ error: 'invalid_zoom_webhook' });
    return;
  }
  if (typeof event !== 'string' || !payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'invalid_webhook_payload' });
    return;
  }
  const streamId = String(payload.rtms_stream_id || '');
  if (!isWebhookTenantAuthorized(event, payload, config.zoomAccountId, streams.has(streamId))) {
    audit('webhook', { outcome: 'tenant_denied' });
    res.status(403).json({ error: 'tenant_not_authorized' });
    return;
  }

  res.sendStatus(200);
  setImmediate(() => handleWebhookEvent(event, payload));
});
app.get('/health', (_req, res) => res.json({ status: 'ok', routerConnected: true, activeStreams: streams.size }));

const httpServer = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[RTMSMCPClient] Listening on port ${config.port}`);
});

installGracefulShutdown('rtms-mcp-client', httpServer, async () => {
  transcriptBatcher.stop();
  for (const streamId of [...streams.keys()]) closeStream(streamId);
  await routerClient.close();
});
