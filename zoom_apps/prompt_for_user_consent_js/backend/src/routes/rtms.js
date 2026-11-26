const express = require('express');
const router = express.Router();
const { validateMeetingId } = require('../utils/validators');
const ConsentManager = require('../services/ConsentManager');
const { saveConsentState } = require('../utils/redis');
const { requireHostRole } = require('../middleware/security');
const { syncConsentPolicyToRtms } = require('../utils/rtmsNotifier');

let wsServer = null;
function setWebSocketServer(server) {
  wsServer = server;
}

/**
 * POST /api/rtms/start
 * Manually start RTMS (host/co-host only; blocked unless consent policy is satisfied)
 */
router.post('/start', requireHostRole, async (req, res) => {
  try {
    const { error, value } = validateMeetingId(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const state = await ConsentManager.getConsentState(value.meetingId);
    if (!ConsentManager.canCaptureRTMS(state)) {
      return res.status(403).json({
        error: 'Consent policy requirements are not met to start RTMS',
        policyMode: state.policyMode,
        unanimousConsent: state.unanimousConsent
      });
    }

    state.rtmsStatus = 'running';
    state.rtmsPausedReason = null;
    ConsentManager.recordAuditEvent(state, {
      eventType: 'rtms_started',
      source: 'manual_host_api',
      details: 'Host manually started RTMS'
    });

    const saved = await saveConsentState(value.meetingId, state);
    if (wsServer) {
      wsServer.broadcastRTMSStatus(value.meetingId, saved.rtmsStatus, null);
      wsServer.broadcastConsentUpdate(value.meetingId, saved);
    }
    await syncConsentPolicyToRtms(value.meetingId, saved);

    res.json({
      success: true,
      rtmsStatus: saved.rtmsStatus,
      policyMode: saved.policyMode
    });
  } catch (error) {
    console.error('Error starting RTMS:', error);
    res.status(500).json({ error: 'Failed to start RTMS' });
  }
});

/**
 * POST /api/rtms/stop
 * Manually stop RTMS (host/co-host only)
 */
router.post('/stop', requireHostRole, async (req, res) => {
  try {
    const { error, value } = validateMeetingId(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const state = await ConsentManager.getConsentState(value.meetingId);
    state.rtmsStatus = 'stopped';
    state.rtmsPausedReason = 'Stopped by host';
    ConsentManager.recordAuditEvent(state, {
      eventType: 'rtms_stopped',
      source: 'manual_host_api',
      details: 'Host manually stopped RTMS'
    });

    const saved = await saveConsentState(value.meetingId, state);
    if (wsServer) {
      wsServer.broadcastRTMSStatus(value.meetingId, saved.rtmsStatus, saved.rtmsPausedReason);
      wsServer.broadcastConsentUpdate(value.meetingId, saved);
    }
    await syncConsentPolicyToRtms(value.meetingId, saved);

    res.json({
      success: true,
      rtmsStatus: saved.rtmsStatus
    });
  } catch (error) {
    console.error('Error stopping RTMS:', error);
    res.status(500).json({ error: 'Failed to stop RTMS' });
  }
});

/**
 * GET /api/rtms/status?meetingId={meetingId}
 * Get RTMS status for a meeting
 */
router.get('/status', async (req, res) => {
  try {
    const { error, value } = validateMeetingId({ meetingId: req.query.meetingId });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const state = await ConsentManager.getConsentState(value.meetingId);

    res.json({
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason,
      unanimousConsent: state.unanimousConsent,
      policyMode: state.policyMode
    });
  } catch (error) {
    console.error('Error getting RTMS status:', error);
    res.status(500).json({ error: 'Failed to get RTMS status' });
  }
});

module.exports = router;
module.exports.setWebSocketServer = setWebSocketServer;
