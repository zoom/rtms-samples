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

/**
 * Zoom Phone (and V2 streams generally) can return more than one callback URL
 * for a single endpoint, separated by commas, for example
 * `wss://host/ws,srt://host:port`. Signaling and media WebSocket connections
 * must use the `wss://` URL. This helper splits a raw `server_urls` value and
 * returns the first allowed `ws`/`wss` URL, or undefined when none qualifies.
 */
export function selectAllowedRtmsCallbackUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value
    .split(',')
    .map((url) => url.trim())
    .find((url) => isAllowedRtmsCallbackUrl(url, allowedHosts));
}
