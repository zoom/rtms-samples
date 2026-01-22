const express = require('express');
const router = express.Router();
const { validateConsentSubmission, validateMeetingId } = require('../utils/validators');
const ConsentManager = require('../services/ConsentManager');
const { getConsentState } = require('../utils/redis');

// Get server instance for WebSocket broadcasting
let wsServer = null;
function setWebSocketServer(server) {
  wsServer = server;
}

/**
 * POST /api/consent/submit
 * Submit participant consent
 */
router.post('/submit', async (req, res) => {
  try {
    // Validate request body
    const { error, value } = validateConsentSubmission(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✋ CONSENT SUBMISSION`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Meeting: ${value.meetingId}`);
    console.log(`Participant: ${value.participantName}`);
    console.log(`Consent: ${value.consentStatus.toUpperCase()}`);
    console.log(`${'='.repeat(60)}\n`);

    // Submit consent
    const state = await ConsentManager.submitConsent(value.meetingId, value);

    console.log(`📊 Consent State After Submission:`);
    console.log(`   Total Participants: ${state.participants.length}`);
    console.log(`   Agreed: ${state.participants.filter(p => p.consentStatus === 'agreed').length}`);
    console.log(`   Disagreed: ${state.participants.filter(p => p.consentStatus === 'disagreed').length}`);
    console.log(`   Pending: ${state.participants.filter(p => p.consentStatus === 'pending').length}`);
    console.log(`   Unanimous Consent: ${state.unanimousConsent}`);

    // Check if we should start or resume RTMS (unanimous consent achieved)
    if (state.unanimousConsent && (state.rtmsStatus === 'stopped' || state.rtmsStatus === 'paused')) {
      const action = state.rtmsStatus === 'stopped' ? 'STARTING' : 'RESUMING';

      console.log(`\n${'🎉'.repeat(20)}`);
      console.log(`🚀 UNANIMOUS CONSENT ACHIEVED - ${action} RTMS!`);
      console.log(`${'🎉'.repeat(20)}\n`);

      state.rtmsStatus = 'running';
      state.rtmsPausedReason = null;

      // RTMS Flow (Phase 4 Implementation):
      // 1. Backend sets status to 'running' and broadcasts via WebSocket
      // 2. Frontend ConsentContext receives status change
      // 3. Frontend calls zoomSdk.callZoomApi('startRTMS')
      // 4. Zoom sends meeting.rtms_started webhook to backend
      // 5. Backend forwards webhook to RTMS server on port 3002
      // 6. RTMS server connects to stream and captures transcripts
      console.log(`✅ RTMS status set to 'running' - Frontend will call ${action === 'STARTING' ? 'startRTMS()' : 'startRTMS() (resume)'}`);

      // Save updated state
      const { saveConsentState } = require('../utils/redis');
      await saveConsentState(value.meetingId, state);

      // Broadcast RTMS status change
      if (wsServer) {
        wsServer.broadcastRTMSStatus(value.meetingId, 'running', null);
      }
    } else if (value.consentStatus === 'disagreed') {
      console.log(`\n❌ CONSENT DECLINED - RTMS CANNOT START\n`);
    } else if (!state.unanimousConsent) {
      const pending = state.participants.filter(p => p.consentStatus === 'pending');
      console.log(`\n⏳ Waiting for ${pending.length} more participant(s) to consent:`);
      pending.forEach(p => console.log(`   - ${p.screenName}`));
      console.log();
    }

    // Broadcast state update via WebSocket
    if (wsServer) {
      console.log(`📡 Broadcasting consent update to all clients\n`);
      wsServer.broadcastConsentUpdate(value.meetingId, state);
    }

    res.json({
      success: true,
      consentStatus: value.consentStatus,
      unanimousConsent: state.unanimousConsent,
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason
    });
  } catch (error) {
    console.error('❌ Error in consent submission:', error);
    res.status(500).json({ error: 'Failed to submit consent' });
  }
});

/**
 * GET /api/consent/status?meetingId={meetingId}
 * Get current consent state for a meeting
 */
router.get('/status', async (req, res) => {
  try {
    const { error, value } = validateMeetingId({ meetingId: req.query.meetingId });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const state = await getConsentState(value.meetingId);

    res.json(state);
  } catch (error) {
    console.error('Error getting consent status:', error);
    res.status(500).json({ error: 'Failed to get consent status' });
  }
});

module.exports = router;
module.exports.setWebSocketServer = setWebSocketServer;
