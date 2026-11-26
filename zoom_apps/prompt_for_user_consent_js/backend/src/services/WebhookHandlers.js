const crypto = require('crypto');
const config = require('../config');
const ConsentManager = require('./ConsentManager');
const { saveConsentState } = require('../utils/redis');
const {
  buildRtmsPolicySnapshot,
  sendInternalRtmsWebhook,
  syncConsentPolicyToRtms
} = require('../utils/rtmsNotifier');

let wsServer = null;
function setWebSocketServer(server) {
  wsServer = server;
}

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

function isValidPlainToken(plainToken) {
  return typeof plainToken === 'string' &&
    plainToken.length >= 8 &&
    plainToken.length <= 256 &&
    /^[\x21-\x7E]+$/.test(plainToken);
}

function handleUrlValidation(payload, res) {
  if (!isValidPlainToken(payload?.plainToken)) {
    return res.sendStatus(400);
  }

  if (!config.zoomSecretToken) {
    return res.status(500).json({ error: 'ZOOM_SECRET_TOKEN not configured' });
  }

  const encryptedToken = crypto
    .createHmac('sha256', config.zoomSecretToken)
    .update(payload.plainToken)
    .digest('hex');

  return res.json({
    plainToken: payload.plainToken,
    encryptedToken
  });
}

async function handleParticipantJoined(payload) {
  const meetingUUID = payload.object?.uuid;
  const participant = payload.object?.participant;
  if (!meetingUUID || !participant) return;
  console.log(`Webhook: Participant joined: ${participant.user_name} in meeting ${meetingUUID} (SDK handles tracking via /api/participants/sync)`);
}

async function handleParticipantLeft(payload) {
  const meetingUUID = payload.object?.uuid;
  const participant = payload.object?.participant;
  if (!meetingUUID || !participant) return;
  console.log(`Webhook: Participant left: ${participant.user_name} from meeting ${meetingUUID} (SDK handles tracking via /api/participants/sync)`);
}

/**
 * Enforce server-side consent gating in Redis before forwarding `meeting.rtms_started` to RTMS server.
 */
async function handleRTMSStarted(payload) {
  try {
    const meetingUUID = payload?.meeting_uuid;
    const rtmsStreamId = payload?.rtms_stream_id;
    const serverUrls = payload?.server_urls;

    if (!meetingUUID || !rtmsStreamId || !serverUrls) {
      return { forwarded: false, reason: 'invalid_payload' };
    }

    const state = await ConsentManager.getConsentState(meetingUUID);
    const allowed = ConsentManager.canCaptureRTMS(state) && state.rtmsStatus !== 'stopped' && state.rtmsStatus !== 'paused';

    if (!allowed) {
      ConsentManager.recordAuditEvent(state, {
        eventType: 'rtms_capture_blocked',
        source: 'webhook',
        details: `Blocked meeting.rtms_started because policy=${state.policyMode}, status=${state.rtmsStatus}, unanimous=${state.unanimousConsent}`
      });
      await saveConsentState(meetingUUID, state);

      if (wsServer) {
        wsServer.broadcastRTMSStatus(meetingUUID, state.rtmsStatus, state.rtmsPausedReason || 'Consent not granted');
        wsServer.broadcastConsentUpdate(meetingUUID, state);
      }

      return { forwarded: false, reason: 'consent_gate_blocked' };
    }

    const policy = buildRtmsPolicySnapshot(state);
    const result = await sendInternalRtmsWebhook('meeting.rtms_started', {
      meeting_uuid: meetingUUID,
      rtms_stream_id: rtmsStreamId,
      server_urls: serverUrls,
      policy
    });

    return { forwarded: true, result };
  } catch (error) {
    console.error('Error handling rtms_started:', error);
    return { forwarded: false, error: error.message };
  }
}

async function handleRTMSStopped(payload) {
  try {
    const meetingUUID = payload?.meeting_uuid;
    if (!meetingUUID) return;

    await sendInternalRtmsWebhook('meeting.rtms_stopped', {
      meeting_uuid: meetingUUID
    });
  } catch (error) {
    console.error('Error handling rtms_stopped:', error);
  }
}

async function handleMeetingEnded(payload) {
  try {
    const meetingUUID = payload?.object?.uuid || payload?.meeting_uuid || payload?.object?.id;
    if (!meetingUUID) return;

    await sendInternalRtmsWebhook('meeting.rtms_stopped', {
      meeting_uuid: meetingUUID,
      reason: 'meeting_ended'
    });

    await ConsentManager.deleteMeetingState(meetingUUID);

    if (wsServer) {
      wsServer.broadcastRTMSStatus(meetingUUID, 'stopped', 'Meeting ended');
    }
  } catch (error) {
    console.error('Error handling meeting.ended:', error);
  }
}

async function handleChatMessage(payload) {
  try {
    const meetingUUID = payload?.object?.uuid;
    const chatMessage = payload?.object?.chat_message;

    if (!meetingUUID || !chatMessage) return null;

    const messageContent = chatMessage.message_content;
    const senderName = chatMessage.sender_name;
    const senderSessionId = chatMessage.sender_session_id;

    const consentStatus = parseConsentFromChat(messageContent);
    if (!consentStatus) return null;

    const consentState = await ConsentManager.getConsentState(meetingUUID);

    const participant = consentState.participants.find(p =>
      p.screenName === senderName ||
      (senderSessionId && (p.participantID === senderSessionId || p.participantUUID === senderSessionId)) ||
      (senderName && p.screenName?.toLowerCase() === senderName.toLowerCase())
    );

    if (!participant) return null;

    const { state: updatedState, statusChanged } = await ConsentManager.submitConsent(
      meetingUUID,
      {
        participantId: participant.participantUUID,
        participantName: participant.screenName,
        consentStatus
      },
      { source: 'chat_webhook' }
    );

    if (wsServer) {
      if (statusChanged) {
        wsServer.broadcastRTMSStatus(meetingUUID, updatedState.rtmsStatus, updatedState.rtmsPausedReason);
      }
      wsServer.broadcastConsentUpdate(meetingUUID, updatedState);
    }

    await syncConsentPolicyToRtms(meetingUUID, updatedState);
    return updatedState;
  } catch (error) {
    console.error('Error handling chat message:', error);
    return null;
  }
}

function parseConsentFromChat(message) {
  if (!message || typeof message !== 'string') return null;

  const text = message.toLowerCase().trim();

  const CONSENT_KEYWORDS = [
    'i consent',
    'i agree',
    '/consent',
    '/agree',
    'consent granted',
    'yes to consent'
  ];

  const DECLINE_KEYWORDS = [
    'i decline',
    'i disagree',
    '/decline',
    'no consent',
    'consent declined'
  ];

  if (DECLINE_KEYWORDS.some(keyword => text.includes(keyword))) {
    return 'disagreed';
  }

  if (CONSENT_KEYWORDS.some(keyword => text.includes(keyword))) {
    return 'agreed';
  }

  return null;
}

module.exports = {
  setWebSocketServer,
  validateWebhookSignature,
  handleUrlValidation,
  handleParticipantJoined,
  handleParticipantLeft,
  handleRTMSStarted,
  handleRTMSStopped,
  handleMeetingEnded,
  handleChatMessage,
  parseConsentFromChat
};
