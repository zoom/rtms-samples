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
  const [appContextToken, setAppContextToken] = useState(null);

  useEffect(() => {
    setSdkReady(true);

    const fetchMeetingContext = async () => {
      try {
        let userContext = null;
        let participantUUID = null;
        let screenName = null;
        let userStatus = 'unknown';

        try {
          userContext = await zoomSdk.getUserContext();
          participantUUID = userContext?.participantUUID || null;
          screenName = userContext?.screenName || null;
          userStatus = userContext?.status || 'unknown';
        } catch (userError) {
          console.error('❌ getUserContext failed:', userError.message);
          return;
        }

        let meetingUUID = null;
        try {
          const uuidResult = await zoomSdk.getMeetingUUID();
          meetingUUID = uuidResult?.meetingUUID || null;
        } catch (uuidError) {
          console.warn('⚠️  getMeetingUUID failed:', uuidError.message);
        }

        // Retrieve signed x-zoom-app-context from Zoom SDK if supported
        try {
          if (typeof zoomSdk.getAppContext === 'function') {
            const ctxResult = await zoomSdk.getAppContext();
            if (ctxResult?.context) {
              setAppContextToken(ctxResult.context);
            }
          }
        } catch (ctxErr) {
          console.warn('⚠️  getAppContext unavailable:', ctxErr.message);
        }

        let sdkMeetingContext = null;
        try {
          sdkMeetingContext = await zoomSdk.getMeetingContext();
        } catch (contextError) {
          if (!contextError.message.includes('require_meeting_role') && !contextError.message.includes('80012')) {
            console.warn('⚠️  getMeetingContext failed:', contextError.message);
          }
        }

        const role = userContext?.role || 'participant';
        const isHostRole = role === 'host' || role === 'coHost';

        const completeContext = {
          meetingID: sdkMeetingContext?.meetingID || meetingUUID || 'unknown',
          meetingTopic: sdkMeetingContext?.meetingTopic || 'Meeting',
          role,
          isHost: role === 'host',
          isCoHost: role === 'coHost',
          isHostOrCoHost: isHostRole,
          participantUUID,
          screenName,
          userStatus,
          meetingUUID,
          isGuestMode: userStatus === 'unauthenticated' || !sdkMeetingContext
        };

        setMeetingContext(completeContext);
      } catch (error) {
        console.error('❌ ZoomSDKContext: Failed to fetch meeting context:', error.message);
      }
    };

    const fetchParticipants = async () => {
      try {
        const { participants: participantList } = await zoomSdk.getMeetingParticipants();
        setParticipants(participantList);
      } catch (error) {
        if (error.message.includes('require_meeting_role') || error.message.includes('80012')) {
          setParticipants([]);
        } else {
          console.error('❌ ZoomSDKContext: getMeetingParticipants failed:', error.message);
        }
      }
    };

    fetchMeetingContext();
    fetchParticipants();

    const handleParticipantChange = async () => {
      await fetchParticipants();
    };

    try {
      zoomSdk.addEventListener('onParticipantChange', handleParticipantChange);
    } catch (error) {
      console.error('❌ ZoomSDKContext: addEventListener for onParticipantChange failed:', error.message);
    }

    return () => {
      try {
        zoomSdk.removeEventListener('onParticipantChange', handleParticipantChange);
      } catch {
        // Ignore cleanup errors
      }
    };
  }, []);

  const refreshParticipants = async () => {
    try {
      const { participants: participantList } = await zoomSdk.getMeetingParticipants();
      setParticipants(participantList);
      return participantList;
    } catch (error) {
      console.error('❌ refreshParticipants failed:', error.message);
      return [];
    }
  };

  const sendChatMessage = async (message) => {
    try {
      await zoomSdk.sendMessageToChat({ message });
      return true;
    } catch (error) {
      console.error('❌ Failed to send chat message:', error.message);
      return false;
    }
  };

  const getAuthHeaders = (extra = {}) => ({
    ...extra,
    ...(appContextToken ? { 'x-zoom-app-context': appContextToken } : {})
  });

  const value = {
    sdkReady,
    meetingContext,
    participants,
    appContextToken,
    getAuthHeaders,
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
