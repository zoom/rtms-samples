const express = require('express');
const router = express.Router();
const { validateMeetingId } = require('../utils/validators');
const { getConsentState } = require('../utils/redis');

/**
 * POST /api/rtms/start
 * Manually start RTMS (host only)
 * Note: In Phase 4, this will be automatic when unanimous consent is achieved
 */
router.post('/start', async (req, res) => {
  try {
    const { error, value } = validateMeetingId(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // TODO: Add authentication check for host role
    // TODO: Implement actual RTMS start via Zoom SDK (Phase 4)

    console.log(`Manual RTMS start requested for meeting ${value.meetingId}`);

    res.json({
      success: true,
      message: 'RTMS start command issued (Phase 4 will implement actual start)'
    });
  } catch (error) {
    console.error('Error starting RTMS:', error);
    res.status(500).json({ error: 'Failed to start RTMS' });
  }
});

/**
 * POST /api/rtms/stop
 * Manually stop RTMS (host only)
 */
router.post('/stop', async (req, res) => {
  try {
    const { error, value } = validateMeetingId(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // TODO: Add authentication check for host role
    // TODO: Implement actual RTMS stop via Zoom SDK (Phase 4)

    console.log(`Manual RTMS stop requested for meeting ${value.meetingId}`);

    res.json({
      success: true,
      message: 'RTMS stop command issued (Phase 4 will implement actual stop)'
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

    const state = await getConsentState(value.meetingId);

    res.json({
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason,
      unanimousConsent: state.unanimousConsent
    });
  } catch (error) {
    console.error('Error getting RTMS status:', error);
    res.status(500).json({ error: 'Failed to get RTMS status' });
  }
});

module.exports = router;
