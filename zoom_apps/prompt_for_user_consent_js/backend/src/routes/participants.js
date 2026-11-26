const express = require('express');
const router = express.Router();
const { validateMeetingId } = require('../utils/validators');
const ConsentManager = require('../services/ConsentManager');
const { requireHostRole } = require('../middleware/security');
const { syncConsentPolicyToRtms } = require('../utils/rtmsNotifier');

// Get server instance for WebSocket broadcasting
let wsServer = null;
function setWebSocketServer(server) {
  wsServer = server;
}

/**
 * GET /api/participants?meetingId={meetingId}
 * Get participant list with consent status (host/co-host only)
 */
router.get('/', requireHostRole, async (req, res) => {
  try {
    const { error, value } = validateMeetingId({ meetingId: req.query.meetingId });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const state = await ConsentManager.getConsentState(value.meetingId);

    res.json({
      participants: state.participants,
      totalCount: state.participants.length,
      agreedCount: state.participants.filter(p => p.consentStatus === 'agreed').length,
      disagreedCount: state.participants.filter(p => p.consentStatus === 'disagreed').length,
      pendingCount: state.participants.filter(p => p.consentStatus === 'pending').length,
      policyMode: state.policyMode
    });
  } catch (error) {
    console.error('Error getting participants:', error);
    res.status(500).json({ error: 'Failed to get participants' });
  }
});

/**
 * POST /api/participants/joined
 * Notify backend that a participant joined (SDK-detected, host/co-host only)
 */
router.post('/joined', requireHostRole, async (req, res) => {
  try {
    const { meetingId, participant } = req.body;

    if (!meetingId || !participant || !participant.participantUUID) {
      return res.status(400).json({ error: 'meetingId and participant with participantUUID required' });
    }

    const { state, duplicate, wasRunning, statusChanged } = await ConsentManager.addParticipant(
      meetingId,
      participant,
      { source: 'sdk_join' }
    );

    if (duplicate) {
      return res.json({
        success: true,
        duplicate: true,
        rtmsStatus: state.rtmsStatus
      });
    }

    if (wsServer) {
      wsServer.broadcastConsentUpdate(meetingId, state);
      if (statusChanged) {
        wsServer.broadcastRTMSStatus(meetingId, state.rtmsStatus, state.rtmsPausedReason);
      }
    }

    await syncConsentPolicyToRtms(meetingId, state);

    res.json({
      success: true,
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason,
      participantCount: state.participants.length,
      unanimousConsent: state.unanimousConsent,
      wasRunning
    });
  } catch (error) {
    console.error('❌ Error handling participant join:', error);
    res.status(500).json({ error: 'Failed to process participant join' });
  }
});

/**
 * POST /api/participants/left
 * Notify backend that a participant left (SDK-detected, host/co-host only)
 */
router.post('/left', requireHostRole, async (req, res) => {
  try {
    const { meetingId, participantUUID } = req.body;

    if (!meetingId || !participantUUID) {
      return res.status(400).json({ error: 'meetingId and participantUUID required' });
    }

    const { state, statusChanged } = await ConsentManager.removeParticipant(
      meetingId,
      participantUUID,
      { source: 'sdk_leave' }
    );

    if (wsServer) {
      if (statusChanged) {
        wsServer.broadcastRTMSStatus(meetingId, state.rtmsStatus, state.rtmsPausedReason);
      }
      wsServer.broadcastConsentUpdate(meetingId, state);
    }

    await syncConsentPolicyToRtms(meetingId, state);

    res.json({
      success: true,
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason,
      participantCount: state.participants.length,
      unanimousConsent: state.unanimousConsent
    });
  } catch (error) {
    console.error('❌ Error handling participant leave:', error);
    res.status(500).json({ error: 'Failed to process participant leave' });
  }
});

/**
 * POST /api/participants/sync
 * Sync initial participant list on app load
 */
router.post('/sync', async (req, res) => {
  try {
    const { meetingId, participants } = req.body;

    if (!meetingId || !participants || !Array.isArray(participants)) {
      return res.status(400).json({ error: 'meetingId and participants array required' });
    }

    if (req.zoomContext?.mid && String(req.zoomContext.mid) !== String(meetingId)) {
      return res.status(403).json({ error: 'Meeting context mismatch' });
    }

    const { state, syncedCount, alreadyTrackedCount, statusChanged } =
      await ConsentManager.syncParticipants(meetingId, participants, { source: 'sdk_sync' });

    if (wsServer) {
      if (statusChanged) {
        wsServer.broadcastRTMSStatus(meetingId, state.rtmsStatus, state.rtmsPausedReason);
      }
      wsServer.broadcastFullState(meetingId, state);
    }

    await syncConsentPolicyToRtms(meetingId, state);

    res.json({
      success: true,
      totalCount: state.participants.length,
      syncedCount,
      alreadyTrackedCount,
      unanimousConsent: state.unanimousConsent,
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason
    });
  } catch (error) {
    console.error('❌ Error syncing participants:', error);
    res.status(500).json({ error: 'Failed to sync participants' });
  }
});

module.exports = router;
module.exports.setWebSocketServer = setWebSocketServer;
