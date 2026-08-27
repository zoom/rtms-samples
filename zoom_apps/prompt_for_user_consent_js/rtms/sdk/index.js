/**
 * RTMS Server using @zoom/rtms SDK
 * Captures transcripts from Zoom meetings when RTMS is started
 *
 * Flow:
 * 1. Frontend calls zoomSdk.callZoomApi('startRTMS')
 * 2. Zoom sends meeting.rtms_started webhook to this server
 * 3. Server connects to RTMS stream via client.join(payload)
 * 4. Transcripts are received and saved to disk
 * 5. When stopped, meeting.rtms_stopped webhook fires
 */

import rtms from '@zoom/rtms';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.join(__dirname, '../../.env') });

// Store active RTMS clients by meeting UUID
const activeClients = new Map();

// Transcript output directory
const TRANSCRIPT_DIR = path.join(__dirname, '../app/data/transcripts');

// Ensure output directory exists
if (!fs.existsSync(TRANSCRIPT_DIR)) {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
}

console.log(`
============================================================
🎙️  RTMS Server Starting
============================================================
Client ID: ${process.env.ZOOM_APP_CLIENT_ID ? '✅ Set' : '❌ Not set'}
Client Secret: ${process.env.ZOOM_APP_CLIENT_SECRET ? '✅ Set' : '❌ Not set'}
Transcript Directory: ${TRANSCRIPT_DIR}
============================================================
`);

/**
 * Note: We receive webhooks from our backend via POST /webhook endpoint
 * instead of using rtms.onWebhookEvent() which expects direct Zoom webhooks
 */

/**
 * Handle RTMS started webhook
 * Connects to the RTMS stream and starts capturing transcripts
 */
async function handleRTMSStarted(payload) {
  const { meeting_uuid, rtms_stream_id, server_urls } = payload;

  console.log(`Meeting UUID: ${meeting_uuid}`);
  console.log(`Stream ID: ${rtms_stream_id}`);
  console.log(`Server URL: ${server_urls}`);

  // Check if already connected to this meeting
  if (activeClients.has(meeting_uuid)) {
    console.log('⚠️  Already connected to this meeting, skipping');
    return;
  }

  try {
    // Create new RTMS client
    const client = new rtms.Client();
    console.log('✅ RTMS Client created');

    // Initialize transcript file for this meeting
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];

    // Sanitize meeting UUID for use in filename (remove / and other invalid chars)
    const sanitizedUUID = meeting_uuid.replace(/[/\\:*?"<>|]/g, '_');

    const filename = `transcript_${sanitizedUUID}_${timestamp}.txt`;
    const filepath = path.join(TRANSCRIPT_DIR, filename);
    const stream = fs.createWriteStream(filepath, { flags: 'a' });

    console.log(`📝 Transcript file: ${filename}`);

    // Write header
    stream.write(`Zoom Meeting Transcript\n`);
    stream.write(`Meeting UUID: ${meeting_uuid}\n`);
    stream.write(`Started: ${new Date().toISOString()}\n`);
    stream.write(`${'='.repeat(60)}\n\n`);

    // Set up transcript data handler
    client.onTranscriptData((data, timestamp, metadata, user) => {
      try {
        // Convert buffer to UTF-8 string
        const text = data.toString('utf-8');

        // Format: [timestamp] userName: text
        const date = new Date(timestamp);
        const timeStr = date.toISOString();
        const userName = user?.userName || 'Unknown';

        const line = `[${timeStr}] ${userName}: ${text}\n`;

        console.log(`📝 ${line.trim()}`);
        stream.write(line);
      } catch (error) {
        console.error('❌ Error processing transcript:', error);
      }
    });

    // Set up audio data handler (we'll ignore audio data)
    client.onAudioData((data, timestamp, metadata) => {
      // No-op: We're only capturing transcripts
    });

    // Set up video data handler (we'll ignore video data)
    client.onVideoData((data, timestamp, metadata) => {
      // No-op: We're only capturing transcripts
    });

    // Connect to RTMS stream
    console.log('🔌 Connecting to RTMS stream...');
    await client.join({
      meeting_uuid,
      rtms_stream_id,
      server_urls,
      client: process.env.ZOOM_APP_CLIENT_ID,
      secret: process.env.ZOOM_APP_CLIENT_SECRET
    });

    console.log('✅ Connected to RTMS stream successfully');

    // Store client and stream for cleanup
    activeClients.set(meeting_uuid, { client, stream, filename });

    console.log('🎙️  RTMS capture active - listening for transcripts...');
  } catch (error) {
    console.error('❌ Failed to start RTMS capture:', error);
    console.error('   Error details:', error.message);
    console.error('   Make sure Client ID and Secret are correct');
  }
}

/**
 * Handle RTMS stopped webhook
 * Disconnects from stream and saves transcript file
 */
async function handleRTMSStopped(payload) {
  const { meeting_uuid } = payload;

  console.log(`Meeting UUID: ${meeting_uuid}`);

  // Check if we have an active client for this meeting
  if (!activeClients.has(meeting_uuid)) {
    console.log('⚠️  No active RTMS client for this meeting');
    return;
  }

  try {
    const { client, stream, filename } = activeClients.get(meeting_uuid);

    console.log('🛑 Stopping RTMS capture...');

    // Leave the RTMS stream
    await client.leave();
    console.log('✅ Disconnected from RTMS stream');

    // Close transcript file
    stream.write(`\n${'='.repeat(60)}\n`);
    stream.write(`Stopped: ${new Date().toISOString()}\n`);
    stream.end();
    console.log(`✅ Transcript saved: ${filename}`);

    // Remove from active clients
    activeClients.delete(meeting_uuid);

    console.log('✅ RTMS capture stopped successfully');
  } catch (error) {
    console.error('❌ Failed to stop RTMS capture:', error);
    console.error('   Error details:', error.message);
  }
}

/**
 * Handle graceful shutdown
 */
// Express server for health checks and webhook reception
import express from 'express';
import crypto from 'node:crypto';
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'RTMS Server running',
    activeConnections: activeClients.size,
    transcriptDirectory: TRANSCRIPT_DIR
  });
});

// Webhook endpoint for receiving RTMS events from backend
app.post('/webhook', (req, res, next) => {
  const expectedToken = process.env.INTERNAL_WEBHOOK_TOKEN;
  const receivedToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!expectedToken || !receivedToken) {
    return res.status(expectedToken ? 401 : 500).json({ error: 'unauthorized' });
  }
  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(receivedToken);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}, async (req, res) => {
  const { event, payload } = req.body;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📨 Webhook received from backend: ${event}`);
  console.log(`${'='.repeat(60)}`);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  try {
    if (event === 'meeting.rtms_started') {
      await handleRTMSStarted(payload);
      res.json({ success: true, message: 'RTMS started' });
    } else if (event === 'meeting.rtms_stopped') {
      await handleRTMSStopped(payload);
      res.json({ success: true, message: 'RTMS stopped' });
    } else {
      console.log('⚠️  Unhandled event:', event);
      res.json({ success: false, message: 'Unknown event' });
    }
  } catch (error) {
    console.error('❌ Error handling webhook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.RTMS_PORT || 3002;
const server = app.listen(PORT, () => {
  console.log(`\n✅ RTMS Server ready on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Webhook endpoint: http://localhost:${PORT}/webhook\n`);
});

let shutdownPromise;
const shutdown = (signal) => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`\n${signal} received; RTMS server shutting down...`);
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    try {
      for (const { client, stream } of activeClients.values()) {
        await client.leave();
        stream.end();
      }
      activeClients.clear();
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      process.exitCode = 0;
    } catch (error) {
      console.error('Shutdown failed:', error);
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  })();
  return shutdownPromise;
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
