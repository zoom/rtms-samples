import React, { useState } from 'react';
import { Container, Row, Col, Card, Badge, Button, ButtonGroup, Form } from 'react-bootstrap';
import ConsentPrompt from './ConsentPrompt';
import ConsentNotification from './ConsentNotification';
import ParticipantList from './ParticipantList';
import RTMSStatus from './RTMSStatus';
import { useConsent } from '../contexts/ConsentContext';
import { useZoomSDK } from '../contexts/ZoomSDKContext';
import { useWebSocket } from '../contexts/WebSocketContext';

function HostDashboard({ runningContext, userContextStatus }) {
  const { consentState, updatePolicyMode, loading } = useConsent();
  const { participants, meetingContext, getAuthHeaders } = useZoomSDK();
  const { isConnected, meetingRoomJoined } = useWebSocket();
  const [downloadError, setDownloadError] = useState(null);

  const handleDownloadAudit = async (format) => {
    if (!meetingContext?.meetingUUID) return;
    setDownloadError(null);
    try {
      const url = `/api/consent/${encodeURIComponent(meetingContext.meetingUUID)}/audit?format=${format}`;
      const response = await fetch(url, {
        credentials: 'include',
        headers: getAuthHeaders()
      });
      if (!response.ok) {
        throw new Error(`Audit export failed (${response.status})`);
      }
      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `consent-audit-${meetingContext.meetingUUID}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setDownloadError(err.message || 'Failed to download audit trail');
    }
  };

  const currentPolicyMode = consentState.policyMode || 'unanimous';

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
            policyMode={currentPolicyMode}
          />

          <Card className="mb-4">
            <Card.Header>
              <h6 className="mb-0">Consent Policy &amp; Audit</h6>
            </Card.Header>
            <Card.Body>
              <Form.Group className="mb-3">
                <Form.Label className="small fw-semibold">Enforcement Policy</Form.Label>
                <Form.Select
                  size="sm"
                  value={currentPolicyMode}
                  disabled={loading || !meetingContext?.meetingUUID}
                  onChange={(e) => updatePolicyMode(e.target.value)}
                >
                  <option value="unanimous">Unanimous Consent Gate (Pause/Stop RTMS)</option>
                  <option value="redact">Per-Participant Redaction (Redact Unconsented)</option>
                </Form.Select>
              </Form.Group>

              <div className="d-grid gap-2">
                <ButtonGroup size="sm">
                  <Button
                    variant="outline-primary"
                    disabled={!meetingContext?.meetingUUID}
                    onClick={() => handleDownloadAudit('json')}
                  >
                    Audit Trail (JSON)
                  </Button>
                  <Button
                    variant="outline-secondary"
                    disabled={!meetingContext?.meetingUUID}
                    onClick={() => handleDownloadAudit('csv')}
                  >
                    Audit Trail (CSV)
                  </Button>
                </ButtonGroup>
                {downloadError && (
                  <small className="text-danger">{downloadError}</small>
                )}
              </div>
            </Card.Body>
          </Card>

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
