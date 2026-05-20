const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN'
]);

export class HttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.method = details.method;
    this.url = details.url;
    this.status = details.status;
    this.body = details.body;
    this.transient = TRANSIENT_HTTP_STATUSES.has(details.status);
  }
}

export function isTransientError(error) {
  if (!error) return false;
  if (error.transient === true) return true;
  if (TRANSIENT_HTTP_STATUSES.has(error.status)) return true;
  if (TRANSIENT_ERROR_CODES.has(error.code)) return true;
  if (error.name === 'AbortError') return true;
  if (error.cause && isTransientError(error.cause)) return true;
  return false;
}

export function errorSummary(error) {
  if (!error) return 'unknown error';
  const parts = [error.name || 'Error'];
  if (error.status) parts.push(`status=${error.status}`);
  if (error.code) parts.push(`code=${error.code}`);
  if (error.message) parts.push(error.message);
  return parts.join(' ');
}
