import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useZoomSDK } from './ZoomSDKContext';
import { useWebSocket } from './WebSocketContext';

const ConsentContext = createContext(null);

function isActiveStatus(status) {
  return status === 'running' || status === 'active';
}

export const useConsent = () => {
  const context = useContext(ConsentContext);
  if (!context) {
    throw new Error('useConsent must be used within ConsentProvider');
  }
  return context;
};

export const ConsentProvider = ({ children }) => {
  const { meetingContext, zoomSdk, appContextToken, getAuthHeaders } = useZoomSDK();
  const { socket, isConnected, joinMeetingRoom } = useWebSocket();

  const [consentState, setConsentState] = useState({
    participants: [],
    policyMode: 'unanimous',
    rtmsStatus: 'stopped',
    rtmsPausedReason: null,
    unanimousConsent: false,
    auditTrail: []
  });

  const [myConsentStatus, setMyConsentStatus] = useState('pending');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRTMSStatus, setLastRTMSStatus] = useState('stopped');

  const isHostOrCoHost =
    meetingContext?.role === 'host' ||
    meetingContext?.role === 'coHost' ||
    meetingContext?.isHostOrCoHost === true;

  // Join WebSocket meeting room when connected
  useEffect(() => {
    if (isConnected && meetingContext?.meetingUUID) {
      joinMeetingRoom(meetingContext.meetingUUID, appContextToken);
    }
  }, [isConnected, meetingContext, appContextToken, joinMeetingRoom]);

  // Listen for WebSocket state updates
  useEffect(() => {
    if (!socket || !isConnected) return;

    const handleStateUpdate = (data) => {
      setConsentState(data);

      if (meetingContext?.participantUUID && Array.isArray(data.participants)) {
        const myParticipant = data.participants.find(
          p => p.participantUUID === meetingContext.participantUUID
        );
        if (myParticipant) {
          setMyConsentStatus(myParticipant.consentStatus);
        }
      }
    };

    const handleRTMSStatusChange = (data) => {
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
          `/api/consent/status?meetingId=${encodeURIComponent(meetingContext.meetingUUID)}`,
          {
            credentials: 'include',
            headers: getAuthHeaders()
          }
        );

        if (response.ok) {
          const data = await response.json();
          setConsentState(data);
          setLastRTMSStatus(data.rtmsStatus || 'stopped');

          const myParticipant = (data.participants || []).find(
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
  }, [meetingContext, getAuthHeaders]);

  // Handle RTMS SDK calls when status changes — STRICTLY gated to host/co-host clients
  useEffect(() => {
    if (!zoomSdk || !meetingContext) return;
    if (!isHostOrCoHost) {
      setLastRTMSStatus(consentState.rtmsStatus);
      return;
    }

    const handleRTMSControl = async () => {
      const currentStatus = consentState.rtmsStatus;

      if (currentStatus === lastRTMSStatus) return;

      try {
        if (isActiveStatus(currentStatus) && lastRTMSStatus === 'stopped') {
          await zoomSdk.callZoomApi('startRTMS');
        } else if (currentStatus === 'paused' && isActiveStatus(lastRTMSStatus)) {
          await zoomSdk.callZoomApi('pauseRTMS');
        } else if (isActiveStatus(currentStatus) && lastRTMSStatus === 'paused') {
          await zoomSdk.callZoomApi('resumeRTMS');
        } else if (currentStatus === 'stopped') {
          await zoomSdk.callZoomApi('stopRTMS');
        }

        setLastRTMSStatus(currentStatus);
      } catch (err) {
        console.error('❌ RTMS SDK call failed:', err);
      }
    };

    handleRTMSControl();
  }, [consentState.rtmsStatus, zoomSdk, meetingContext, isHostOrCoHost, lastRTMSStatus]);

  // Submit consent function
  const submitConsent = useCallback(async (status) => {
    if (!meetingContext?.meetingUUID || !meetingContext?.participantUUID) {
      setError('Meeting information incomplete');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/consent/submit', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          meetingId: meetingContext.meetingUUID,
          participantId: meetingContext.participantUUID,
          participantName: meetingContext.screenName || meetingContext.participantID || 'Unknown',
          consentStatus: status
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to submit consent: ${response.status} ${errorText}`);
      }

      await response.json();
      setMyConsentStatus(status);
    } catch (err) {
      console.error('❌ Error submitting consent:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [meetingContext, getAuthHeaders]);

  // Update consent policy mode ('unanimous' | 'redact') — host/co-host only
  const updatePolicyMode = useCallback(async (policyMode) => {
    if (!isHostOrCoHost || !meetingContext?.meetingUUID) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/consent/policy', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          meetingId: meetingContext.meetingUUID,
          policyMode
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to update policy mode: ${response.status} ${errorText}`);
      }
    } catch (err) {
      console.error('❌ Error updating policy mode:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isHostOrCoHost, meetingContext, getAuthHeaders]);

  const value = {
    consentState,
    myConsentStatus,
    submitConsent,
    updatePolicyMode,
    isHostOrCoHost,
    loading,
    error
  };

  return (
    <ConsentContext.Provider value={value}>
      {children}
    </ConsentContext.Provider>
  );
};
