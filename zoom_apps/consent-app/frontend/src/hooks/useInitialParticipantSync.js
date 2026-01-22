import { useEffect, useRef } from 'react';
import { useZoomSDK } from '../contexts/ZoomSDKContext';

/**
 * Hook to sync initial participant list with backend
 * Runs once on app load to ensure backend knows about all current participants
 */
export const useInitialParticipantSync = () => {
  const { meetingContext, participants } = useZoomSDK();
  const syncedRef = useRef(false);

  useEffect(() => {
    // Need meeting context to sync
    if (!meetingContext?.meetingUUID) {
      return;
    }

    // Don't sync twice
    if (syncedRef.current) {
      return;
    }

    const syncInitialParticipants = async () => {
      try {
        // For guest mode users who can't get participant list, sync at least themselves
        let participantsToSync = participants;

        if (!participants || participants.length === 0) {
          // Guest mode: can't get full participant list, but we can sync ourselves
          if (meetingContext.participantUUID && meetingContext.screenName) {
            console.log('👤 Guest Mode: Syncing self as participant');
            participantsToSync = [{
              participantUUID: meetingContext.participantUUID,
              participantID: meetingContext.participantUUID, // Use UUID as ID for guests
              screenName: meetingContext.screenName,
              role: meetingContext.role || 'attendee',
              isHost: meetingContext.role === 'host',
              isCoHost: meetingContext.role === 'coHost'
            }];
          } else {
            console.warn('⚠️  No participant data available to sync');
            return;
          }
        }

        console.log('\n' + '='.repeat(60));
        console.log('🔄 SYNCING INITIAL PARTICIPANTS');
        console.log('='.repeat(60));
        console.log(`Meeting: ${meetingContext.meetingUUID}`);
        console.log(`Participants to sync: ${participantsToSync.length}`);
        console.log(`Guest Mode: ${meetingContext.isGuestMode || false}`);
        console.log('='.repeat(60) + '\n');

        const response = await fetch('/api/participants/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

        const result = await response.json();
        console.log('✅ Initial participant sync complete');
        console.log(`   Synced: ${result.syncedCount} participants`);
        console.log(`   Already tracked: ${result.alreadyTrackedCount} participants\n`);

        syncedRef.current = true;
      } catch (error) {
        console.error('❌ Failed to sync initial participants:', error);
        // Don't mark as synced so it can retry
      }
    };

    syncInitialParticipants();
  }, [meetingContext, participants]);
};
