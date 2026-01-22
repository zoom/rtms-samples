import React from 'react';
import { Card, Badge, ListGroup, Alert } from 'react-bootstrap';

function ParticipantList({ participants, consentState }) {
  // Merge participant data with consent data
  const participantsWithConsent = participants.map(participant => {
    const consentInfo = consentState.participants.find(
      p => p.participantUUID === participant.participantUUID
    );

    return {
      ...participant,
      consentStatus: consentInfo?.consentStatus || 'pending'
    };
  });

  // Count consent statuses
  const consentCounts = {
    agreed: participantsWithConsent.filter(p => p.consentStatus === 'agreed').length,
    disagreed: participantsWithConsent.filter(p => p.consentStatus === 'disagreed').length,
    pending: participantsWithConsent.filter(p => p.consentStatus === 'pending').length
  };

  return (
    <Card className="participant-list mb-4">
      <Card.Header className="d-flex justify-content-between align-items-center">
        <h5 className="mb-0">Participants ({participants.length})</h5>
        <div>
          <Badge bg="success" className="me-2">
            {consentCounts.agreed} Agreed
          </Badge>
          <Badge bg="warning" text="dark" className="me-2">
            {consentCounts.pending} Pending
          </Badge>
          <Badge bg="danger">
            {consentCounts.disagreed} Declined
          </Badge>
        </div>
      </Card.Header>
      <Card.Body className="p-0">
        {consentCounts.pending > 0 && (
          <Alert variant="info" className="m-3 mb-0" style={{ fontSize: '0.875rem' }}>
            <strong>Waiting for consent from {consentCounts.pending} participant{consentCounts.pending > 1 ? 's' : ''}.</strong>
            {/* FEATURE FLAG: Chat-based consent instructions (disabled for compliance review) */}
            {/* To re-enable: set ENABLE_CHAT_CONSENT = true */}
            {false && (
              <div className="mt-2">
                Participants can respond via chat using keywords:
                <div className="mt-1">
                  <code className="bg-white px-2 py-1 rounded me-2">I consent</code>
                  <code className="bg-white px-2 py-1 rounded me-2">I agree</code>
                  <code className="bg-white px-2 py-1 rounded">I decline</code>
                </div>
              </div>
            )}
          </Alert>
        )}
        {participantsWithConsent.length === 0 ? (
          <div className="text-center p-4 text-muted">
            No participants found. Join a meeting to see participants.
          </div>
        ) : (
          <ListGroup variant="flush">
            {participantsWithConsent.map((participant, index) => (
              <ListGroup.Item
                key={participant.participantUUID || index}
                className="d-flex justify-content-between align-items-center"
              >
                <div>
                  <strong>{participant.screenName || participant.participantID}</strong>
                  {participant.isHost && (
                    <Badge bg="primary" className="ms-2">Host</Badge>
                  )}
                  {participant.isCoHost && (
                    <Badge bg="info" className="ms-2">Co-Host</Badge>
                  )}
                </div>
                <span className={`consent-status ${participant.consentStatus}`}>
                  {participant.consentStatus === 'agreed' && 'Agreed'}
                  {participant.consentStatus === 'disagreed' && 'Declined'}
                  {participant.consentStatus === 'pending' && 'Pending'}
                </span>
              </ListGroup.Item>
            ))}
          </ListGroup>
        )}
      </Card.Body>
    </Card>
  );
}

export default ParticipantList;
