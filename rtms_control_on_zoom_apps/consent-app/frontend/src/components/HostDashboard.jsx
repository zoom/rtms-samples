import React from 'react';
import { Container, Row, Col, Card, Badge } from 'react-bootstrap';
import ConsentPrompt from './ConsentPrompt';
import ConsentNotification from './ConsentNotification';
import ParticipantList from './ParticipantList';
import RTMSStatus from './RTMSStatus';
import { useConsent } from '../contexts/ConsentContext';
import { useZoomSDK } from '../contexts/ZoomSDKContext';
import { useWebSocket } from '../contexts/WebSocketContext';

function HostDashboard({ runningContext, userContextStatus }) {
  const { consentState } = useConsent();
  const { participants } = useZoomSDK();
  const { isConnected, meetingRoomJoined } = useWebSocket();

  return (
    <Container className="host-dashboard">
      <Row>
        <Col>
          <div className="d-flex justify-content-between align-items-center mb-4">
            <h2 className="mb-0">Host Dashboard</h2>
            {meetingRoomJoined && (
              <Badge bg="success">
                <i className="bi bi-broadcast"></i> Live Updates Active
              </Badge>
            )}
          </div>

          {!isConnected && (
            <div className="alert alert-warning mb-4">
              <div className="spinner-border spinner-border-sm me-2" />
              Connecting to server...
            </div>
          )}

          {runningContext !== 'inMeeting' && (
            <div className="alert alert-info mb-4">
              This dashboard is most useful when in a meeting. Join a meeting to see
              real-time participant consent status and RTMS controls.
            </div>
          )}
        </Col>
      </Row>

      <Row>
        <Col lg={8}>
          <ConsentNotification />

          <Card className="mb-4">
            <Card.Header>
              <h5 className="mb-0">Your Consent</h5>
            </Card.Header>
            <Card.Body>
              <ConsentPrompt />
            </Card.Body>
          </Card>

          <ParticipantList
            participants={participants}
            consentState={consentState}
          />
        </Col>

        <Col lg={4}>
          <RTMSStatus
            rtmsStatus={consentState.rtmsStatus}
            rtmsPausedReason={consentState.rtmsPausedReason}
            unanimousConsent={consentState.unanimousConsent}
          />

          <Card className="mb-4">
            <Card.Header>
              <h6 className="mb-0">Meeting Info</h6>
            </Card.Header>
            <Card.Body>
              <p className="mb-1">
                <strong>Running Context:</strong> {runningContext}
              </p>
              <p className="mb-1">
                <strong>User Status:</strong> {userContextStatus}
              </p>
              <p className="mb-0">
                <strong>Participants:</strong> {participants.length}
              </p>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  );
}

export default HostDashboard;
