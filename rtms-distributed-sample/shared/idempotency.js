import crypto from 'crypto';

export function buildWebhookIdempotencyKey({ event, payload = {}, streamId, rtmsId, eventTs } = {}) {
  const value = [
    event || 'unknown_event',
    streamId || payload.rtms_stream_id || payload.stream_id || 'unknown_stream',
    rtmsId || payload.meeting_uuid || payload.session_id || payload.webinar_uuid || payload.engagement_id || payload.call_id || 'unknown_rtms_id',
    eventTs || payload.event_ts || payload.timestamp || 'unknown_event_ts'
  ].join('|');

  return `rtms_${crypto.createHash('sha256').update(value).digest('hex')}`;
}
