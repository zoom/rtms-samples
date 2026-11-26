const express = require('express');
const router = express.Router();
const {
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
} = require('../services/WebhookHandlers');

/**
 * POST /api/webhooks/zoom
 * Zoom webhook receiver
 */
router.post('/zoom', async (req, res) => {
  try {
    console.log('Webhook received:', req.body.event);

    const { event, payload } = req.body;

    if (event === 'endpoint.url_validation') {
      return handleUrlValidation(payload, res);
    }

    if (!validateWebhookSignature(req)) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    switch (event) {
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
        await handleMeetingEnded(payload);
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

module.exports = router;
module.exports.setWebSocketServer = setWebSocketServer;
module.exports.handleRTMSStarted = handleRTMSStarted;
module.exports.handleMeetingEnded = handleMeetingEnded;
module.exports.handleChatMessage = handleChatMessage;
module.exports.parseConsentFromChat = parseConsentFromChat;
