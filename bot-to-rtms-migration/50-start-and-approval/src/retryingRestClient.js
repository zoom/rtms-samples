import { backoffDelayMs } from '../../shared/codes.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Add the documented automatic retry for HTTP 429 to any REST-client shape with
 * start/stop/pause/resume. A Retry-After header wins; otherwise use the shared jittered
 * exponential backoff. Other outcomes are returned untouched for the caller's policy.
 */
export function createRetryingRestClient(rest, {
  attempts = 3,
  baseMs = 500,
  capMs = 30_000,
  random = Math.random,
  sleepImpl = sleep,
  trace = null,
  now = Date.now
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer');

  async function withRetry(action, ...args) {
    const operation = rest[action];
    if (typeof operation !== 'function') throw new Error(`rest client has no ${action}()`);
    let response;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      response = await operation.call(rest, ...args);
      if (response?.outcome?.name !== 'rate_limited' || attempt === attempts) return response;
      const retryAfterSeconds = response.outcome.retryAfterSeconds;
      const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : backoffDelayMs(attempt - 1, { baseMs, capMs, random });
      trace?.append('rest_retry_scheduled', {
        action, attempt, delayMs, retryAfterSeconds: retryAfterSeconds ?? null, at: now()
      });
      await sleepImpl(delayMs);
    }
    return response;
  }

  return {
    start: (...args) => withRetry('start', ...args),
    stop: (...args) => withRetry('stop', ...args),
    pause: (...args) => withRetry('pause', ...args),
    resume: (...args) => withRetry('resume', ...args)
  };
}
