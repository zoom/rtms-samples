/**
 * Read an RTMS lifecycle webhook payload.
 *
 * The working samples in this repo read the fields directly from `payload`.
 * Some docs show them under `payload.object`, so both shapes are accepted.
 * The full raw object is kept as the recovery record; never rebuild it from
 * meeting APIs.
 */
export function normalizeStartedPayload(event, payload = {}) {
  const p = payload.object && typeof payload.object === 'object'
    ? { ...payload, ...payload.object }
    : payload;
  const product = productFromEvent(event);
  const meetingId = p.meeting_uuid || p.session_id || p.webinar_uuid || p.engagement_id || p.call_id || null;

  return {
    event,
    product,
    accountId: p.account_id || null,
    operatorId: p.operator_id || p.host_id || null,
    meetingId,
    meetingNumericId: p.meeting_id || null,
    streamId: p.rtms_stream_id || null,
    serverUrls: p.server_urls || null,
    eventTs: Number(p.event_ts) || null,
    originalHost: p.is_original_host ?? p.original_host ?? null,
    raw: payload
  };
}

export function productFromEvent(event = '') {
  if (event.startsWith('meeting.')) return 'meeting';
  if (event.startsWith('webinar.')) return 'webinar';
  if (event.startsWith('session.')) return 'videoSdk';
  if (event.startsWith('contact_center.')) return 'contactCenter';
  if (event.startsWith('phone.')) return 'phone';
  return 'unknown';
}

export const isStartedEvent = (event = '') => event.endsWith('.rtms_started') || event === 'contact_center.voice_rtms_started';
export const isStoppedEvent = (event = '') => event.endsWith('.rtms_stopped') || event === 'contact_center.voice_rtms_stopped';
export const isInterruptedEvent = (event = '') => event.endsWith('.rtms_interrupted') || event === 'contact_center.voice_rtms_interrupted';

/** The handshake field that carries the meeting or session identity, by product. */
export const ENTITY_KEYS = Object.freeze({
  meeting: 'meeting_uuid',
  webinar: 'webinar_uuid',
  videoSdk: 'session_id',
  contactCenter: 'engagement_id',
  phone: 'call_id'
});

export const entityKeyForProduct = (product = 'meeting') => ENTITY_KEYS[product] || ENTITY_KEYS.meeting;
