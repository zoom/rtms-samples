import React, { useState } from 'react';
import { Card, Button, Alert } from 'react-bootstrap';
import { useConsent } from '../contexts/ConsentContext';

function ConsentPrompt() {
  const { myConsentStatus, submitConsent, loading, error } = useConsent();
  const [localLoading, setLocalLoading] = useState(false);

  const handleConsent = async (status) => {
    setLocalLoading(true);
    await submitConsent(status);
    setLocalLoading(false);
  };

  if (myConsentStatus !== 'pending') {
    return (
      <Card className="consent-prompt">
        <Card.Body className="text-center">
          <h4>Thank You</h4>
          <p className="mb-0">
            You have{' '}
            <strong className={myConsentStatus === 'agreed' ? 'text-success' : 'text-danger'}>
              {myConsentStatus === 'agreed' ? 'agreed' : 'declined'}
            </strong>{' '}
            to transcript access.
          </p>
          <div className="mt-3">
            <span
              className={`consent-status ${myConsentStatus}`}
              style={{ fontSize: '1rem', padding: '0.5rem 1rem' }}
            >
              {myConsentStatus === 'agreed' ? 'Consent Given' : 'Consent Declined'}
            </span>
          </div>
        </Card.Body>
      </Card>
    );
  }

  return (
    <Card className="consent-prompt">
      <Card.Body>
        <h4 className="text-center mb-3">Meeting Transcript Consent</h4>

        <p className="text-muted">
          This application would like to access the real-time transcript of this meeting
          for demonstration purposes. Your consent is required before any transcript data
          can be accessed.
        </p>

        <div className="border-start border-primary border-4 ps-3 mb-4 bg-light py-2">
          <strong>What this means:</strong>
          <ul className="mb-0 mt-2">
            <li>The app will capture live transcript data during the meeting</li>
            <li>All participants must consent before transcript access begins</li>
            <li>If any participant declines, transcript access will not start</li>
            <li>This is a demonstration app for enterprise consent workflows</li>
          </ul>
        </div>

        {error && (
          <Alert variant="danger" className="mb-3">
            {error}
          </Alert>
        )}

        <div className="d-grid gap-2">
          <Button
            variant="success"
            size="lg"
            onClick={() => handleConsent('agreed')}
            disabled={loading || localLoading}
          >
            {loading || localLoading ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" />
                Processing...
              </>
            ) : (
              'I Agree'
            )}
          </Button>

          <Button
            variant="outline-danger"
            size="lg"
            onClick={() => handleConsent('disagreed')}
            disabled={loading || localLoading}
          >
            I Decline
          </Button>
        </div>

        {/* FEATURE FLAG: Chat-based consent instructions (disabled for compliance review) */}
        {/* To re-enable: set ENABLE_CHAT_CONSENT = true */}
        {false && (
          <Alert variant="info" className="mt-3 mb-0" style={{ fontSize: '0.875rem' }}>
            <strong>Can't open the app?</strong> You can also respond via chat:
            <div className="mt-2">
              <code className="bg-white px-2 py-1 rounded">I consent</code> or{' '}
              <code className="bg-white px-2 py-1 rounded">I decline</code>
            </div>
          </Alert>
        )}

        <p className="text-center text-muted mt-2 mb-0" style={{ fontSize: '0.875rem' }}>
          Your decision will be recorded for this meeting session only
        </p>
      </Card.Body>
    </Card>
  );
}

export default ConsentPrompt;
