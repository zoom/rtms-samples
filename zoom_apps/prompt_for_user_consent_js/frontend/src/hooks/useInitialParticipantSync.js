import { useEffect, useRef } from 'react';
import { useZoomSDK } from '../contexts/ZoomSDKContext';

/**
 * Hook to sync initial participant list with backend
 * Runs once on app load to ensure backend knows about all current participants
 */
export const useInitialParticipantSync = () => {
  const { meetingContext, participants, getAuthHeaders } = useZoomSDK();
  const syncedRef = useRef(false);

  useEffect(() => {
    if (!meetingContext?.meetingUUID || syncedRef.current) {
      return;
    }

    const syncInitialParticipants = async () => {
      try {
        let participantsToSync = participants;

        if (!participants || participants.length === 0) {
          if (meetingContext.participantUUID && meetingContext.screenName) {
            participantsToSync = [{
              participantUUID: meetingContext.participantUUID,
              participantID: meetingContext.participantUUID,
              screenName: meetingContext.screenName,
              role: meetingContext.role || 'attendee',
              isHost: meetingContext.role === 'host',
              isCoHost: meetingContext.role === 'coHost'
            }];
          } else {
            return;
          }
        }

        const response = await fetch('/api/participants/sync', {
          method: 'POST',
          credentials: 'include',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            meetingId: meetingContext.meetingUUID,
            participants: participantsToSync.map(p => ({
              participantUUID: p.participantUUID,
              participantID: p.participantID,
              screenName: p.screenName,
              role: p.role,
              isHost: p.isHost,
              isCoHost: p.isCoHost
            }))
          })
        });

        if (!response.ok) {
          throw new Error(`Sync failed: ${response.status}`);
        }

        await response.json();
        syncedRef.current = true;
      } catch (error) {
        console.error('❌ Failed to sync initial participants:', error);
      }
    };

    syncInitialParticipants();
  }, [meetingContext, participants, getAuthHeaders]);
};
