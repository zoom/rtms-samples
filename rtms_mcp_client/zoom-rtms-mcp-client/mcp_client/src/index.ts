// === mcp-client/src/index.ts ===
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import { installGracefulShutdown } from './gracefulShutdown';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN;
const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const LLM_MCP_SERVER_URL=process.env.LLM_MCP_SERVER_URL || 'http://localhost:3000/mcp';

app.use(cors());
app.use(express.json({
  verify: (req, _res, buffer) => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
  },
}));


let buffer1: string | null = null;
let flushTimer: NodeJS.Timeout | null = null;
const MAX_WAIT_MS = 5000;

type ConnectionGroup = {
  signaling?: WebSocket;
  media?: WebSocket;
};

const activeConnections = new Map<string, ConnectionGroup>();
const signalingLocksByStreamId = new Set<string>();
const duplicateSignalRetryCounts = new Map<string, number>();
const duplicateSignalRetryTimers = new Map<string, NodeJS.Timeout>();
const streamIdToMeetingId = new Map<string, string>();
let mcpClient: Client | null = null;
let isConnected = false;

const MAX_DUPLICATE_SIGNAL_RETRIES = Number(process.env.MAX_DUPLICATE_SIGNAL_RETRIES || 3);
const INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS = Number(process.env.INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS || 1500);
const configuredWebhookTolerance = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS || 300);
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS =
  Number.isFinite(configuredWebhookTolerance) && configuredWebhookTolerance >= 0
    ? configuredWebhookTolerance
    : 300;

function verifyZoomWebhook(req: Request): boolean {
  if (!ZOOM_SECRET_TOKEN) return false;
  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (typeof signature !== 'string' || typeof timestamp !== 'string' || !rawBody) return false;
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isFinite(timestampSeconds) ||
    (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS > 0 &&
      Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS)
  ) return false;

  const expected = `v0=${crypto
    .createHmac('sha256', ZOOM_SECRET_TOKEN)
    .update(`v0:${timestamp}:${rawBody.toString('utf8')}`)
    .digest('hex')}`;
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

async function initMcpClient() {
  try {
    const transport = new StreamableHTTPClientTransport(new URL(LLM_MCP_SERVER_URL));
    mcpClient = new Client({ name: 'zoom-client', version: '1.0.0' });
    await mcpClient.connect(transport);
    isConnected = true;
    console.log('[MCP Client] Connected to MCP server');
  } catch (err) {
    console.error('[MCP Client] MCP connection error:', err);
    process.exit(1);
  }
}


initMcpClient().catch(console.error);

const webhookHandler: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { event, payload } = req.body;

    if (event === 'endpoint.url_validation' && payload?.plainToken) {
      const hash = crypto
        .createHmac('sha256', ZOOM_SECRET_TOKEN!)
        .update(payload.plainToken)
        .digest('hex');
      res.json({ plainToken: payload.plainToken, encryptedToken: hash });
      return;
    }

    if (!verifyZoomWebhook(req)) {
      res.status(ZOOM_SECRET_TOKEN ? 401 : 500).json({ error: 'invalid_zoom_webhook' });
      return;
    }

    if (event === 'meeting.rtms_started') {
      const { meeting_uuid, rtms_stream_id, server_urls } = payload;
      streamIdToMeetingId.set(rtms_stream_id, meeting_uuid);
      connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    if (event === 'meeting.rtms_stopped') {
      const { meeting_uuid, rtms_stream_id } = payload;
      signalingLocksByStreamId.delete(rtms_stream_id);
      const timer = duplicateSignalRetryTimers.get(rtms_stream_id);
      if (timer) {
        clearTimeout(timer);
        duplicateSignalRetryTimers.delete(rtms_stream_id);
      }
      duplicateSignalRetryCounts.delete(rtms_stream_id);
      streamIdToMeetingId.delete(rtms_stream_id);
      const connections = activeConnections.get(meeting_uuid);
      if (connections) {
        Object.values(connections).forEach((conn) => conn?.close?.());
        activeConnections.delete(meeting_uuid);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
};

app.post(WEBHOOK_PATH, webhookHandler);

function generateSignature(clientId: string, meetingUuid: string, streamId: string, clientSecret: string): string {
  return crypto.createHmac('sha256', clientSecret).update(`${clientId},${meetingUuid},${streamId}`).digest('hex');
}

function connectToSignalingWebSocket(meetingUuid: string, streamId: string, serverUrl: string) {
  const existingConnections = activeConnections.get(meetingUuid);
  if (existingConnections?.signaling && existingConnections.signaling.readyState !== WebSocket.CLOSED) {
    console.warn(`[Signaling] Existing signaling socket already active for stream ${streamId}`);
    return;
  }
  if (signalingLocksByStreamId.has(streamId)) {
    console.warn(`[Signaling] Duplicate handshake blocked for stream ${streamId}`);
    return;
  }
  signalingLocksByStreamId.add(streamId);

  const ws = new WebSocket(serverUrl);

  if (!activeConnections.has(meetingUuid)) {
    activeConnections.set(meetingUuid, {});
  }
  activeConnections.get(meetingUuid)!.signaling = ws;

  ws.on('open', () => {
    const signature = generateSignature(CLIENT_ID!, meetingUuid, streamId, CLIENT_SECRET!);
    ws.send(JSON.stringify({ msg_type: 1, protocol_version: 1, meeting_uuid: meetingUuid, rtms_stream_id: streamId, sequence: Math.floor(Math.random() * 1e9), signature, buffer_data: false }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.msg_type === 2) {
      if (msg.status_code === 0) {
        duplicateSignalRetryCounts.delete(streamId);
        const timer = duplicateSignalRetryTimers.get(streamId);
        if (timer) {
          clearTimeout(timer);
          duplicateSignalRetryTimers.delete(streamId);
        }
        const mediaUrl = msg.media_server?.server_urls?.all;
        if (mediaUrl) connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, ws);
      } else if (String(msg.reason || '').toLowerCase().includes('duplicate signal request')) {
        signalingLocksByStreamId.delete(streamId);
        const retryCount = duplicateSignalRetryCounts.get(streamId) ?? 0;
        if (retryCount < MAX_DUPLICATE_SIGNAL_RETRIES) {
          const delay = INITIAL_DUPLICATE_SIGNAL_RETRY_DELAY_MS * (2 ** retryCount);
          duplicateSignalRetryCounts.set(streamId, retryCount + 1);
          const existingTimer = duplicateSignalRetryTimers.get(streamId);
          if (existingTimer) clearTimeout(existingTimer);
          const timer = setTimeout(() => {
            duplicateSignalRetryTimers.delete(streamId);
            const meetingId = streamIdToMeetingId.get(streamId) || meetingUuid;
            connectToSignalingWebSocket(meetingId, streamId, serverUrl);
          }, delay);
          duplicateSignalRetryTimers.set(streamId, timer);
          console.warn(`[Signaling] Duplicate signal request for stream ${streamId}, retrying in ${delay}ms`);
        } else {
          console.error(`[Signaling] Duplicate signal retries exhausted for stream ${streamId}`);
        }
      } else {
        signalingLocksByStreamId.delete(streamId);
        console.error(`[Signaling] Handshake failed for stream ${streamId}:`, msg);
      }
    }
    if (msg.msg_type === 12) {
      ws.send(JSON.stringify({ msg_type: 13, timestamp: msg.timestamp }));
    }
  });

  ws.on('error', (err) => {
    signalingLocksByStreamId.delete(streamId);
    console.error(err);
  });
  ws.on('close', () => {
    signalingLocksByStreamId.delete(streamId);
    if (activeConnections.has(meetingUuid)) delete activeConnections.get(meetingUuid)!.signaling;
  });
}

function connectToMediaWebSocket(mediaUrl: string, meetingUuid: string, streamId: string, signalingSocket: WebSocket) {
  const mediaWs = new WebSocket(mediaUrl, { rejectUnauthorized: false });

  if (activeConnections.has(meetingUuid)) activeConnections.get(meetingUuid)!.media = mediaWs;

  mediaWs.on('open', () => {
    const signature = generateSignature(CLIENT_ID!, meetingUuid, streamId, CLIENT_SECRET!);
    mediaWs.send(JSON.stringify({
      msg_type: 3,
      protocol_version: 1,
      meeting_uuid: meetingUuid,
      rtms_stream_id: streamId,
      signature,
      media_type: 8,
      payload_encryption: false,
      media_params: {
        transcript: { content_type: 5 }
      }
    }));
  });

  mediaWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.msg_type === 4 && msg.status_code === 0) {
        signalingSocket.send(JSON.stringify({ msg_type: 7, rtms_stream_id: streamId }));
      }

      if (msg.msg_type === 12) {
        mediaWs.send(JSON.stringify({ msg_type: 13, timestamp: msg.timestamp }));
      }


      if (msg.msg_type === 17 && msg.content?.data && isConnected) {
        const newTranscript = msg.content.data.trim();
        if (!newTranscript) return;

        if (!buffer1) {
          // First transcript received
          buffer1 = newTranscript;
          console.log('[Transcript] First part of text is: `', newTranscript, '` Waiting for timeout ',MAX_WAIT_MS,  'ms before sending');
          flushTimer = setTimeout(async () => {
            // Timeout expired, send the first message alone
            try {
              console.log('⏱️ Timeout: sending single transcript:', buffer1);
              const response = await mcpClient!.callTool({
                name: 'ask-llm',
                arguments: { message: buffer1 }
              });
              console.log('📬 LLM response:', response);
              //const tools = await mcpClient!.listTools();
              //console.log('[MCP-Client] Available tools:', tools);
            } catch (err) {
              console.error('❌ Tool call failed:', err);
            }

            buffer1 = null;
            flushTimer = null;
          }, MAX_WAIT_MS);

        } else {
          console.log('[Transcript] Second part of text is: ', newTranscript);
          // Second transcript arrived in time
          const combined = `${buffer1} ${newTranscript}`.trim();

          // Clear timeout and buffer
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = null;
          buffer1 = null;

          try {
            console.log('[Transcript] Combined transcript sent to LLM:', combined);
            const response = await mcpClient!.callTool({
              name: 'ask-llm',
              arguments: { message: combined }
            });

            console.log('📬 LLM response:', response);
          } catch (err) {
            console.error('❌ Tool call failed:', err);
          }
        }
      }
    } catch (err) {
      console.error('❌ Media message parse error:', err);
    }
  });

  mediaWs.on('error', console.error);
  mediaWs.on('close', () => {
    if (activeConnections.has(meetingUuid)) delete activeConnections.get(meetingUuid)!.media;
  });
}

const httpServer = app.listen(port, () => {
  console.log(`🚀 RTMS MCP Client running at http://localhost:${port}`);
  console.log(`📩 Webhook listening at ${WEBHOOK_PATH}`);
});

installGracefulShutdown('rtms-mcp-client', httpServer, async () => {
  for (const connections of activeConnections.values()) {
    connections.signaling?.close(1000, 'Server shutdown');
    connections.media?.close(1000, 'Server shutdown');
  }
  activeConnections.clear();
  await mcpClient?.close();
});
