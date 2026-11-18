import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import { PhoneTranscript } from './phoneTranscript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

for (const name of ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_SECRET_TOKEN']) {
  if (!process.env[name]) throw new Error(`${name} is required; copy .env.example to .env`);
}

const port = Number(process.env.PORT) || 3000;
const logTranscripts = String(process.env.LOG_TRANSCRIPT_TEXT || 'true').toLowerCase() !== 'false';

// PRESETS.PHONE requests audio + transcript over RTMS protocol V2. Phone
// streams start from phone.call_rtms_started webhooks; RTMSManager handles the
// signaling, media sockets, keep-alives, client-ready ACKs, and reconnection.
await RTMSManager.init({
  ...RTMSManager.PRESETS.PHONE,
  logging: { enabled: true, logDir: path.join(__dirname, 'logs'), console: true },
  credentials: {
    phone: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      secretToken: process.env.ZOOM_SECRET_TOKEN
    }
  }
});

const transcripts = new Map();
const audioBytesByStream = new Map();

function transcriptFor(streamId) {
  if (!transcripts.has(streamId)) transcripts.set(streamId, new PhoneTranscript());
  return transcripts.get(streamId);
}

RTMSManager.on('transcript', (event) => {
  if (event.productType !== 'phone') return;
  const { action, sentence } = transcriptFor(event.streamId).apply(event);
  const speaker = sentence.speaker || sentence.channelId || 'unknown';
  const text = logTranscripts ? sentence.text : `[${sentence.text.length} chars]`;
  console.log(`[Phone] ${event.rtmsId} ${action} #${sentence.sentenceId ?? '-'} ${speaker}: ${text}`);
});

RTMSManager.on('audio', ({ productType, streamId, channelId, buffer }) => {
  if (productType !== 'phone') return;
  // Phone audio is base64-decoded raw PCM per channel. Count bytes here; route
  // buffers by channelId to a recorder or speech service in a real app.
  const byChannel = audioBytesByStream.get(streamId) || new Map();
  byChannel.set(channelId, (byChannel.get(channelId) || 0) + buffer.length);
  audioBytesByStream.set(streamId, byChannel);
});

RTMSManager.on('phone_call_info_updated', ({ rtmsId, hostChannelId, participants }) => {
  const people = participants.map((p) => `${p.name || 'unknown'} (${p.channelId}${p.channelId === hostChannelId ? ', host' : ''})`);
  console.log(`[Phone] ${rtmsId} participants: ${people.join(', ')}`);
});
RTMSManager.on('phone_call_hold', ({ rtmsId }) => console.log(`[Phone] ${rtmsId} call on hold`));
RTMSManager.on('phone_call_resume', ({ rtmsId }) => console.log(`[Phone] ${rtmsId} call resumed`));
RTMSManager.on('phone_call_transfer_completed', ({ rtmsId, transferType, transferResult }) => {
  console.log(`[Phone] ${rtmsId} transfer completed: ${transferType}`, transferResult);
});

function summarizeAndRelease(streamId, reason) {
  const transcript = transcripts.get(streamId);
  const audio = audioBytesByStream.get(streamId);
  if (transcript || audio) {
    const audioSummary = audio
      ? Array.from(audio, ([channelId, bytes]) => `${channelId}=${bytes}B`).join(', ')
      : 'none';
    console.log(`[Phone] stream ${streamId} ${reason}: ${transcript?.size ?? 0} sentences, audio ${audioSummary}`);
  }
  transcripts.delete(streamId);
  audioBytesByStream.delete(streamId);
}

RTMSManager.on('phone.call_rtms_stopped', ({ rtms_stream_id, stop_reason }) => {
  summarizeAndRelease(rtms_stream_id, `stopped (stop_reason ${stop_reason ?? 'n/a'})`);
});
RTMSManager.on('error', (error) => console.error('[Phone] RTMS error:', error.toShortString?.() || error.message));

const app = express();
const server = http.createServer(app);

const webhookManager = new WebhookManager({
  config: {
    webhookPath: process.env.WEBHOOK_PATH || '/webhook',
    zoomSecretToken: process.env.ZOOM_SECRET_TOKEN
  },
  app
});
webhookManager.on('event', (event, payload) => RTMSManager.handleEvent(event, payload));
webhookManager.setup();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, activeStreams: RTMSManager.getActiveConnections().length });
});

server.listen(port, () => {
  console.log(`[Phone] Listening on port ${port}; webhook path ${process.env.WEBHOOK_PATH || '/webhook'}`);
});

installGracefulShutdown({
  name: 'Zoom Phone RTMS transcript',
  cleanup: async () => {
    await closeHttpServer(server);
    await RTMSManager.stop();
  }
});
