const RTMS_ENTITY_KEYS = Object.freeze({
  meeting: 'meeting_uuid',
  webinar: 'webinar_uuid',
  videoSdk: 'session_id',
  contactCenter: 'engagement_id',
  phone: 'call_id'
});

export function getRtmsEntityKey(rtmsType = 'meeting') {
  return RTMS_ENTITY_KEYS[rtmsType] || RTMS_ENTITY_KEYS.meeting;
}

export function buildRtmsEntityPayload(rtmsType, rtmsId) {
  return { [getRtmsEntityKey(rtmsType)]: rtmsId };
}

export function getRtmsIdFromPayload(rtmsType, payload = {}) {
  if (rtmsType === 'contactCenter') {
    return payload.engagement_id || payload.session_id || null;
  }

  const entityKey = getRtmsEntityKey(rtmsType);
  return payload[entityKey] || null;
}

export function getPreferredMediaUrl(rtmsType, serverUrls, preferredType = null) {
  if (typeof serverUrls === 'string') {
    return serverUrls;
  }

  if (!serverUrls || typeof serverUrls !== 'object') {
    return '';
  }

  if (preferredType && serverUrls[preferredType]) {
    return serverUrls[preferredType];
  }

  if (rtmsType === 'contactCenter' && serverUrls.audio) {
    return serverUrls.audio;
  }

  return (
    serverUrls.all ||
    serverUrls.audio ||
    Object.values(serverUrls).find((url) => typeof url === 'string' && url.startsWith('ws')) ||
    ''
  );
}
