/* globals zoomSdk */
import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';

// Contexts
import { ZoomSDKProvider } from './contexts/ZoomSDKContext';
import { ConsentProvider } from './contexts/ConsentContext';
import { WebSocketProvider } from './contexts/WebSocketContext';

// Hooks
import { useParticipantTracking } from './hooks/useParticipantTracking';
import { useInitialParticipantSync } from './hooks/useInitialParticipantSync';

// Components
import HostDashboard from './components/HostDashboard';
import GuestView from './components/GuestView';
import Header from './components/Header';

// Participant tracking wrapper component
function AppWithTracking({ isHost, runningContext, userContextStatus }) {
  // Sync initial participants on app load
  useInitialParticipantSync();

  // Enable real-time participant tracking (SDK-based)
  useParticipantTracking();

  return (
    <>
      <Header isHost={isHost} runningContext={runningContext} />
      <Routes>
        <Route
          path="/"
          element={
            isHost ? (
              <Navigate to="/host" replace />
            ) : (
              <Navigate to="/guest" replace />
            )
          }
        />
        <Route
          path="/host"
          element={
            isHost ? (
              <HostDashboard
                runningContext={runningContext}
                userContextStatus={userContextStatus}
              />
            ) : (
              <Navigate to="/guest" replace />
            )
          }
        />
        <Route
          path="/guest"
          element={<GuestView />}
        />
      </Routes>
    </>
  );
}

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [runningContext, setRunningContext] = useState(null);
  const [userContextStatus, setUserContextStatus] = useState('');

  useEffect(() => {
    async function initializeApp() {
      try {
        console.log('Initializing Zoom Apps SDK...');

        // Configure SDK with required capabilities
        const configResponse = await zoomSdk.config({
          capabilities: [
            // Meeting Context
            'getMeetingContext',
            'getMeetingUUID',
            'getMeetingParticipants',
            'getRunningContext',

            // User Context
            'getUserContext',
            'authorize',
            'onAuthorized',
            'onMyUserContextChange',

            // Participant Events
            'onParticipantChange',

            // RTMS Control
            'startRTMS',
            'stopRTMS',
            'pauseRTMS',
            'resumeRTMS',

            // Multi-Instance Communication
            'connect',
            'postMessage',
            'onMessage',
            'onConnect',

            // UI
            'showNotification',
            'sendAppInvitationToAllParticipants'
          ],
          version: '0.16.0'
        });

        console.log('✅ SDK Configuration Response:', configResponse);

        // Check which APIs are actually supported
        try {
          const supportedApis = await zoomSdk.getSupportedJsApis();
          console.log('📋 Supported APIs:', supportedApis);

          // Check for any unsupported APIs we requested
          const requestedApis = [
            'getMeetingContext', 'getMeetingUUID', 'getMeetingParticipants', 'getRunningContext',
            'getUserContext', 'authorize', 'onAuthorized', 'onMyUserContextChange',
            'onParticipantChange', 'startRTMS', 'stopRTMS', 'pauseRTMS', 'resumeRTMS',
            'connect', 'postMessage', 'onMessage', 'onConnect',
            'showNotification', 'sendAppInvitationToAllParticipants'
          ];

          const unsupportedApis = requestedApis.filter(api => !supportedApis.apis.includes(api));
          if (unsupportedApis.length > 0) {
            console.warn('⚠️  UNSUPPORTED APIs (not available in current context or not enabled in Zoom Marketplace):', unsupportedApis);
          } else {
            console.log('✅ All requested APIs are supported!');
          }
        } catch (apiCheckErr) {
          console.warn('Could not check supported APIs:', apiCheckErr);
        }

        // Get running context
        let context;
        try {
          const runningContextResult = await zoomSdk.getRunningContext();
          context = runningContextResult.context;
          setRunningContext(context);
          console.log('✅ Running Context:', context);
        } catch (err) {
          console.error('❌ getRunningContext failed:', err.message);
          throw new Error(`getRunningContext API not supported: ${err.message}`);
        }

        // Get user context to determine role and status
        let userContext;
        try {
          userContext = await zoomSdk.getUserContext();
          setUserContextStatus(userContext.status);
          console.log('✅ User Context:', userContext);
        } catch (err) {
          console.error('❌ getUserContext failed:', err.message);
          throw new Error(`getUserContext API not supported: ${err.message}`);
        }

        // Determine if user is host based on role from getUserContext
        // getUserContext returns role field which works for all users (host, attendee, guest)
        if (context === 'inMeeting') {
          const userRole = userContext.role;
          const isHostRole = userRole === 'host' || userRole === 'coHost';
          setIsHost(isHostRole);
          console.log('✅ User Role:', userRole);
          console.log('✅ Is Host:', isHostRole);

          // Only try to get full meeting context if user is host/coHost
          // getMeetingContext requires host permissions and will fail for attendees/guests
          if (isHostRole) {
            try {
              const meetingContext = await zoomSdk.getMeetingContext();
              console.log('✅ Meeting Context (host):', meetingContext);
            } catch (err) {
              console.warn('⚠️  getMeetingContext failed even for host:', err.message);
              // Don't throw - we already have what we need from getUserContext
            }
          } else {
            console.log('👤 Non-host user (attendee/guest): skipping getMeetingContext (requires host role)');
          }
        }

        console.log('✅ Zoom SDK Configured Successfully');
        setLoading(false);
      } catch (err) {
        console.error('❌ Error initializing app:', err);
        setError(err.message || 'Failed to initialize app');
        setLoading(false);
      }
    }

    initializeApp();
  }, []);

  if (loading) {
    return (
      <div className="container mt-5 text-center">
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
        <p className="mt-3">Initializing Zoom App...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mt-5">
        <div className="alert alert-danger" role="alert">
          <h4 className="alert-heading">Error</h4>
          <p>{error}</p>
          <hr />
          <p className="mb-0">Please refresh the page or contact support.</p>
        </div>
      </div>
    );
  }

  return (
    <Router>
      <ZoomSDKProvider>
        <WebSocketProvider>
          <ConsentProvider>
            <div className="App">
              <AppWithTracking
                isHost={isHost}
                runningContext={runningContext}
                userContextStatus={userContextStatus}
              />
            </div>
          </ConsentProvider>
        </WebSocketProvider>
      </ZoomSDKProvider>
    </Router>
  );
}

export default App;
