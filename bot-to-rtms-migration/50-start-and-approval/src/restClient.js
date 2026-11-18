import { classifyRestOutcome } from '../../shared/codes.js';

/**
 * REST start, stop, pause and resume for a joined invitee.
 *   PATCH https://api.zoom.us/v2/live_meetings/{meetingId}/rtms_app/status
 *   body  { action: "start" | "stop" | "pause" | "resume", settings: { client_id, participant_user_id? } }
 *   scope meeting:update:participant_rtms_app_status
 *
 * A 204 only means "request accepted". It is not media availability: wait for the webhook.
 * With no access token the client runs in dry-run mode and never touches the network.
 *
 * The call acts on behalf of one Zoom user, so the token must be that user's. Pass `tokenProvider`
 * (see oauth.js `accessToken`) to resolve it per call. `accessToken` is the single-token shortcut for
 * a quick test.
 */
export function encodeMeetingId(id) {
  const s = String(id);
  return s.startsWith('/') || s.includes('//') ? encodeURIComponent(encodeURIComponent(s)) : encodeURIComponent(s);
}

const NEEDS_AUTHORIZATION = Object.freeze({
  reauthorization_required: { known: true, key: null, name: 'reauthorization_required', meaning: 'The user must authorize the app again', retry: 'after_fix', waitForWebhook: false, action: 'Send the user through the authorize URL. Do not retry.' },
  no_token_for_user: { known: true, key: null, name: 'no_token_for_user', meaning: 'No token is stored for this user', retry: 'after_fix', waitForWebhook: false, action: 'The user has not authorized the app. Send them through the authorize URL.' }
});

export function createRestClient({
  accessToken = '',
  tokenProvider = null,
  onUnauthorized = null,
  onReauthorizationNeeded = null,
  clientId = '',
  baseUrl = 'https://api.zoom.us/v2',
  fetchImpl = fetch,
  timeoutMs = 10_000
} = {}) {
  async function call(action, meetingId, participantUserId) {
    const settings = { client_id: clientId };
    if (participantUserId) settings.participant_user_id = participantUserId;
    const request = { method: 'PATCH', path: `/live_meetings/${encodeMeetingId(meetingId)}/rtms_app/status`, body: { action, settings } };

    let token = accessToken;
    if (tokenProvider) {
      const got = await tokenProvider(participantUserId);
      if (got?.ok) token = got.accessToken;
      else if (!accessToken) {
        const outcome = got?.reason === 'reauthorization_required' ? NEEDS_AUTHORIZATION.reauthorization_required : NEEDS_AUTHORIZATION.no_token_for_user;
        return { dryRun: false, request, outcome: { ...outcome, message: got?.detail || got?.reason || null } };
      }
    }
    if (!token) {
      return { dryRun: true, request, outcome: { ...classifyRestOutcome(204), dryRun: true } };
    }

    const send = (bearer) => fetchImpl(`${baseUrl}${request.path}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    try {
      let res = await send(token);
      if (res.status === 401 && tokenProvider) {
        // The token was rejected. Force one refresh and try once more. A second 401 needs a new authorization.
        await onUnauthorized?.(participantUserId);
        const again = await tokenProvider(participantUserId);
        if (again?.ok && again.accessToken !== token) res = await send(again.accessToken);
        if (res.status === 401) await onReauthorizationNeeded?.(participantUserId, 'rest_401');
      }
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      return { dryRun: false, request, outcome: { ...classifyRestOutcome(res.status, body), message: body?.message || null, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null } };
    } catch (error) {
      return {
        dryRun: false,
        request,
        outcome: { known: false, key: null, name: 'network_error', meaning: 'The request did not complete', retry: 'backoff', waitForWebhook: false, action: 'Retry with backoff. Nothing was accepted.', message: error.code || error.message }
      };
    }
  }
  return {
    start: (meetingId, opts = {}) => call('start', meetingId, opts.participantUserId),
    stop: (meetingId, opts = {}) => call('stop', meetingId, opts.participantUserId),
    pause: (meetingId, opts = {}) => call('pause', meetingId, opts.participantUserId),
    resume: (meetingId, opts = {}) => call('resume', meetingId, opts.participantUserId)
  };
}
