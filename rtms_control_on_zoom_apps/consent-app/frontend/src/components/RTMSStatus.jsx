import React from 'react';
import { Card, Alert } from 'react-bootstrap';

function RTMSStatus({ rtmsStatus, rtmsPausedReason, unanimousConsent }) {
  const getStatusText = (status) => {
    switch (status) {
      case 'running':
        return 'Active';
      case 'paused':
        return 'Paused';
      case 'stopped':
      default:
        return 'Stopped';
    }
  };

  return (
    <Card className="rtms-status mb-4">
      <Card.Header>
        <h6 className="mb-0">RTMS Transcript Access</h6>
      </Card.Header>
      <Card.Body>
        <div className="d-flex align-items-center mb-3">
          <span className={`status-indicator ${rtmsStatus}`}></span>
          <strong className="ms-2">Status: {getStatusText(rtmsStatus)}</strong>
        </div>

        {rtmsStatus === 'running' && (
          <Alert variant="success" className="mb-0">
            <strong>Transcript Access Active</strong>
            <p className="mb-0 mt-2 small">
              All participants have consented. Meeting transcripts are being accessed.
            </p>
          </Alert>
        )}

        {rtmsStatus === 'paused' && rtmsPausedReason && (
          <Alert variant="warning" className="mb-0">
            <strong>Paused</strong>
            <p className="mb-0 mt-2 small">
              {rtmsPausedReason}
            </p>
          </Alert>
        )}

        {rtmsStatus === 'stopped' && !unanimousConsent && (
          <Alert variant="secondary" className="mb-0">
            <strong>Waiting for Consent</strong>
            <p className="mb-0 mt-2 small">
              Transcript access will start automatically when all participants consent.
            </p>
          </Alert>
        )}

        {rtmsStatus === 'stopped' && unanimousConsent && (
          <Alert variant="info" className="mb-0">
            <strong>Ready to Start</strong>
            <p className="mb-0 mt-2 small">
              All participants have consented. RTMS will start automatically.
            </p>
          </Alert>
        )}
      </Card.Body>
    </Card>
  );
}

export default RTMSStatus;
