import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useZoomSDK } from './ZoomSDKContext';
import { useWebSocket } from './WebSocketContext';

const ConsentContext = createContext(null);

export const useConsent = () => {
  const context = useContext(ConsentContext);
  if (!context) {
    throw new Error('useConsent must be used within ConsentProvider');
  }
  return context;
};

export const ConsentProvider = ({ children }) => {
  const { meetingContext, zoomSdk } = useZoomSDK();
  const { socket, isConnected, joinMeetingRoom } = useWebSocket();

  const [consentState, setConsentState] = useState({
    participants: [],
    rtmsStatus: 'stopped',
    rtmsPausedReason: null,
    unanimousConsent: false
  });

  const [myConsentStatus, setMyConsentStatus] = useState('pending');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRTMSStatus, setLastRTMSStatus] = useState('stopped');

  // Join WebSocket meeting room when connected
  useEffect(() => {
    if (isConnected && meetingContext?.meetingUUID) {
      joinMeetingRoom(meetingContext.meetingUUID);
    }
  }, [isConnected, meetingContext, joinMeetingRoom]);

  // Listen for WebSocket state updates
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleStateUpdate = (data) => {
      console.log('📩 Consent state update received via WebSocket');
      setConsentState(data);

      // Update my consent status if it changed
      if (meetingContext?.participantUUID) {
        const myParticipant = data.participants.find(
          p => p.participantUUID === meetingContext.participantUUID
        );
        if (myParticipant) {
          setMyConsentStatus(myParticipant.consentStatus);
        }
      }
    };

    const handleRTMSStatusChange = (data) => {
      console.log('📩 RTMS status change received:', data.rtmsStatus);
      setConsentState(prev => ({
        ...prev,
        rtmsStatus: data.rtmsStatus,
        rtmsPausedReason: data.rtmsPausedReason
      }));
    };

    socket.on('consent_state_update', handleStateUpdate);
    socket.on('full_state', handleStateUpdate);
    socket.on('rtms_status_changed', handleRTMSStatusChange);

    return () => {
      socket.off('consent_state_update', handleStateUpdate);
      socket.off('full_state', handleStateUpdate);
      socket.off('rtms_status_changed', handleRTMSStatusChange);
    };
  }, [socket, isConnected, meetingContext]);

  // Fetch initial consent state
  useEffect(() => {
    if (!meetingContext?.meetingUUID) return;

    const fetchConsentState = async () => {
      try {
        const response = await fetch(
          `/api/consent/status?meetingId=${encodeURIComponent(meetingContext.meetingUUID)}`
        );

        if (response.ok) {
          const data = await response.json();
          console.log('📥 Initial consent state fetched:', data);
          setConsentState(data);

          // Find my consent status
          const myParticipant = data.participants.find(
            p => p.participantUUID === meetingContext.participantUUID
          );
          if (myParticipant) {
            setMyConsentStatus(myParticipant.consentStatus);
          }
        }
      } catch (err) {
        console.error('Error fetching consent state:', err);
      }
    };

    fetchConsentState();
  }, [meetingContext]);

  // Handle RTMS SDK calls when status changes
  useEffect(() => {
    if (!zoomSdk || !meetingContext) return;

    const handleRTMSControl = async () => {
      const currentStatus = consentState.rtmsStatus;

      // Detect status changes
      if (currentStatus === lastRTMSStatus) return;

      console.log(`🎬 RTMS Status Change: ${lastRTMSStatus} → ${currentStatus}`);

      try {
        if (currentStatus === 'running' && lastRTMSStatus === 'stopped') {
          // Start RTMS when unanimous consent achieved
          console.log('🚀 Starting RTMS...');
          await zoomSdk.callZoomApi('startRTMS');
          console.log('✅ RTMS started successfully');
        } else if (currentStatus === 'paused' && lastRTMSStatus === 'running') {
          // Pause RTMS when new participant joins
          console.log('⏸️  Pausing RTMS...');
          await zoomSdk.callZoomApi('pauseRTMS');
          console.log('✅ RTMS paused successfully');
        } else if (currentStatus === 'running' && lastRTMSStatus === 'paused') {
          // Resume RTMS when new participant consents
          console.log('▶️  Resuming RTMS...');
          await zoomSdk.callZoomApi('resumeRTMS');
          console.log('✅ RTMS resumed successfully');
        } else if (currentStatus === 'stopped') {
          // Stop RTMS (e.g., participant declined consent)
          console.log('🛑 Stopping RTMS...');
          await zoomSdk.callZoomApi('stopRTMS');
          console.log('✅ RTMS stopped successfully');
        }

        setLastRTMSStatus(currentStatus);
      } catch (error) {
        console.error('❌ RTMS SDK call failed:', error);
        console.error('   Make sure startRTMS/stopRTMS/pauseRTMS/resumeRTMS are enabled in Zoom Marketplace');
      }
    };

    handleRTMSControl();
  }, [consentState.rtmsStatus, zoomSdk, meetingContext, lastRTMSStatus]);

  // Submit consent function
  const submitConsent = useCallback(async (status) => {
    // Validate required fields
    if (!meetingContext?.meetingUUID || !meetingContext?.participantUUID) {
      setError('Meeting information incomplete');
      console.error('❌ Cannot submit consent: missing meeting context', meetingContext);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      console.log('📤 Submitting consent:', {
        meetingId: meetingContext.meetingUUID,
        participantId: meetingContext.participantUUID,
        participantName: meetingContext.screenName,
        status
      });

      const response = await fetch('/api/consent/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          meetingId: meetingContext.meetingUUID,
          participantId: meetingContext.participantUUID,
          participantName: meetingContext.screenName || meetingContext.participantID || 'Unknown',
          consentStatus: status
        })
      });

      console.log('📡 Fetch response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Server returned error:', response.status, errorText);
        throw new Error(`Failed to submit consent: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      setMyConsentStatus(status);

      console.log('✅ Consent submitted successfully:', data);
    } catch (err) {
      console.error('❌ Error submitting consent:', err);
      console.error('❌ Error details:', {
        message: err.message,
        stack: err.stack
      });
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [meetingContext]);

  const value = {
    consentState,
    myConsentStatus,
    submitConsent,
    loading,
    error
  };

  return (
    <ConsentContext.Provider value={value}>
      {children}
    </ConsentContext.Provider>
  );
};
