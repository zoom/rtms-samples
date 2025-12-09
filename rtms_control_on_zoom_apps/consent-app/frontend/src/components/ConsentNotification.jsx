import React from 'react';
import { Alert } from 'react-bootstrap';
import { useConsent } from '../contexts/ConsentContext';

/**
 * Shows real-time notifications about consent state changes
 */
function ConsentNotification() {
  const { consentState, myConsentStatus } = useConsent();

  // Don't show anything if user hasn't consented yet
  if (myConsentStatus === 'pending') {
    return null;
  }

  // Show RTMS running notification
  if (consentState.rtmsStatus === 'running') {
    return (
      <Alert variant="success" className="mb-3">
        <div className="d-flex align-items-center">
          <span className="status-indicator running me-2"></span>
          <div>
            <strong>Transcript Access Active</strong>
            <p className="mb-0 small mt-1">
              All participants have consented. Meeting transcripts are being accessed
              for demonstration purposes.
            </p>
          </div>
        </div>
      </Alert>
    );
  }

  // Show RTMS paused notification
  if (consentState.rtmsStatus === 'paused' && consentState.rtmsPausedReason) {
    return (
      <Alert variant="warning" className="mb-3">
        <div className="d-flex align-items-center">
          <span className="status-indicator paused me-2"></span>
          <div>
            <strong>Transcript Access Paused</strong>
            <p className="mb-0 small mt-1">
              {consentState.rtmsPausedReason}
            </p>
          </div>
        </div>
      </Alert>
    );
  }

  // Show waiting for consent
  if (consentState.rtmsStatus === 'stopped' && !consentState.unanimousConsent) {
    const pendingCount = consentState.participants.filter(
      p => p.consentStatus === 'pending'
    ).length;

    if (pendingCount > 0) {
      return (
        <Alert variant="info" className="mb-3">
          <strong>Waiting for Consent</strong>
          <p className="mb-0 small mt-1">
            Waiting for {pendingCount} participant{pendingCount !== 1 ? 's' : ''} to
            consent before transcript access can begin.
          </p>
        </Alert>
      );
    }
  }

  return null;
}

export default ConsentNotification;
