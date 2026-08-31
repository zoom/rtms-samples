const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const config = require('../config');
const ConsentManager = require('../services/ConsentManager');

// Get server instance for WebSocket broadcasting
let wsServer = null;
function setWebSocketServer(server) {
  wsServer = server;
}

/**
 * Validate Zoom webhook signature
 */
function validateWebhookSignature(req) {
  if (!config.zoomSecretToken) {
    console.error('ZOOM_SECRET_TOKEN not configured');
    return false;
  }

  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];
  if (!signature || !timestamp || !Buffer.isBuffer(req.rawBody)) return false;
  const timestampSeconds = Number(timestamp);
  const toleranceSeconds = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS || 300);
  if (
    !Number.isFinite(timestampSeconds) ||
    (toleranceSeconds > 0 &&
      Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > toleranceSeconds)
  ) return false;

  const message = `v0:${timestamp}:${req.rawBody.toString('utf8')}`;
  const hash = crypto
    .createHmac('sha256', config.zoomSecretToken)
    .update(message)
    .digest('hex');

  const expectedSignature = `v0=${hash}`;

  const receivedBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expectedSignature);
  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * POST /api/webhooks/zoom
 * Zoom webhook receiver
 */
router.post('/zoom', async (req, res) => {
  try {
    console.log('Webhook received:', req.body.event);

    // Validate signature (if token is configured)
    if (!validateWebhookSignature(req)) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { event, payload } = req.body;

    switch (event) {
      case 'endpoint.url_validation':
        return handleUrlValidation(payload, res);

      case 'meeting.participant_joined':
        await handleParticipantJoined(payload);
        break;

      case 'meeting.participant_left':
        await handleParticipantLeft(payload);
        break;

      case 'meeting.rtms_started':
        await handleRTMSStarted(payload);
        break;

      case 'meeting.rtms_stopped':
        await handleRTMSStopped(payload);
        break;

      case 'meeting.started':
        console.log('Meeting started:', payload.object?.id);
        break;

      case 'meeting.ended':
        console.log('Meeting ended:', payload.object?.id);
        // TODO: Cleanup consent state
        break;

      case 'meeting.chat_message_sent':
        await handleChatMessage(payload);
        break;

      default:
        console.log('Unhandled webhook event:', event);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

/**
 * Handle URL validation challenge
 */
function handleUrlValidation(payload, res) {
  if (!payload?.plainToken) {
    return res.sendStatus(400);
  }

  const encryptedToken = crypto
    .createHmac('sha256', config.zoomSecretToken || 'default')
    .update(payload.plainToken)
    .digest('hex');

  console.log('Responding to Zoom URL validation challenge');

  return res.json({
    plainToken: payload.plainToken,
    encryptedToken
  });
}

/**
 * Handle participant joined event
 *
 * NOTE: Participant tracking is now handled by SDK-first approach via /api/participants/sync
 * This webhook is kept for logging/backup purposes only and does NOT add participants to state
 */
async function handleParticipantJoined(payload) {
  try {
    const meetingUUID = payload.object?.uuid;
    const participant = payload.object?.participant;

    if (!meetingUUID || !participant) {
      console.error('Invalid participant_joined payload');
      return;
    }

    console.log(`Webhook: Participant joined: ${participant.user_name} in meeting ${meetingUUID}`);
    console.log(`  (Webhook participant tracking disabled - SDK handles this via /api/participants/sync)`);

    // ⚠️ DO NOT add participant here - SDK-first tracking handles this
    // The frontend calls /api/participants/sync which replaces webhook-added participants
    // with SDK participants to avoid UUID format mismatches

    // No-op: just log the event
  } catch (error) {
    console.error('Error handling participant_joined:', error);
  }
}

/**
 * Handle participant left event
 *
 * NOTE: Participant tracking is now handled by SDK-first approach via /api/participants/sync
 * This webhook is kept for logging/backup purposes only and does NOT remove participants from state
 */
async function handleParticipantLeft(payload) {
  try {
    const meetingUUID = payload.object?.uuid;
    const participant = payload.object?.participant;

    if (!meetingUUID || !participant) {
      console.error('Invalid participant_left payload');
      return;
    }

    console.log(`Webhook: Participant left: ${participant.user_name} from meeting ${meetingUUID}`);
    console.log(`  (Webhook participant tracking disabled - SDK handles this via /api/participants/sync)`);

    // ⚠️ DO NOT remove participant here - SDK-first tracking handles this
    // The frontend's onParticipantChange listener detects leaves and calls /api/participants/sync
    // which updates the participant list based on current SDK state

    // No-op: just log the event
  } catch (error) {
    console.error('Error handling participant_left:', error);
  }
}

/**
 * Handle RTMS started event
 * Forwards webhook to RTMS server for stream connection
 */
async function handleRTMSStarted(payload) {
  try {
    console.log('📦 RTMS Started Webhook - Full Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const meetingUUID = payload.meeting_uuid;
    const rtmsStreamId = payload.rtms_stream_id;
    const serverUrls = payload.server_urls;

    if (!meetingUUID || !rtmsStreamId || !serverUrls) {
      console.error('❌ Invalid rtms_started payload - Missing data:');
      console.error('   meetingUUID:', meetingUUID);
      console.error('   rtmsStreamId:', rtmsStreamId);
      console.error('   serverUrls:', serverUrls);
      return;
    }

    console.log(`✅ RTMS started for meeting: ${meetingUUID}`);
    console.log(`   Stream ID: ${rtmsStreamId}`);
    console.log(`   Server URL: ${serverUrls}`);

    // Forward webhook to RTMS server
    const rtmsServerUrl = process.env.RTMS_SERVER_URL || 'http://localhost:3002';

    console.log(`📡 Forwarding to RTMS server: ${rtmsServerUrl}/webhook`);

    try {
      const fetch = require('node-fetch');
      const response = await fetch(`${rtmsServerUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.INTERNAL_WEBHOOK_TOKEN}`
        },
        body: JSON.stringify({
          event: 'meeting.rtms_started',
          payload: {
            meeting_uuid: meetingUUID,
            rtms_stream_id: rtmsStreamId,
            server_urls: serverUrls
          }
        })
      });

      console.log(`✅ RTMS webhook forwarded - Status: ${response.status}`);
    } catch (error) {
      console.error('❌ Failed to forward webhook to RTMS server:', error.message);
      console.error('   Make sure RTMS server is running on port 3002');
    }
  } catch (error) {
    console.error('Error handling rtms_started:', error);
  }
}

/**
 * Handle RTMS stopped event
 * Notifies RTMS server to disconnect and save transcripts
 */
async function handleRTMSStopped(payload) {
  try {
    console.log('📦 RTMS Stopped Webhook - Full Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const meetingUUID = payload.meeting_uuid;

    if (!meetingUUID) {
      console.error('❌ Invalid rtms_stopped payload - Missing meeting_uuid');
      return;
    }

    console.log(`✅ RTMS stopped for meeting: ${meetingUUID}`);

    // Forward webhook to RTMS server
    const rtmsServerUrl = process.env.RTMS_SERVER_URL || 'http://localhost:3002';

    try {
      const fetch = require('node-fetch');
      await fetch(`${rtmsServerUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.INTERNAL_WEBHOOK_TOKEN}`
        },
        body: JSON.stringify({
          event: 'meeting.rtms_stopped',
          payload: {
            meeting_uuid: meetingUUID
          }
        })
      });

      console.log('✅ RTMS stop webhook forwarded to RTMS server');
    } catch (error) {
      console.error('❌ Failed to forward webhook to RTMS server:', error.message);
    }
  } catch (error) {
    console.error('Error handling rtms_stopped:', error);
  }
}

/**
 * Handle chat message event
 * Detects consent keywords and updates participant status
 */
async function handleChatMessage(payload) {
  try {
    console.log('💬 Chat Message Webhook - Full Payload:');
    console.log(JSON.stringify(payload, null, 2));

    const meetingUUID = payload.object?.uuid;
    const chatMessage = payload.object?.chat_message;

    if (!meetingUUID || !chatMessage) {
      console.error('❌ Invalid chat_message_sent payload');
      return;
    }

    const messageContent = chatMessage.message_content;
    const senderName = chatMessage.sender_name;
    const senderEmail = chatMessage.sender_email;
    const senderSessionId = chatMessage.sender_session_id;

    console.log(`💬 Chat message from ${senderName}: "${messageContent}"`);

    // Parse message for consent keywords
    const consentStatus = parseConsentFromChat(messageContent);

    if (!consentStatus) {
      console.log('   Not a consent message, ignoring');
      return;
    }

    console.log(`✅ Consent detected: ${senderName} → ${consentStatus}`);

    // Get current consent state to find participant
    const consentState = await ConsentManager.getConsentState(meetingUUID);

    // Try to match sender to participant by name or email
    const participant = consentState.participants.find(p =>
      p.screenName === senderName ||
      p.participantID === senderSessionId ||
      p.screenName?.toLowerCase() === senderName?.toLowerCase()
    );

    if (!participant) {
      console.warn(`⚠️  Could not match chat sender "${senderName}" to participant list`);
      console.warn('   Available participants:', consentState.participants.map(p => p.screenName));
      return;
    }

    console.log(`   Matched to participant: ${participant.screenName} (${participant.participantUUID})`);

    // Submit consent on behalf of the participant
    await ConsentManager.submitConsent(
      meetingUUID,
      participant.participantUUID,
      participant.screenName,
      consentStatus
    );

    console.log(`✅ Consent submitted via chat for ${participant.screenName}`);

    // Broadcast state update via WebSocket
    if (wsServer) {
      const updatedState = await ConsentManager.getConsentState(meetingUUID);
      wsServer.broadcastToMeeting(meetingUUID, 'consent_state_update', updatedState);
    }
  } catch (error) {
    console.error('Error handling chat message:', error);
  }
}

/**
 * Parse a chat message to detect consent intent
 * @param {string} message - The chat message text
 * @returns {'agreed' | 'disagreed' | null} - Consent status or null if not a consent message
 */
function parseConsentFromChat(message) {
  if (!message || typeof message !== 'string') return null;

  const text = message.toLowerCase().trim();

  // Agreement keywords
  const CONSENT_KEYWORDS = [
    'i consent',
    'i agree',
    '/consent',
    '/agree',
    'consent granted',
    'yes to consent'
  ];

  // Decline keywords
  const DECLINE_KEYWORDS = [
    'i decline',
    'i disagree',
    '/decline',
    'no consent',
    'consent declined'
  ];

  // Check for agreement keywords
  if (CONSENT_KEYWORDS.some(keyword => text.includes(keyword))) {
    return 'agreed';
  }

  // Check for decline keywords
  if (DECLINE_KEYWORDS.some(keyword => text.includes(keyword))) {
    return 'disagreed';
  }

  return null; // Not a consent message
}

module.exports = router;
module.exports.setWebSocketServer = setWebSocketServer;
