import React from 'react';
import { Container } from 'react-bootstrap';
import ConsentPrompt from './ConsentPrompt';
import ConsentNotification from './ConsentNotification';
import { useWebSocket } from '../contexts/WebSocketContext';

function GuestView() {
  const { isConnected } = useWebSocket();

  return (
    <Container className="guest-view">
      <div className="text-center mb-4">
        <h2>Welcome</h2>
        <p className="text-muted">
          Please review and respond to the consent request below
        </p>

        {!isConnected && (
          <div className="alert alert-warning">
            <div className="spinner-border spinner-border-sm me-2" />
            Connecting to server...
          </div>
        )}
      </div>

      <ConsentPrompt />

      <div className="mt-4">
        <ConsentNotification />
      </div>
    </Container>
  );
}

export default GuestView;
