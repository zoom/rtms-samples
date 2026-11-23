const DEFAULT_ALLOWED_RTMS_HOST_SUFFIXES = Object.freeze(['zoom.us']);

/**
 * Validates RTMS callback URLs (signaling/media) resolved from webhook payloads.
 * Only ws/wss URLs whose host matches the allowlist are accepted. Override the
 * allowlist with a comma-separated RTMS_ALLOWED_MEDIA_HOSTS env var.
 */
export function isAllowedRtmsCallbackUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return false;
  const configured = allowedHosts
    ?? (typeof process !== 'undefined' && process.env?.RTMS_ALLOWED_MEDIA_HOSTS
      ? process.env.RTMS_ALLOWED_MEDIA_HOSTS.split(',')
      : DEFAULT_ALLOWED_RTMS_HOST_SUFFIXES);
  const suffixes = configured
    .map((host) => String(host).trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  if (suffixes.length === 0) return true;
  const host = parsed.hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// RTMS protocol V2 can return several URLs for one endpoint, separated by
// commas (for example "wss://host/ws,srt://host:port"). WebSocket connections
// must use the ws/wss entry, so return the first allowed one.
export function selectAllowedRtmsCallbackUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value
    .split(',')
    .map((url) => url.trim())
    .find((url) => isAllowedRtmsCallbackUrl(url, allowedHosts));
}

// media_server.server_urls is usually an object keyed by media type
// (audio, video, deskshare, transcript, chat). V2 may instead return a single
// comma-separated string that serves every media type.
export function getRtmsMediaServerUrl(serverUrls, mediaType) {
  if (typeof serverUrls === 'string') return serverUrls;
  return serverUrls && typeof serverUrls === 'object' ? serverUrls[mediaType] : undefined;
}
