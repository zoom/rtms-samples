import { useEffect, useRef, useCallback } from 'react';
import { useZoomSDK } from '../contexts/ZoomSDKContext';

/**
 * Hook for real-time participant tracking with SDK
 * Primary detection method for participant joins/leaves (host/co-host only).
 */
export const useParticipantTracking = () => {
  const { meetingContext, participants, zoomSdk, sendChatMessage, getAuthHeaders } = useZoomSDK();
  const previousParticipantsRef = useRef([]);
  const hasInitializedRef = useRef(false);

  const isHostOrCoHost =
    meetingContext?.role === 'host' ||
    meetingContext?.role === 'coHost' ||
    meetingContext?.isHostOrCoHost === true;

  const notifyBackendOfJoin = useCallback(async (participant) => {
    try {
      if (!isHostOrCoHost) {
        return null;
      }
      if (!meetingContext || !meetingContext.meetingUUID) {
        return null;
      }
      if (!participant || !participant.participantUUID) {
        return null;
      }

      const response = await fetch('/api/participants/joined', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
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

      return await response.json();
    } catch (error) {
      console.error('❌ Failed to notify backend of join:', error);
      throw error;
    }
  }, [meetingContext, isHostOrCoHost, getAuthHeaders]);

  const notifyBackendOfLeave = useCallback(async (participantUUID) => {
    try {
      if (!isHostOrCoHost) {
        return null;
      }
      if (!meetingContext || !meetingContext.meetingUUID || !participantUUID) {
        return null;
      }

      const response = await fetch('/api/participants/left', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          meetingId: meetingContext.meetingUUID,
          participantUUID
        })
      });

      if (!response.ok) {
        throw new Error(`Backend notification failed: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('❌ Failed to notify backend of leave:', error);
      throw error;
    }
  }, [meetingContext, isHostOrCoHost, getAuthHeaders]);

  // Detect participant changes (only after initial snapshot is captured, and only on host/co-host)
  useEffect(() => {
    if (!participants || participants.length === 0) {
      return;
    }

    // First non-empty participant snapshot on app load: seed baseline without treating
    // already-present participants as newly joined (useInitialParticipantSync handles initial sync).
    if (!hasInitializedRef.current) {
      previousParticipantsRef.current = participants;
      hasInitializedRef.current = true;
      return;
    }

    if (!isHostOrCoHost) {
      previousParticipantsRef.current = participants;
      return;
    }

    const previousParticipants = previousParticipantsRef.current;

    const newParticipants = participants.filter(current =>
      !previousParticipants.some(prev => prev.participantUUID === current.participantUUID)
    );

    const leftParticipants = previousParticipants.filter(prev =>
      !participants.some(current => current.participantUUID === prev.participantUUID)
    );

    if (newParticipants.length > 0) {
      newParticipants.forEach(participant => {
        notifyBackendOfJoin(participant).catch(err => {
          console.error('Join notification failed:', err);
        });
      });

      // Strictly gate app invitations to host/co-host clients
      if (zoomSdk && isHostOrCoHost) {
        zoomSdk.sendAppInvitationToAllParticipants()
          .catch(err => {
            console.error('❌ Failed to send app invitation:', err.message);
          });
      }

      const ENABLE_CHAT_CONSENT = false;
      if (ENABLE_CHAT_CONSENT && sendChatMessage) {
        const consentMessage = `⚠️ Transcript Consent Required\n\n` +
          `Please respond to consent to transcript access:\n` +
          `• Type "I consent" to agree\n` +
          `• Type "I decline" to decline\n\n` +
          `Your response will be recorded for this meeting only.`;

        sendChatMessage(consentMessage).catch(err => {
          console.error('Failed to send consent instructions via chat:', err);
        });
      }
    }

    if (leftParticipants.length > 0) {
      leftParticipants.forEach(participant => {
        notifyBackendOfLeave(participant.participantUUID).catch(err => {
          console.error('Leave notification failed:', err);
        });
      });
    }

    previousParticipantsRef.current = participants;
  }, [participants, isHostOrCoHost, zoomSdk, sendChatMessage, notifyBackendOfJoin, notifyBackendOfLeave]);

  return {
    notifyBackendOfJoin,
    notifyBackendOfLeave
  };
};
