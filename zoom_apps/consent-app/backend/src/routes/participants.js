const express = require('express');
const router = express.Router();
const { validateMeetingId } = require('../utils/validators');
const { getConsentState, saveConsentState } = require('../utils/redis');
const ConsentManager = require('../services/ConsentManager');

// Get server instance for WebSocket broadcasting
let wsServer = null;
function setWebSocketServer(server) {
  wsServer = server;
}

/**
 * GET /api/participants?meetingId={meetingId}
 * Get participant list with consent status (host only)
 */
router.get('/', async (req, res) => {
  try {
    const { error, value } = validateMeetingId({ meetingId: req.query.meetingId });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // TODO: Add authentication check for host role
    // For now, allow anyone to access (will be restricted in Phase 6)

    const state = await getConsentState(value.meetingId);

    res.json({
      participants: state.participants,
      totalCount: state.participants.length,
      agreedCount: state.participants.filter(p => p.consentStatus === 'agreed').length,
      disagreedCount: state.participants.filter(p => p.consentStatus === 'disagreed').length,
      pendingCount: state.participants.filter(p => p.consentStatus === 'pending').length
    });
  } catch (error) {
    console.error('Error getting participants:', error);
    res.status(500).json({ error: 'Failed to get participants' });
  }
});

/**
 * POST /api/participants/joined
 * Notify backend that a participant joined (SDK-detected)
 * PRIMARY detection method for participant joins
 */
router.post('/joined', async (req, res) => {
  try {
    const { meetingId, participant } = req.body;

    if (!meetingId || !participant) {
      return res.status(400).json({ error: 'meetingId and participant required' });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔔 PARTICIPANT JOINED (SDK Detection)`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Meeting: ${meetingId}`);
    console.log(`Participant: ${participant.screenName} (${participant.participantUUID})`);
    console.log(`Role: ${participant.role}`);
    console.log(`Detection Method: Zoom Apps SDK (Primary)`);
    console.log(`${'='.repeat(60)}\n`);

    // Get current state
    const state = await getConsentState(meetingId);

    // Check if participant already exists
    const exists = state.participants.some(
      p => p.participantUUID === participant.participantUUID
    );

    if (exists) {
      console.log(`⚠️  Participant already tracked, skipping duplicate`);
      return res.json({
        success: true,
        duplicate: true,
        rtmsStatus: state.rtmsStatus
      });
    }

    // Add participant with pending consent
    state.participants.push({
      participantUUID: participant.participantUUID,
      participantID: participant.participantID,
      screenName: participant.screenName,
      role: participant.role,
      isHost: participant.isHost,
      isCoHost: participant.isCoHost,
      consentStatus: 'pending',
      joinedAt: new Date().toISOString()
    });

    // Check if RTMS is running - if so, PAUSE IT
    const wasRunning = state.rtmsStatus === 'running';
    if (wasRunning) {
      console.log(`⚠️  RTMS IS RUNNING - MUST PAUSE FOR NEW PARTICIPANT`);
      state.rtmsStatus = 'paused';
      state.rtmsPausedReason = `New participant joined: ${participant.screenName}`;

      // RTMS Pause Flow (Phase 4 Implementation):
      // 1. Backend sets status to 'paused' and broadcasts via WebSocket
      // 2. Frontend ConsentContext receives status change
      // 3. Frontend calls zoomSdk.callZoomApi('stopRTMS')
      // 4. Zoom sends meeting.rtms_stopped webhook to backend
      // 5. Backend forwards webhook to RTMS server
      // 6. RTMS server disconnects and saves transcript
      console.log(`🛑 RTMS status set to 'paused' - Frontend will call stopRTMS()`);
    }

    // No longer unanimous consent
    state.unanimousConsent = false;

    // Save state
    await saveConsentState(meetingId, state);

    // Broadcast update via WebSocket to ALL clients
    if (wsServer) {
      console.log(`📡 Broadcasting state update to all clients`);
      wsServer.broadcastConsentUpdate(meetingId, state);

      if (wasRunning) {
        wsServer.broadcastRTMSStatus(meetingId, 'paused', state.rtmsPausedReason);
      }
    }

    console.log(`✅ Participant join processed successfully`);
    console.log(`   Total participants: ${state.participants.length}`);
    console.log(`   RTMS Status: ${state.rtmsStatus}`);
    console.log(`   Unanimous Consent: ${state.unanimousConsent}\n`);

    res.json({
      success: true,
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason,
      participantCount: state.participants.length,
      wasRunning
    });
  } catch (error) {
    console.error('❌ Error handling participant join:', error);
    res.status(500).json({ error: 'Failed to process participant join' });
  }
});

/**
 * POST /api/participants/left
 * Notify backend that a participant left (SDK-detected)
 * PRIMARY detection method for participant leaves
 */
router.post('/left', async (req, res) => {
  try {
    const { meetingId, participantUUID } = req.body;

    if (!meetingId || !participantUUID) {
      return res.status(400).json({ error: 'meetingId and participantUUID required' });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📤 PARTICIPANT LEFT (SDK Detection)`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Meeting: ${meetingId}`);
    console.log(`Participant UUID: ${participantUUID}`);
    console.log(`Detection Method: Zoom Apps SDK (Primary)`);
    console.log(`${'='.repeat(60)}\n`);

    // Remove participant from state
    const state = await ConsentManager.removeParticipant(meetingId, participantUUID);

    // Check if we now have unanimous consent (if participant who left hadn't consented)
    if (state.unanimousConsent && state.rtmsStatus === 'paused') {
      console.log(`✅ Unanimous consent achieved after participant left - could resume RTMS`);
      // Note: In Phase 5, we'll actually resume RTMS here
    }

    // Broadcast update via WebSocket
    if (wsServer) {
      console.log(`📡 Broadcasting state update to all clients`);
      wsServer.broadcastConsentUpdate(meetingId, state);
    }

    console.log(`✅ Participant leave processed successfully`);
    console.log(`   Total participants: ${state.participants.length}`);
    console.log(`   RTMS Status: ${state.rtmsStatus}`);
    console.log(`   Unanimous Consent: ${state.unanimousConsent}\n`);

    res.json({
      success: true,
      rtmsStatus: state.rtmsStatus,
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
 * Ensures backend knows about all participants when app opens
 */
router.post('/sync', async (req, res) => {
  try {
    const { meetingId, participants } = req.body;

    if (!meetingId || !participants || !Array.isArray(participants)) {
      return res.status(400).json({ error: 'meetingId and participants array required' });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔄 INITIAL PARTICIPANT SYNC`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Meeting: ${meetingId}`);
    console.log(`Participants to sync: ${participants.length}`);
    console.log(`${'='.repeat(60)}\n`);

    const state = await getConsentState(meetingId);

    const oldParticipants = state.participants;
    console.log(`  📋 Existing participants in state: ${oldParticipants.length}`);

    // GUEST MODE HANDLING: If incoming list is smaller than existing, this is likely a guest
    // user who can't see all participants. Merge their data instead of replacing.
    const isLikelyGuestSync = participants.length < oldParticipants.length && oldParticipants.length > 0;

    if (isLikelyGuestSync) {
      console.log(`  👤 Guest mode sync detected: incoming ${participants.length}, existing ${oldParticipants.length}`);
      console.log(`  📝 Merging participants instead of replacing`);

      // Merge: Add/update participants from the incoming list, keep others unchanged
      participants.forEach(participant => {
        const existingIndex = oldParticipants.findIndex(p => p.participantUUID === participant.participantUUID);

        if (existingIndex >= 0) {
          // Update existing participant (preserve consent status)
          console.log(`  ✓ Updating: ${participant.screenName} (${oldParticipants[existingIndex].consentStatus})`);
          // Keep the old participant data (with consent status), just update basic info if needed
          oldParticipants[existingIndex].screenName = participant.screenName;
          oldParticipants[existingIndex].role = participant.role;
        } else {
          // Add new participant with pending status
          console.log(`  ➕ Adding: ${participant.screenName} (pending)`);
          oldParticipants.push({
            participantUUID: participant.participantUUID,
            participantID: participant.participantID,
            screenName: participant.screenName,
            role: participant.role,
            isHost: participant.isHost,
            isCoHost: participant.isCoHost,
            consentStatus: 'pending',
            joinedAt: new Date().toISOString()
          });
        }
      });

      state.participants = oldParticipants;
    } else {
      // HOST MODE: Full participant list from SDK - replace entire list
      console.log(`  🎯 Host mode sync: replacing participant list with SDK data`);

      // Map SDK participants to participant objects, preserving consent status if UUID matches
      state.participants = participants.map(participant => {
        // Try to find existing participant with same UUID to preserve consent status
        const existing = oldParticipants.find(p => p.participantUUID === participant.participantUUID);

        if (existing) {
          console.log(`  ✓ Preserving: ${participant.screenName} (${existing.consentStatus})`);
          return existing; // Keep existing data including consent status
        } else {
          console.log(`  ➕ Adding: ${participant.screenName} (pending)`);
          return {
            participantUUID: participant.participantUUID,
            participantID: participant.participantID,
            screenName: participant.screenName,
            role: participant.role,
            isHost: participant.isHost,
            isCoHost: participant.isCoHost,
            consentStatus: 'pending',
            joinedAt: new Date().toISOString()
          };
        }
      });
    }

    // Always save state (SDK is source of truth)
    await saveConsentState(meetingId, state);

    // Broadcast update via WebSocket
    if (wsServer) {
      console.log(`📡 Broadcasting initial state to all clients`);
      wsServer.broadcastFullState(meetingId, state);
    }

    console.log(`✅ Sync complete`);
    console.log(`   Total participants after sync: ${state.participants.length}`);
    console.log(`   Cleared ${oldParticipants.length - state.participants.length} webhook-added participants\n`);

    res.json({
      success: true,
      totalCount: state.participants.length
    });
  } catch (error) {
    console.error('❌ Error syncing participants:', error);
    res.status(500).json({ error: 'Failed to sync participants' });
  }
});

module.exports = router;
module.exports.setWebSocketServer = setWebSocketServer;
