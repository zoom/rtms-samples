/**
 * RTMS Server using @zoom/rtms SDK
 * Captures transcripts from Zoom meetings when RTMS is started,
 * enforcing server-side consent gating and handling transcript rewinds.
 *
 * Note: For RTMS Protocol V2 deployments not using `@zoom/rtms`, consider using
 * `library/javascript/rtmsManager/RTMSManager.js` with `TranscriptRevisionStore`.
 */

import rtms from '@zoom/rtms';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import express from 'express';
import crypto from 'node:crypto';
import {
  normalizeTranscriptArgs,
  evaluateConsentGate,
  isPolicyRunning,
  MeetingTranscriptStore
} from './transcriptPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.join(__dirname, '../../.env') });

// Store active RTMS clients by meeting UUID
const activeClients = new Map();

// Live server-side consent policy synced from backend by meeting UUID
const meetingPolicies = new Map();

// Transcript output directory
const TRANSCRIPT_DIR = path.join(__dirname, '../app/data/transcripts');
const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:3000';

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

async function fetchBackendConsentPolicy(meetingUUID) {
  const token = process.env.INTERNAL_WEBHOOK_TOKEN;
  if (!token) return null;

  try {
    const url = `${BACKEND_URL}/api/consent/policy/internal?meetingId=${encodeURIComponent(meetingUUID)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const policy = await response.json();
    meetingPolicies.set(meetingUUID, policy);
    return policy;
  } catch (error) {
    console.warn(`⚠️  Could not fetch consent policy from backend for ${meetingUUID}: ${error.message}`);
    return null;
  }
}

/**
 * Rewrite transcript file with latest non-duplicate/rewound sentences.
 */
function writeTranscriptSnapshot(entry) {
  const header = [
    'Zoom Meeting Transcript',
    `Meeting UUID: ${entry.meetingUUID}`,
    `Started: ${entry.startedAt}`,
    '='.repeat(60),
    ''
  ].join('\n');

  const body = entry.store.orderedLines().join('\n');
  const footer = entry.stoppedAt
    ? `\n\n${'='.repeat(60)}\nStopped: ${entry.stoppedAt}\n`
    : '\n';

  fs.writeFileSync(entry.filepath, `${header}${body}${footer}`, 'utf8');
}

/**
 * Handle RTMS started webhook
 * Connects to the RTMS stream and starts capturing transcripts only when consent policy allows.
 */
async function handleRTMSStarted(payload) {
  const { meeting_uuid, rtms_stream_id, server_urls, policy: incomingPolicy } = payload;

  if (incomingPolicy) {
    meetingPolicies.set(meeting_uuid, incomingPolicy);
  }

  let policy = meetingPolicies.get(meeting_uuid);
  if (!policy) {
    policy = await fetchBackendConsentPolicy(meeting_uuid);
  }

  if (!policy || !isPolicyRunning(policy) || (policy.policyMode === 'unanimous' && !policy.unanimousConsent)) {
    console.warn(`🚫 Refusing to join RTMS stream for ${meeting_uuid}: consent gate not satisfied`);
    return { started: false, reason: 'consent_gate_blocked' };
  }

  if (activeClients.has(meeting_uuid)) {
    console.log('⚠️  Already connected to this meeting, skipping');
    return { started: true, alreadyConnected: true };
  }

  try {
    const client = new rtms.Client();
    const startedAt = new Date().toISOString();
    const timestamp = startedAt.replace(/:/g, '-').split('.')[0];
    const sanitizedUUID = meeting_uuid.replace(/[/\\:*?"<>|]/g, '_');

    const filename = `transcript_${sanitizedUUID}_${timestamp}.txt`;
    const filepath = path.join(TRANSCRIPT_DIR, filename);
    const store = new MeetingTranscriptStore();

    const activeEntry = {
      meetingUUID: meeting_uuid,
      client,
      store,
      filepath,
      filename,
      startedAt,
      stoppedAt: null
    };

    writeTranscriptSnapshot(activeEntry);

    // Fix `@zoom/rtms` callback signature: (data, size, timestamp, metadata)
    client.onTranscriptData((data, size, ts, metadata) => {
      try {
        const parsed = normalizeTranscriptArgs(data, size, ts, metadata);
        const currentPolicy = meetingPolicies.get(meeting_uuid);
        const decision = evaluateConsentGate(currentPolicy, parsed);

        if (decision.action === 'drop') {
          console.log(`🚫 Dropped transcript (${decision.reason}) for meeting ${meeting_uuid}`);
          return;
        }

        const effectiveEntry = decision.action === 'redact'
          ? {
              ...parsed,
              userName: 'Unconsented Participant',
              text: '[REDACTED - Participant consent not granted]'
            }
          : parsed;

        const { action, record } = store.apply(effectiveEntry);
        const timeStr = new Date(record.timestamp).toISOString();
        const tag = action === 'updated' || action === 'recovered' ? ' [rewind]' : '';
        console.log(`📝 [${timeStr}] ${record.userName}${tag}: ${record.text}`);

        writeTranscriptSnapshot(activeEntry);
      } catch (error) {
        console.error('❌ Error processing transcript:', error);
      }
    });

    client.onAudioData((_data, _size, _ts, _metadata) => {
      // No-op: Only capturing transcripts
    });

    client.onVideoData((_data, _size, _ts, _metadata) => {
      // No-op: Only capturing transcripts
    });

    await client.join({
      meeting_uuid,
      rtms_stream_id,
      server_urls,
      client: process.env.ZOOM_APP_CLIENT_ID,
      secret: process.env.ZOOM_APP_CLIENT_SECRET
    });

    activeClients.set(meeting_uuid, activeEntry);
    console.log(`🎙️  RTMS capture active for ${meeting_uuid} -> ${filename}`);
    return { started: true, filename };
  } catch (error) {
    console.error('❌ Failed to start RTMS capture:', error.message);
    return { started: false, error: error.message };
  }
}

/**
 * Handle RTMS stopped webhook
 * Disconnects from stream and saves final transcript snapshot
 */
async function handleRTMSStopped(payload) {
  const { meeting_uuid } = payload;

  if (!activeClients.has(meeting_uuid)) {
    return;
  }

  try {
    const entry = activeClients.get(meeting_uuid);
    await entry.client.leave();
    entry.stoppedAt = new Date().toISOString();
    writeTranscriptSnapshot(entry);
    activeClients.delete(meeting_uuid);
    console.log(`✅ Transcript saved: ${entry.filename}`);
  } catch (error) {
    console.error('❌ Failed to stop RTMS capture:', error.message);
  }
}

/**
 * Handle live consent policy updates pushed by the backend.
 */
async function handlePolicyUpdated(payload) {
  const { meeting_uuid, policy } = payload || {};
  if (!meeting_uuid || !policy) {
    return;
  }

  meetingPolicies.set(meeting_uuid, policy);
  console.log(
    `🔐 Updated consent policy for ${meeting_uuid}: mode=${policy.policyMode}, status=${policy.rtmsStatus}, unanimous=${policy.unanimousConsent}`
  );

  // Immediately sever active RTMS stream if policy moved to stopped
  if (policy.rtmsStatus === 'stopped' && activeClients.has(meeting_uuid)) {
    await handleRTMSStopped({ meeting_uuid });
  }
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'RTMS Server running',
    activeConnections: activeClients.size,
    trackedPolicies: meetingPolicies.size,
    transcriptDirectory: TRANSCRIPT_DIR
  });
});

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

  try {
    if (event === 'meeting.rtms_started') {
      const result = await handleRTMSStarted(payload);
      res.json({ success: result.started, ...result });
    } else if (event === 'meeting.rtms_stopped') {
      await handleRTMSStopped(payload);
      res.json({ success: true, message: 'RTMS stopped' });
    } else if (event === 'consent.policy_updated') {
      await handlePolicyUpdated(payload);
      res.json({ success: true, message: 'Consent policy updated' });
    } else {
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
      for (const entry of activeClients.values()) {
        await entry.client.leave();
        entry.stoppedAt = new Date().toISOString();
        writeTranscriptSnapshot(entry);
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
