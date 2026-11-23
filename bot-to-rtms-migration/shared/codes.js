/**
 * RTMS protocol and lifecycle code tables, plus the decision helpers that turn a
 * code into "what should my service do next".
 *
 * Sources: MEETING_BOT_PLAYBOOKS.md (request status, REST outcomes, client messages,
 * stop reasons 1-11) and library/javascript/rtmsManager/utils/rtmsEventLookupHelper.js
 * (stop reasons 12-26, state names). Codes 12-26 are the superset the reference
 * manager knows about; their "restart" column is this sample's reading, not Zoom policy.
 */

export const MSG = Object.freeze({
  SIGNALING_HAND_SHAKE_REQ: 1,
  SIGNALING_HAND_SHAKE_RESP: 2,
  DATA_HAND_SHAKE_REQ: 3,
  DATA_HAND_SHAKE_RESP: 4,
  EVENT_SUBSCRIPTION: 5,
  EVENT_UPDATE: 6,
  CLIENT_READY_ACK: 7,
  STREAM_STATE_UPDATE: 8,
  SESSION_STATE_UPDATE: 9,
  KEEP_ALIVE_REQ: 12,
  KEEP_ALIVE_RESP: 13,
  MEDIA_DATA_AUDIO: 14,
  MEDIA_DATA_VIDEO: 15,
  MEDIA_DATA_SHARE: 16,
  MEDIA_DATA_TRANSCRIPT: 17,
  MEDIA_DATA_CHAT: 18,
  STREAM_CLOSE_REQ: 21,
  STREAM_CLOSE_RESP: 22,
  VIDEO_SUBSCRIPTION_REQ: 28,
  VIDEO_SUBSCRIPTION_RESP: 29
});

/** Concrete media types. The aggregate value 32 and unified mode are deprecated: one socket per type. */
export const MEDIA_TYPE = Object.freeze({ audio: 1, video: 2, share: 4, transcript: 8, chat: 16 });
export const MEDIA_TYPE_NAME = Object.freeze(Object.fromEntries(Object.entries(MEDIA_TYPE).map(([k, v]) => [v, k])));
export const DEPRECATED_AGGREGATE_MEDIA_TYPE = 32;

export const MEDIA_MSG_FOR_TYPE = Object.freeze({
  audio: MSG.MEDIA_DATA_AUDIO,
  video: MSG.MEDIA_DATA_VIDEO,
  share: MSG.MEDIA_DATA_SHARE,
  transcript: MSG.MEDIA_DATA_TRANSCRIPT,
  chat: MSG.MEDIA_DATA_CHAT
});

export const STREAM_STATE = Object.freeze({
  INACTIVE: 0,
  ACTIVE: 1,
  INTERRUPTED: 2,
  TERMINATING: 3,
  TERMINATED: 4,
  PAUSED: 5,
  RESUMED: 6
});
export const STREAM_STATE_NAME = Object.freeze(Object.fromEntries(Object.entries(STREAM_STATE).map(([k, v]) => [v, k])));

export const SESSION_STATE_NAME = Object.freeze({
  0: 'INACTIVE',
  1: 'INITIALIZE',
  2: 'STARTED',
  3: 'PAUSED',
  4: 'RESUMED',
  5: 'STOPPED'
});

export const EVENT_TYPE = Object.freeze({
  FIRST_PACKET_TIMESTAMP: 1,
  ACTIVE_SPEAKER_CHANGE: 2,
  PARTICIPANT_JOIN: 3,
  PARTICIPANT_LEAVE: 4,
  SHARING_START: 5,
  SHARING_STOP: 6,
  MEDIA_CONNECTION_INTERRUPTED: 7,
  PARTICIPANT_VIDEO_ON: 8,
  PARTICIPANT_VIDEO_OFF: 9
});

/**
 * RTMS protocol V2 event codes (RTMS_EVENT_CODE). V2 replaces event_type with
 * event_code in subscriptions (msg 5) and event updates (msg 6). Only session
 * events 1000-1011 can be subscribed to; codes below 1000 arrive automatically.
 */
export const EVENT_CODE = Object.freeze({
  FIRST_PACKET_TIMESTAMP: 1,
  MEDIA_CONNECTION_INTERRUPTED: 2,
  VIDEO_SUBSCRIPTION_TERMINATED_BY_USER_LEAVE: 3,
  MEDIA_DATA_USER_INFO: 4,
  ACTIVE_SPEAKER_CHANGE: 1000,
  PARTICIPANT_JOIN: 1001,
  PARTICIPANT_LEAVE: 1002,
  SHARING_START: 1003,
  SHARING_STOP: 1004,
  PARTICIPANT_VIDEO_ON: 1005,
  PARTICIPANT_VIDEO_OFF: 1006,
  CHAT_GROUP_CREATE: 1007,
  CHAT_GROUP_DELETE: 1008,
  CHAT_GROUP_MEMBERS_ADD: 1009,
  CHAT_GROUP_MEMBERS_DELETE: 1010,
  CHAT_GROUP_MEMBER_STATUS_UPDATE: 1011
});

/** Legacy V1 event_type to V2 event_code. */
export const EVENT_CODE_FOR_TYPE = Object.freeze({
  1: 1, 2: 1000, 3: 1001, 4: 1002, 5: 1003, 6: 1004, 7: 2, 8: 1005, 9: 1006,
  10: 1007, 11: 1008, 12: 1009, 13: 1010, 14: 1011, 15: 3
});

/** The V2 event_code of a signaling event, accepting legacy V1 event_type input too. */
export function eventCodeOf(event = {}) {
  if (event.event_code != null) return event.event_code;
  return EVENT_CODE_FOR_TYPE[event.event_type] ?? null;
}

/** Normalize a subscription entry (V2 code or legacy V1 type) to a subscribable V2 code, or null. */
export function subscribableEventCode(value) {
  const code = value >= 1000 ? value : EVENT_CODE_FOR_TYPE[value];
  return Number.isInteger(code) && code >= 1000 && code <= 1011 ? code : null;
}

/** RTMS protocol V2 is required by these samples in both handshakes. */
export const RTMS_PROTOCOL_VERSION = 2;

/** Windows from the playbook. Keep them in one place so tests and docs agree. */
export const TIMING = Object.freeze({
  signalingReconnectWindowMs: 60_000,
  mediaReconnectWindowMs: 30_000,
  keepAliveSilenceLimitMs: 65_000,
  unansweredKeepAlivesBeforeClose: 3,
  webhookToleranceSeconds: 300
});

// ---------------------------------------------------------------------------
// rtms.request_status
// ---------------------------------------------------------------------------

/**
 * retry values:
 *   never           do not retry this request
 *   after_fix       retry only after the underlying condition is fixed
 *   backoff         retry a new stream with exponential backoff and jitter
 *   wait_for_reboot pause new starts and drain until reboot_in_minutes passes
 *   resume          normal scheduling again
 */
export const REQUEST_STATUS = Object.freeze({
  1: { name: 'request_denied', meaning: 'Request denied', retry: 'after_fix', action: 'Do not blind retry. Fix policy or approval first.' },
  2: { name: 'app_owner_not_present', meaning: 'App owner not present', retry: 'after_fix', action: 'Bring the app owner into the meeting or use another authorized start path.' },
  3: { name: 'host_denied_app', meaning: 'Host denied app', retry: 'after_fix', action: 'Ask the host to approve, or ask for persistent approval.' },
  4: { name: 'license_or_feature_disabled', meaning: 'License expired or feature disabled', retry: 'never', action: 'Renew or enable the entitlement. No retry.' },
  5: { name: 'no_concurrency_limit', meaning: 'No RTMS concurrency limit set', retry: 'after_fix', action: 'Fix entitlement or configuration.' },
  6: { name: 'rtms_server_failed', meaning: 'RTMS server failed', retry: 'backoff', action: 'Retry with a new stream, using backoff.' },
  7: { name: 'server_update_scheduled', meaning: 'Server update scheduled', retry: 'wait_for_reboot', action: 'Record reboot_in_minutes, pause new starts and drain.' },
  8: { name: 'server_update_canceled', meaning: 'Server update canceled', retry: 'resume', action: 'Resume normal scheduling.' }
});

/**
 * Turn a rtms.request_status payload into an action. Unknown codes are stored and
 * alerted on, never treated as success: keep waiting for *_rtms_started or a documented failure.
 */
export function decideRequestStatus(payload = {}) {
  const p = payload.object && typeof payload.object === 'object' ? { ...payload, ...payload.object } : payload;
  const code = Number(p.status ?? p.request_status);
  const entry = REQUEST_STATUS[code];
  const base = {
    code: Number.isFinite(code) ? code : null,
    streamId: p.rtms_stream_id || null,
    operatorId: p.operator_id || null,
    idField: p.id_field || null,
    eventTs: Number(p.event_ts) || null
  };
  if (!entry) {
    return {
      ...base,
      known: false,
      name: 'unknown',
      meaning: 'Unrecognised status',
      retry: 'never',
      pauseStarts: false,
      resumeStarts: false,
      rebootInMinutes: null,
      alert: true,
      action: 'Store the raw payload and alert. Do not infer success.'
    };
  }
  return {
    ...base,
    known: true,
    ...entry,
    pauseStarts: code === 7,
    resumeStarts: code === 8,
    rebootInMinutes: code === 7 ? Number(p.reboot_in_minutes) || null : null,
    alert: code === 4 || code === 5
  };
}

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

/**
 * restart values:
 *   policy          restart only if your policy allows, and only on a new *_rtms_started
 *   never           do not restart without new consent or a code fix
 *   wait_for_host   wait for the host to re-enable the app
 *   wait_for_admin  wait for the admin to re-enable the app
 *   backoff         a new stream may be requested with backoff
 *   reconnect       a transport problem: follow the reconnect rules
 *   none            nothing to restart
 */
export const STOP_REASONS = Object.freeze({
  1: { name: 'host_triggered', meaning: 'Host stopped', restart: 'policy', action: 'Finalize. No auto restart without policy.' },
  2: { name: 'user_triggered', meaning: 'App user stopped', restart: 'policy', action: 'Respect the user choice.' },
  3: { name: 'user_left', meaning: 'App user left', restart: 'policy', action: 'Apply your owner-left policy.' },
  4: { name: 'user_ejected', meaning: 'App user ejected by host', restart: 'never', action: 'Do not reconnect without consent.' },
  5: { name: 'host_disabled_app', meaning: 'Host disabled app', restart: 'wait_for_host', action: 'Wait for the host to re-enable the app.' },
  6: { name: 'meeting_ended', meaning: 'Meeting ended', restart: 'none', action: 'Finalize and close state.' },
  7: { name: 'stream_canceled', meaning: 'Stream canceled', restart: 'policy', action: 'Reconcile. Restart only if policy allows.' },
  8: { name: 'stream_revoked', meaning: 'Stream revoked', restart: 'never', purge: true, alert: true, action: 'Recheck authorization and consent. The reference manager treats this as delete assets immediately.' },
  9: { name: 'all_apps_disabled', meaning: 'All apps disabled', restart: 'wait_for_host', alert: true, action: 'Alert admin or host if persistent.' },
  10: { name: 'internal_exception', meaning: 'Server internal exception', restart: 'backoff', action: 'Retry with backoff if authorized.' },
  11: { name: 'connection_timeout', meaning: 'Connection timed out', restart: 'reconnect', action: 'Reconnect per the current stream rules.' },
  12: { name: 'instance_connection_interrupted', meaning: 'Instance connection interrupted', restart: 'reconnect', action: 'Transport problem. Follow the reconnect rules.' },
  13: { name: 'signal_connection_interrupted', meaning: 'Signaling connection interrupted', restart: 'reconnect', action: 'Reconnect signaling within the 60 second window.' },
  14: { name: 'data_connection_interrupted', meaning: 'Data connection interrupted', restart: 'reconnect', action: 'Reconnect the affected media socket only.' },
  15: { name: 'signal_closed_abnormally', meaning: 'Signaling connection closed abnormally', restart: 'reconnect', action: 'Reconnect signaling within the 60 second window.' },
  16: { name: 'data_closed_abnormally', meaning: 'Data connection closed abnormally', restart: 'reconnect', action: 'Reconnect the affected media socket only.' },
  17: { name: 'exit_signal', meaning: 'Received exit signal', restart: 'policy', action: 'Inspect the cause before restarting.' },
  18: { name: 'authentication_failure', meaning: 'Authentication failure', restart: 'never', alert: true, action: 'Fix credentials or the handshake signature. Do not loop.' },
  19: { name: 'await_reconnection_timeout', meaning: 'Await reconnection timeout', restart: 'policy', action: 'The window was missed. A new stream is required.' },
  20: { name: 'receiver_request_close', meaning: 'Receiver requested close', restart: 'none', action: 'You asked for the close. Finalize.' },
  21: { name: 'customer_disconnected', meaning: 'Customer disconnected', restart: 'none', action: 'Contact center only. Finalize.' },
  22: { name: 'agent_disconnected', meaning: 'Agent disconnected', restart: 'none', action: 'Contact center only. Finalize.' },
  23: { name: 'admin_disabled_app', meaning: 'Admin disabled app', restart: 'wait_for_admin', alert: true, action: 'Wait for the admin to re-enable the app.' },
  24: { name: 'keep_alive_timeout', meaning: 'Keep-alive timeout', restart: 'reconnect', alert: true, action: 'You did not answer keep-alives. Check event loop health.' },
  25: { name: 'manual_api_triggered', meaning: 'Manual API triggered', restart: 'policy', action: 'A REST stop ended the stream. Finalize.' },
  26: { name: 'streaming_not_supported', meaning: 'Streaming not supported', restart: 'never', alert: true, action: 'Fix entitlement or configuration.' }
});

/** Every stop is terminal for that rtms_stream_id. This only says what to do after finalizing. */
export function decideStop(reasonCode) {
  const code = Number(reasonCode);
  const entry = STOP_REASONS[code];
  if (!entry) {
    return {
      code: Number.isFinite(code) ? code : null,
      known: false,
      name: 'unknown',
      meaning: 'Unrecognised stop reason',
      finalize: true,
      restart: 'never',
      purge: false,
      alert: true,
      action: 'Finalize, store the raw payload and alert.'
    };
  }
  return { code, known: true, finalize: true, purge: false, alert: false, ...entry };
}

// ---------------------------------------------------------------------------
// REST start/stop outcomes
// ---------------------------------------------------------------------------

export const REST_OUTCOMES = Object.freeze({
  204: { name: 'accepted', meaning: 'Request accepted', retry: 'never', waitForWebhook: true, action: 'Wait for the lifecycle webhook. Do not connect yet.' },
  3000: { name: 'meeting_not_started', meaning: 'Meeting or session has not started', retry: 'later', action: 'Queue until the meeting is live. Do not retry immediately.' },
  4927: { name: 'meeting_not_started', meaning: 'Meeting or session has not started', retry: 'later', action: 'Queue until the meeting is live. Do not retry immediately.' },
  2310: { name: 'rtms_operation_failed', meaning: 'RTMS operation failed', retry: 'after_fix', action: 'Inspect request state and policy before retry.' },
  13277: { name: 'requires_started_app', meaning: 'Action requires a started app', retry: 'never', action: 'Start first. Stop, pause or resume only an active stream.' },
  2312: { name: 'participant_not_found', meaning: 'Participant user does not exist', retry: 'after_fix', action: 'Correct the participant ID, or omit it to use the token identity.' },
  2308: { name: 'role_not_allowed', meaning: 'Caller role is not allowed', retry: 'after_fix', action: 'Use the host, alternative-host or panelist path, or ask an eligible user.' },
  2309: { name: 'role_not_allowed', meaning: 'Caller role is not allowed', retry: 'after_fix', action: 'Use the host, alternative-host or panelist path, or ask an eligible user.' },
  13273: { name: 'rtms_not_supported', meaning: 'Meeting or session does not support the RTMS app', retry: 'never', action: 'Fix entitlement or app configuration. Do not retry blindly.' },
  13267: { name: 'rtms_app_disabled', meaning: 'RTMS app disabled', retry: 'after_fix', action: 'Enable "Share realtime meeting content with apps", or ask the host or admin.' },
  13262: { name: 'app_not_authorized', meaning: 'App not authorized for meeting content', retry: 'after_fix', action: 'Fix the app allowlist and authorization.' },
  401: { name: 'token_invalid', meaning: 'Access token missing, expired, or without the required scope', retry: 'after_fix', action: 'Refresh the token once. If that fails, or the scope is missing, ask the user to authorize the app again.' },
  404: { name: 'not_found', meaning: 'Meeting or session not found', retry: 'never', action: 'Verify the ID, including any UUID double encoding.' },
  429: { name: 'rate_limited', meaning: 'Rate limited', retry: 'backoff', action: 'Back off with jitter and honor the account limit.' }
});

/**
 * Classify a REST response. Zoom puts the specific code in the JSON body ({ code, message });
 * 204 and plain HTTP statuses such as 404 and 429 come from the status line.
 */
export function classifyRestOutcome(httpStatus, body = null) {
  const bodyCode = Number(body?.code);
  const key = httpStatus === 204 ? 204 : REST_OUTCOMES[bodyCode] ? bodyCode : REST_OUTCOMES[httpStatus] ? httpStatus : null;
  if (key === null) {
    return {
      known: false,
      key: null,
      httpStatus,
      code: Number.isFinite(bodyCode) ? bodyCode : null,
      name: 'unknown',
      meaning: 'Unrecognised REST outcome',
      retry: 'never',
      waitForWebhook: false,
      action: 'Log the status and body, then alert. Do not blind retry.'
    };
  }
  return { known: true, key, httpStatus, code: key, waitForWebhook: false, ...REST_OUTCOMES[key] };
}

// ---------------------------------------------------------------------------
// Client messages shown in the Zoom client
// ---------------------------------------------------------------------------

export const CLIENT_MESSAGES = Object.freeze([
  { text: 'Request sent to the host.', state: 'pending_host', requestStatusHint: null, retry: 'never', action: 'Show a pending state. Do not connect.' },
  { text: 'Request for app to share content denied by host.', state: 'denied', requestStatusHint: [1, 3], retry: 'after_fix', action: 'Ask the host to approve. Do not auto retry.' },
  { text: "Host cannot approve your app's access to content.", state: 'host_unable', requestStatusHint: null, retry: 'after_fix', action: 'Wait, or ask the host to check meeting and host state.' },
  { text: 'Host disabled your app from sharing content.', state: 'host_disabled', requestStatusHint: null, retry: 'never', action: 'The host must re-enable the app. No retry.' },
  { text: 'Request to share content cannot be sent until the host has joined.', state: 'host_absent', requestStatusHint: [2], retry: 'after_fix', action: 'Wait for the host.' },
  { text: 'Apps sharing content have been disabled.', state: 'apps_disabled', requestStatusHint: [4], retry: 'never', action: 'The host must enable sharing for apps.' }
]);

export function classifyClientMessage(text = '') {
  const wanted = String(text).trim().toLowerCase();
  return CLIENT_MESSAGES.find((m) => m.text.toLowerCase() === wanted) || null;
}

/** Exponential backoff with full jitter. `random` is injectable for tests. */
export function backoffDelayMs(attempt, { baseMs = 1000, capMs = 30_000, random = Math.random } = {}) {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}
