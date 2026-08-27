import dotenv from 'dotenv';
import express from 'express';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

function requireEnvironmentVariable(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535. Received: ${value}`);
  }
  return port;
}

function enumName(values, code) {
  const match = Object.entries(values).find(([, value]) => value === code);
  return match?.[0] || `UNKNOWN(${code ?? 'unset'})`;
}

function participantLabel(participant, fallbackName, fallbackId) {
  const name = participant?.user_name ?? participant?.userName ?? fallbackName;
  const id = participant?.user_id ?? participant?.userId ?? fallbackId;

  if (name && id != null) return `${name} (${id})`;
  if (name) return name;
  if (id != null) return `user ${id}`;
  return 'unknown user';
}

const appConfig = {
  port: parsePort(process.env.PORT || '3000'),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  printFullPayload: process.env.PRINT_FULL_CHAT_PAYLOAD === 'true'
};

const rtmsConfig = {
  logging: {
    enabled: true,
    level: process.env.RTMS_LOG_LEVEL || 'info',
    console: true,
    file: false
  },
  mediaTypes: RTMSManager.MEDIA.CHAT,
  useUnifiedMediaSocket: process.env.MEDIA_SOCKET_CONNECTION_MODE === 'unified',
  credentials: {
    meeting: {
      clientId: requireEnvironmentVariable('ZOOM_CLIENT_ID'),
      clientSecret: requireEnvironmentVariable('ZOOM_CLIENT_SECRET'),
      secretToken: requireEnvironmentVariable('ZOOM_SECRET_TOKEN')
    }
  },
  mediaParams: {
    chat: {
      contentType: RTMSManager.MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT
    }
  }
};

const app = express();
const server = http.createServer(app);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mediaType: 'chat' });
});

await RTMSManager.init(rtmsConfig);

const webhookManager = new WebhookManager({
  config: {
    webhookPath: appConfig.webhookPath,
    zoomSecretToken: rtmsConfig.credentials.meeting.secretToken
  },
  app
});

webhookManager.on('event', (event, payload) => {
  console.log(`[ChatSample] Webhook event: ${event}`);
  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

const { chatOperationTypes, chatSessionTypes } = RTMSManager.PROTOCOL;

RTMSManager.on('chat', (chat) => {
  const {
    text,
    userId,
    userName,
    sender,
    receiver,
    chatSession,
    operationType,
    messageId,
    parentMessageId,
    files = [],
    deleteFileIdList = [],
    timestamp,
    meetingId,
    streamId,
    productType
  } = chat;

  const senderDisplay = participantLabel(sender, userName, userId);
  const receiverDisplay = receiver ? participantLabel(receiver) : null;
  const operation = enumName(chatOperationTypes, operationType);
  const session = enumName(chatSessionTypes, chatSession?.type);
  const destination = receiverDisplay ? ` -> ${receiverDisplay}` : '';

  console.log(`[Chat] ${operation} ${senderDisplay}${destination}: ${text}`);
  console.log('[Chat] Metadata:', {
    session,
    sessionId: chatSession?.id ?? null,
    messageId,
    parentMessageId,
    timestamp,
    attachments: files,
    deletedFileIds: deleteFileIdList,
    meetingId,
    streamId,
    productType
  });

  if (appConfig.printFullPayload) {
    console.log('[Chat] Full payload:', JSON.stringify(chat, null, 2));
  }
});

RTMSManager.on('meeting.rtms_started', (payload) => {
  console.log('[ChatSample] RTMS started:', {
    meetingId: payload.meeting_uuid,
    streamId: payload.rtms_stream_id
  });
});

RTMSManager.on('meeting.rtms_stopped', (payload) => {
  console.log('[ChatSample] RTMS stopped:', {
    meetingId: payload.meeting_uuid,
    streamId: payload.rtms_stream_id,
    stopReason: payload.stop_reason
  });
});

RTMSManager.on('error', (error) => {
  console.error('[ChatSample] RTMS error:', error?.message || String(error));
});

server.listen(appConfig.port, () => {
  console.log(`[ChatSample] Listening on port ${appConfig.port}`);
  console.log(`[ChatSample] Webhook endpoint: ${appConfig.webhookPath}`);
  console.log('[ChatSample] Waiting for RTMS chat messages');
});

installGracefulShutdown({ name: 'ChatSample', cleanup: async () => {
  await closeHttpServer(server);
  await RTMSManager.stop();
} });
