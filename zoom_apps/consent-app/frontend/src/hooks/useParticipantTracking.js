import { useEffect, useRef, useCallback } from 'react';
import { useZoomSDK } from '../contexts/ZoomSDKContext';

/**
 * Hook for real-time participant tracking with SDK
 * Primary detection method for participant joins/leaves
 */
export const useParticipantTracking = () => {
  const { meetingContext, participants, zoomSdk, sendChatMessage } = useZoomSDK();
  const previousParticipantsRef = useRef([]);

  const notifyBackendOfJoin = useCallback(async (participant) => {
    try {
      // Validate we have meeting context
      if (!meetingContext || !meetingContext.meetingUUID) {
        console.warn('⚠️  Meeting context not available, skipping participant join notification');
        return null;
      }

      // Validate participant data
      if (!participant || !participant.participantUUID) {
        console.warn('⚠️  Invalid participant data, skipping notification');
        return null;
      }

      console.log('🔔 Notifying backend of participant join:', participant.screenName);

      const response = await fetch('/api/participants/joined', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingId: meetingContext.meetingUUID,
          participant: {
            participantUUID: participant.participantUUID,
            participantID: participant.participantID,
            screenName: participant.screenName,
            role: participant.role,
            isHost: participant.isHost,
            isCoHost: participant.isCoHost
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Backend notification failed: ${response.status}`);
      }

      const result = await response.json();
      console.log('✅ Backend notified, RTMS status:', result.rtmsStatus);

      return result;
    } catch (error) {
      console.error('❌ Failed to notify backend of join:', error);
      throw error;
    }
  }, [meetingContext]);

  const notifyBackendOfLeave = useCallback(async (participantUUID) => {
    try {
      // Validate we have meeting context
      if (!meetingContext || !meetingContext.meetingUUID) {
        console.warn('⚠️  Meeting context not available, skipping participant leave notification');
        return null;
      }

      // Validate participantUUID
      if (!participantUUID) {
        console.warn('⚠️  Invalid participantUUID, skipping notification');
        return null;
      }

      console.log('🔔 Notifying backend of participant leave:', participantUUID);

      const response = await fetch('/api/participants/left', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingId: meetingContext.meetingUUID,
          participantUUID
        })
      });

      if (!response.ok) {
        throw new Error(`Backend notification failed: ${response.status}`);
      }

      const result = await response.json();
      console.log('✅ Backend notified of leave, RTMS status:', result.rtmsStatus);

      return result;
    } catch (error) {
      console.error('❌ Failed to notify backend of leave:', error);
      throw error;
    }
  }, [meetingContext]);

  // Detect participant changes
  useEffect(() => {
    if (!participants || participants.length === 0) {
      previousParticipantsRef.current = [];
      return;
    }

    const previousParticipants = previousParticipantsRef.current;

    // Find new participants (joined)
    const newParticipants = participants.filter(current =>
      !previousParticipants.some(prev =>
        prev.participantUUID === current.participantUUID
      )
    );

    // Find removed participants (left)
    const leftParticipants = previousParticipants.filter(prev =>
      !participants.some(current =>
        current.participantUUID === prev.participantUUID
      )
    );

    // Notify backend of joins and invite new participants to open the app
    if (newParticipants.length > 0) {
      console.log(`📥 ${newParticipants.length} new participant(s) detected`);

      // Notify backend
      newParticipants.forEach(participant => {
        notifyBackendOfJoin(participant).catch(err => {
          console.error('Join notification failed:', err);
        });
      });

      // Send app invitation to all participants (only if user is host)
      // Only hosts can send invitations - guests and attendees cannot
      const isHost = meetingContext?.role === 'host' || meetingContext?.role === 'coHost';

      if (zoomSdk && isHost) {
        console.log('📨 Sending app invitation to all participants (host privilege)...');
        zoomSdk.sendAppInvitationToAllParticipants()
          .then(() => {
            console.log('✅ App invitation sent successfully');
          })
          .catch(err => {
            console.error('❌ Failed to send app invitation:', err.message);
            console.error('   Make sure "sendAppInvitationToAllParticipants" is enabled in Zoom Marketplace');
          });
      } else if (!isHost) {
        console.log(`👤 Non-host user (${meetingContext?.role}): Cannot send app invitations (requires host role)`);
      }

      // FEATURE FLAG: Chat-based consent (disabled for compliance review)
      // Chat consent requires DLP integration and may raise compliance questions
      // To re-enable: set ENABLE_CHAT_CONSENT = true
      const ENABLE_CHAT_CONSENT = false;

      if (ENABLE_CHAT_CONSENT && sendChatMessage) {
        const consentMessage = `⚠️ Transcript Consent Required\n\n` +
          `Please respond to consent to transcript access:\n` +
          `• Type "I consent" to agree\n` +
          `• Type "I decline" to decline\n\n` +
          `Your response will be recorded for this meeting only.`;

        console.log('📨 Sending chat-based consent instructions...');
        sendChatMessage(consentMessage).catch(err => {
          console.error('Failed to send consent instructions via chat:', err);
        });
      } else if (!ENABLE_CHAT_CONSENT) {
        console.log('💬 Chat-based consent disabled (feature flag: ENABLE_CHAT_CONSENT = false)');
      }
    }

    // Notify backend of leaves
    if (leftParticipants.length > 0) {
      console.log(`📤 ${leftParticipants.length} participant(s) left`);
      leftParticipants.forEach(participant => {
        notifyBackendOfLeave(participant.participantUUID).catch(err => {
          console.error('Leave notification failed:', err);
        });
      });
    }

    // Update reference
    previousParticipantsRef.current = participants;
  }, [participants, notifyBackendOfJoin, notifyBackendOfLeave]);

  return {
    notifyBackendOfJoin,
    notifyBackendOfLeave
  };
};
