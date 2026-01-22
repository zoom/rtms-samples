/* globals zoomSdk */
import React, { createContext, useContext, useState, useEffect } from 'react';

const ZoomSDKContext = createContext(null);

export const useZoomSDK = () => {
  const context = useContext(ZoomSDKContext);
  if (!context) {
    throw new Error('useZoomSDK must be used within ZoomSDKProvider');
  }
  return context;
};

export const ZoomSDKProvider = ({ children }) => {
  const [sdkReady, setSdkReady] = useState(false);
  const [meetingContext, setMeetingContext] = useState(null);
  const [participants, setParticipants] = useState([]);

  useEffect(() => {
    // SDK is initialized in App.js, mark as ready
    setSdkReady(true);

    // Fetch meeting context (combining multiple SDK calls)
    const fetchMeetingContext = async () => {
      try {
        // STEP 1: Get user context first (works for all users including guests)
        let userContext = null;
        let participantUUID = null;
        let screenName = null;
        let userStatus = 'unknown';

        try {
          userContext = await zoomSdk.getUserContext();
          participantUUID = userContext?.participantUUID || null;
          screenName = userContext?.screenName || null;
          userStatus = userContext?.status || 'unknown';

          console.log('📋 User Context:', {
            status: userStatus,
            participantUUID,
            screenName,
            role: userContext?.role
          });
        } catch (userError) {
          console.error('❌ getUserContext failed:', userError.message);
          // This is critical - if we can't get user context, we can't proceed
          return;
        }

        // STEP 2: Get meeting UUID (should work for all users)
        let meetingUUID = null;
        try {
          const uuidResult = await zoomSdk.getMeetingUUID();
          meetingUUID = uuidResult?.meetingUUID || null;
          console.log('📋 Meeting UUID:', meetingUUID);
        } catch (uuidError) {
          console.warn('⚠️  getMeetingUUID failed:', uuidError.message);
        }

        // STEP 3: Try to get full meeting context (only works for authorized users)
        let meetingContext = null;
        try {
          meetingContext = await zoomSdk.getMeetingContext();
          console.log('✅ getMeetingContext succeeded (authorized user)');
        } catch (contextError) {
          // Guest mode users will fail here with "require_meeting_role" error
          if (contextError.message.includes('require_meeting_role') || contextError.message.includes('80012')) {
            console.log('👤 Guest Mode: getMeetingContext not available (expected for guests)');
            console.log('   Building context from available APIs...');
          } else {
            console.warn('⚠️  getMeetingContext failed:', contextError.message);
          }
          // For guests, we'll build a minimal context below
        }

        // STEP 4: Build complete context (works for both authorized users and guests)
        const completeContext = {
          // If we got meetingContext, use it; otherwise provide minimal guest context
          meetingID: meetingContext?.meetingID || meetingUUID || 'unknown',
          meetingTopic: meetingContext?.meetingTopic || 'Meeting',
          role: userContext?.role || 'participant',

          // These come from user context (works for all users)
          participantUUID: participantUUID,
          screenName: screenName,
          userStatus: userStatus,

          // Meeting UUID (works for all users)
          meetingUUID: meetingUUID,

          // Guest mode flag
          isGuestMode: userStatus === 'unauthenticated' || !meetingContext
        };

        setMeetingContext(completeContext);
        console.log('✅ ZoomSDKContext: Complete meeting context:', completeContext);

        if (completeContext.isGuestMode) {
          console.log('👤 Running in Guest Mode');
          console.log('   Guest users have limited API access');
          console.log('   To enable full features, user can sign in via promptAuthorize()');
        }
      } catch (error) {
        console.error('❌ ZoomSDKContext: Failed to fetch meeting context:', error.message);
        console.error('   This is unexpected - at minimum getUserContext should work');
      }
    };

    // Fetch participants (may be restricted for guest users)
    const fetchParticipants = async () => {
      try {
        const { participants: participantList } = await zoomSdk.getMeetingParticipants();
        setParticipants(participantList);
        console.log('✅ ZoomSDKContext: Participants fetched:', participantList.length);

        // DEBUG: Log participant UUIDs to compare with getUserContext
        console.log('📋 Participant UUIDs from getMeetingParticipants:');
        participantList.forEach(p => {
          console.log(`   ${p.screenName}: ${p.participantUUID}`);
        });
      } catch (error) {
        // Guest mode users may not have access to getMeetingParticipants
        if (error.message.includes('require_meeting_role') || error.message.includes('80012')) {
          console.log('👤 Guest Mode: getMeetingParticipants not available (expected for guests)');
          console.log('   Guests will see limited participant information');
          setParticipants([]); // Empty list for guests
        } else {
          console.error('❌ ZoomSDKContext: getMeetingParticipants failed:', error.message);
          console.error('   Make sure "getMeetingParticipants" is enabled in Zoom Marketplace > Features > Zoom Apps SDK');
        }
      }
    };

    fetchMeetingContext();
    fetchParticipants();

    // Listen for participant changes
    const handleParticipantChange = async () => {
      console.log('✅ Participant change detected');
      await fetchParticipants();
    };

    try {
      zoomSdk.addEventListener('onParticipantChange', handleParticipantChange);
    } catch (error) {
      console.error('❌ ZoomSDKContext: addEventListener for onParticipantChange failed:', error.message);
      console.error('   Make sure "onParticipantChange" is enabled in Zoom Marketplace > Features > Zoom Apps SDK');
    }

    return () => {
      try {
        zoomSdk.removeEventListener('onParticipantChange', handleParticipantChange);
      } catch (error) {
        // Ignore cleanup errors
      }
    };
  }, []);

  const refreshParticipants = async () => {
    try {
      const { participants: participantList } = await zoomSdk.getMeetingParticipants();
      setParticipants(participantList);
      console.log('✅ Participants refreshed:', participantList.length);
      return participantList;
    } catch (error) {
      console.error('❌ refreshParticipants: getMeetingParticipants failed:', error.message);
      console.error('   Make sure "getMeetingParticipants" is enabled in Zoom Marketplace > Features > Zoom Apps SDK');
      return [];
    }
  };

  const sendChatMessage = async (message) => {
    try {
      console.log('📤 Sending chat message:', message);
      await zoomSdk.sendMessageToChat({ message });
      console.log('✅ Chat message sent successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to send chat message:', error.message);
      console.error('   Make sure "sendMessageToChat" is enabled in Zoom Marketplace > Features > Zoom Apps SDK');
      return false;
    }
  };

  const value = {
    sdkReady,
    meetingContext,
    participants,
    refreshParticipants,
    sendChatMessage,
    zoomSdk: typeof zoomSdk !== 'undefined' ? zoomSdk : null
  };

  return (
    <ZoomSDKContext.Provider value={value}>
      {children}
    </ZoomSDKContext.Provider>
  );
};
