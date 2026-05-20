import { buildZoomWebhookSignature } from '../shared/zoomSignature.js';
import { buildInternalSignatureHeaders } from '../shared/internalSignature.js';

export function buildDummyRtmsWebhook(options = {}) {
  const event = options.event || 'meeting.rtms_started';
  const region = String(options.region || 'IAD').toUpperCase();
  const streamId = options.streamId || `dummy-stream-${Date.now()}`;
  const rtmsId = options.rtmsId || `dummy-rtms-${Date.now()}`;
  const productType = getProductType(event);
  const payload = {
    account_id: options.accountId || 'dummy-account',
    operator: 'rtms-distributed-sample',
    rtms_stream_id: streamId,
    event_ts: options.eventTs || Date.now()
  };

  if (productType === 'videoSdk') {
    payload.session_id = rtmsId;
  } else if (productType === 'contactCenter') {
    payload.engagement_id = rtmsId;
  } else if (productType === 'phone') {
    payload.call_id = rtmsId;
  } else if (productType === 'webinar') {
    payload.webinar_uuid = rtmsId;
  } else {
    payload.meeting_uuid = rtmsId;
  }

  if (event.endsWith('rtms_started')) {
    const lowerRegion = region.toLowerCase();
    payload.server_urls = {
      signaling: `wss://${lowerRegion}.zoom.us/rtms/signaling`,
      audio: `wss://${lowerRegion}.zoom.us/rtms/audio`,
      transcript: `wss://${lowerRegion}.zoom.us/rtms/transcript`
    };
  }

  return { event, payload };
}

export function getStopEvent(startEvent = 'meeting.rtms_started') {
  return String(startEvent).replace(/rtms_started$/, 'rtms_stopped');
}

export function signZoomWebhook(bodyText, secretToken, timestamp = Math.floor(Date.now() / 1000)) {
  return {
    timestamp: String(timestamp),
    signature: buildZoomWebhookSignature(bodyText, secretToken, timestamp)
  };
}

export function signInternalWebhook(bodyText, secretToken, timestamp = Math.floor(Date.now() / 1000)) {
  return buildInternalSignatureHeaders(bodyText, secretToken, timestamp);
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const eq = arg.indexOf('=');
    if (eq !== -1) {
      args[toCamel(arg.slice(2, eq))] = arg.slice(eq + 1);
      continue;
    }

    const key = toCamel(arg.slice(2));
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function deriveRoutingKey(envelope, fallbackRegion = 'UNKNOWN') {
  const eventType = envelope.eventType || (String(envelope.event || '').endsWith('rtms_stopped') ? 'stop' : 'start');
  const region = String(envelope.regionCode || fallbackRegion || 'UNKNOWN').toLowerCase();
  return `${eventType}.region.${region}`;
}

function getProductType(event = '') {
  if (event.startsWith('webinar.')) return 'webinar';
  if (event.startsWith('session.')) return 'videoSdk';
  if (event.startsWith('contact_center.')) return 'contactCenter';
  if (event.startsWith('phone.')) return 'phone';
  return 'meeting';
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}
