const config = require('../config');

function buildRtmsPolicySnapshot(state) {
  const participants = Array.isArray(state?.participants) ? state.participants : [];
  const consentedParticipants = participants
    .filter((p) => p.consentStatus === 'agreed')
    .map((p) => ({
      participantUUID: p.participantUUID,
      participantID: p.participantID || null,
      screenName: p.screenName || null
    }));

  return {
    meetingId: state?.meetingId || null,
    policyMode: state?.policyMode === 'redact' ? 'redact' : 'unanimous',
    rtmsStatus: state?.rtmsStatus || 'stopped',
    rtmsPausedReason: state?.rtmsPausedReason || null,
    unanimousConsent: Boolean(state?.unanimousConsent),
    consentedParticipants,
    updatedAt: state?.updatedAt || new Date().toISOString()
  };
}

async function sendInternalRtmsWebhook(event, payload) {
  const rtmsServerUrl = process.env.RTMS_SERVER_URL || config.rtmsServerUrl || 'http://localhost:3002';
  const token = process.env.INTERNAL_WEBHOOK_TOKEN || config.internalWebhookToken;

  if (!token) {
    console.warn(`[RTMS Notifier] INTERNAL_WEBHOOK_TOKEN is not configured; cannot notify RTMS server (${event})`);
    return { ok: false, skipped: true, reason: 'missing_internal_token' };
  }

  try {
    const response = await fetch(`${rtmsServerUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ event, payload })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[RTMS Notifier] RTMS server returned ${response.status} for ${event}: ${errorText}`);
    }

    return { ok: response.ok, status: response.status };
  } catch (error) {
    console.error(`[RTMS Notifier] Failed to notify RTMS server (${event}):`, error.message);
    return { ok: false, error: error.message };
  }
}

async function syncConsentPolicyToRtms(meetingId, state) {
  const policy = buildRtmsPolicySnapshot(state);
  const result = await sendInternalRtmsWebhook('consent.policy_updated', {
    meeting_uuid: meetingId,
    policy
  });

  if (policy.rtmsStatus === 'stopped') {
    await sendInternalRtmsWebhook('meeting.rtms_stopped', {
      meeting_uuid: meetingId,
      reason: policy.rtmsPausedReason || 'consent_stopped'
    });
  }

  return result;
}

module.exports = {
  buildRtmsPolicySnapshot,
  sendInternalRtmsWebhook,
  syncConsentPolicyToRtms
};
