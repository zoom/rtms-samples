const express = require('express');
const router = express.Router();
const {
  validateConsentSubmission,
  validateMeetingId,
  validatePolicyUpdate
} = require('../utils/validators');
const ConsentManager = require('../services/ConsentManager');
const { requireHostRole, requireInternalToken } = require('../middleware/security');
const { buildRtmsPolicySnapshot, syncConsentPolicyToRtms } = require('../utils/rtmsNotifier');

// Get server instance for WebSocket broadcasting
let wsServer = null;
function setWebSocketServer(server) {
  wsServer = server;
}

/**
 * POST /api/consent/submit
 * Submit participant consent
 */
router.post('/submit', async (req, res) => {
  try {
    const { error, value } = validateConsentSubmission(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // If a verified Zoom App context is attached, enforce meeting match
    if (req.zoomContext?.mid && String(req.zoomContext.mid) !== String(value.meetingId)) {
      return res.status(403).json({ error: 'Meeting context mismatch' });
    }

    const { state, statusChanged } = await ConsentManager.submitConsent(
      value.meetingId,
      value,
      { source: 'zoom_app_ui' }
    );

    if (wsServer) {
      if (statusChanged) {
        wsServer.broadcastRTMSStatus(value.meetingId, state.rtmsStatus, state.rtmsPausedReason);
      }
      wsServer.broadcastConsentUpdate(value.meetingId, state);
    }

    // Push live policy update (and stop signal if declined) to RTMS server
    await syncConsentPolicyToRtms(value.meetingId, state);

    res.json({
      success: true,
      consentStatus: value.consentStatus,
      policyMode: state.policyMode,
      unanimousConsent: state.unanimousConsent,
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason
    });
  } catch (error) {
    console.error('❌ Error in consent submission:', error);
    res.status(500).json({ error: 'Failed to submit consent' });
  }
});

/**
 * POST /api/consent/policy
 * Switch between 'unanimous' consent gate and per-participant 'redact' mode (host/co-host only)
 */
router.post('/policy', requireHostRole, async (req, res) => {
  try {
    const { error, value } = validatePolicyUpdate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { state, statusChanged } = await ConsentManager.setPolicyMode(
      value.meetingId,
      value.policyMode,
      { source: 'host_dashboard' }
    );

    if (wsServer) {
      if (statusChanged) {
        wsServer.broadcastRTMSStatus(value.meetingId, state.rtmsStatus, state.rtmsPausedReason);
      }
      wsServer.broadcastConsentUpdate(value.meetingId, state);
    }

    await syncConsentPolicyToRtms(value.meetingId, state);

    res.json({
      success: true,
      policyMode: state.policyMode,
      rtmsStatus: state.rtmsStatus,
      rtmsPausedReason: state.rtmsPausedReason,
      unanimousConsent: state.unanimousConsent
    });
  } catch (error) {
    console.error('❌ Error updating consent policy:', error);
    res.status(500).json({ error: 'Failed to update consent policy' });
  }
});

/**
 * GET /api/consent/status?meetingId={meetingId}
 * Get current consent state for a meeting
 */
router.get('/status', async (req, res) => {
  try {
    const { error, value } = validateMeetingId({ meetingId: req.query.meetingId });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const state = await ConsentManager.getConsentState(value.meetingId);
    res.json(state);
  } catch (error) {
    console.error('Error getting consent status:', error);
    res.status(500).json({ error: 'Failed to get consent status' });
  }
});

/**
 * GET /api/consent/policy/internal?meetingId={meetingId}
 * Internal endpoint for the RTMS service to fetch live server-side consent policy.
 */
router.get('/policy/internal', requireInternalToken, async (req, res) => {
  try {
    const { error, value } = validateMeetingId({ meetingId: req.query.meetingId });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const state = await ConsentManager.getConsentState(value.meetingId);
    res.json(buildRtmsPolicySnapshot(state));
  } catch (error) {
    console.error('Error getting internal consent policy:', error);
    res.status(500).json({ error: 'Failed to get consent policy' });
  }
});

async function handleAuditExport(meetingId, format, res) {
  const state = await ConsentManager.getConsentState(meetingId);
  const safeId = String(meetingId).replace(/[^a-zA-Z0-9_-]/g, '_');

  if (String(format || 'json').toLowerCase() === 'csv') {
    const csv = ConsentManager.formatAuditTrailCsv(state.auditTrail || []);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="consent-audit-${safeId}.csv"`);
    return res.send(csv);
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="consent-audit-${safeId}.json"`);
  return res.json({
    meetingId: state.meetingId,
    policyMode: state.policyMode,
    rtmsStatus: state.rtmsStatus,
    unanimousConsent: state.unanimousConsent,
    exportedAt: new Date().toISOString(),
    participants: state.participants,
    auditTrail: state.auditTrail || []
  });
}

/**
 * GET /api/consent/:meetingId/audit?format=json|csv
 * Download timestamped Consent Audit Trail (host/co-host only)
 */
router.get('/:meetingId/audit', requireHostRole, async (req, res) => {
  try {
    const { error, value } = validateMeetingId({ meetingId: req.params.meetingId });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }
    return await handleAuditExport(value.meetingId, req.query.format, res);
  } catch (error) {
    console.error('Error exporting consent audit trail:', error);
    res.status(500).json({ error: 'Failed to export consent audit trail' });
  }
});

module.exports = router;
module.exports.setWebSocketServer = setWebSocketServer;
