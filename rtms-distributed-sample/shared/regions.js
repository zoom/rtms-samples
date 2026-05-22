export const KNOWN_RTMS_CODES = Object.freeze([
  'SJC',
  'IAD',
  'AMS',
  'FRA',
  'MEL',
  'SYD',
  'YYZ',
  'SIN',
  'NRT',
  'HKG'
]);

export const DEFAULT_SPOKE_GROUP_BY_RTMS_CODE = Object.freeze({
  SJC: 'amer-west',
  IAD: 'amer-east',
  YYZ: 'amer-east',
  AMS: 'europe',
  FRA: 'europe',
  SIN: 'apac-hub',
  HKG: 'apac-hub',
  NRT: 'apac-hub',
  SYD: 'apac-hub',
  MEL: 'apac-hub',
  UNKNOWN: 'us'
});

export const DEFAULT_SPOKE_GROUPS = Object.freeze([
  'amer-west',
  'amer-east',
  'europe',
  'apac-hub',
  'us',
  'UNKNOWN'
]);

const SPOKE_GROUP_ENV_KEYS = Object.freeze({
  'amer-west': ['SPOKE_AMER_WEST_URL', 'REGION_AMER_WEST_SPOKE_URL'],
  'amer-east': ['SPOKE_AMER_EAST_URL', 'REGION_AMER_EAST_SPOKE_URL'],
  europe: ['SPOKE_EUROPE_URL', 'REGION_EUROPE_SPOKE_URL'],
  'apac-hub': ['SPOKE_APAC_HUB_URL', 'REGION_APAC_HUB_SPOKE_URL'],
  us: ['SPOKE_US_URL', 'REGION_US_SPOKE_URL'],
  UNKNOWN: ['SPOKE_UNKNOWN_URL', 'REGION_UNKNOWN_SPOKE_URL']
});

export function isStartEvent(event = '') {
  return event.endsWith('rtms_started');
}

export function isStopEvent(event = '') {
  return event.endsWith('rtms_stopped');
}

export function isInterruptedEvent(event = '') {
  return event.endsWith('rtms_interrupted');
}

export function getProductType(event = '') {
  if (event.startsWith('meeting.')) return 'meeting';
  if (event.startsWith('webinar.')) return 'webinar';
  if (event.startsWith('session.')) return 'videoSdk';
  if (event.startsWith('contact_center.')) return 'contactCenter';
  if (event.startsWith('phone.')) return 'phone';
  return 'unknown';
}

export function getStreamId(payload = {}) {
  return payload.rtms_stream_id || payload.stream_id || null;
}

export function getRtmsId(payload = {}, productType = 'meeting') {
  if (productType === 'videoSdk') return payload.session_id || null;
  if (productType === 'contactCenter') return payload.engagement_id || payload.session_id || null;
  if (productType === 'phone') return payload.call_id || null;
  return payload.meeting_uuid || payload.webinar_uuid || null;
}

export function extractRtmsRegionCode(serverUrls) {
  const url = firstUrl(serverUrls);
  if (!url) return 'UNKNOWN';

  try {
    const hostname = new URL(url).hostname;
    const labels = hostname.split('.');
    const zoomIndex = labels.lastIndexOf('zoom');
    if (zoomIndex <= 0 || labels[zoomIndex + 1] !== 'us') return 'UNKNOWN';

    const code = labels[zoomIndex - 1].toUpperCase();
    return isPlausibleRtmsCode(code) ? code : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

export function getSpokeGroupForRtmsCode(regionCode = 'UNKNOWN', mapping = DEFAULT_SPOKE_GROUP_BY_RTMS_CODE) {
  const normalizedCode = String(regionCode || 'UNKNOWN').toUpperCase();
  return mapping[normalizedCode] || mapping.UNKNOWN || 'UNKNOWN';
}

export function parseSpokeGroupMapping(value = process.env.RTMS_SPOKE_GROUP_BY_CODE) {
  if (!value) return DEFAULT_SPOKE_GROUP_BY_RTMS_CODE;

  try {
    return {
      ...DEFAULT_SPOKE_GROUP_BY_RTMS_CODE,
      ...JSON.parse(value)
    };
  } catch (error) {
    throw new Error(`Invalid RTMS_SPOKE_GROUP_BY_CODE JSON: ${error.message}`);
  }
}

export function parseSpokeEndpoints(env = process.env) {
  const endpoints = {};

  if (env.HUB_SPOKE_ENDPOINTS) {
    try {
      Object.assign(endpoints, JSON.parse(env.HUB_SPOKE_ENDPOINTS));
    } catch (error) {
      throw new Error(`Invalid HUB_SPOKE_ENDPOINTS JSON: ${error.message}`);
    }
  }

  for (const code of [...KNOWN_RTMS_CODES, 'UNKNOWN']) {
    const value = env[`REGION_${code}_SPOKE_URL`];
    if (value) endpoints[code] = value;
  }

  for (const group of DEFAULT_SPOKE_GROUPS) {
    const value = firstConfiguredValue(env, SPOKE_GROUP_ENV_KEYS[group] || []);
    if (value) endpoints[group] = value;
  }

  return endpoints;
}

function firstConfiguredValue(env, keys) {
  for (const key of keys) {
    if (env[key]) return env[key];
  }
  return '';
}

function firstUrl(serverUrls) {
  if (typeof serverUrls === 'string') return serverUrls;
  if (!serverUrls || typeof serverUrls !== 'object') return '';

  return (
    serverUrls.all ||
    serverUrls.audio ||
    serverUrls.video ||
    serverUrls.transcript ||
    Object.values(serverUrls).find((value) => typeof value === 'string' && value.startsWith('ws')) ||
    ''
  );
}

function isPlausibleRtmsCode(code = '') {
  return /^[A-Z0-9-]{2,16}$/.test(code) && code !== 'WWW' && code !== 'ZOOM';
}
