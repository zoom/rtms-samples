import { errorSummary, isTransientError } from './errors.js';

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 10000
});

export async function retryWithBackoff(operation, options = {}) {
  const policy = {
    ...DEFAULT_RETRY_POLICY,
    ...options
  };
  const shouldRetry = policy.shouldRetry || isTransientError;
  let lastError;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation({ attempt });
    } catch (error) {
      lastError = error;
      const retryable = attempt < policy.maxAttempts && shouldRetry(error, { attempt });
      if (!retryable) {
        throw error;
      }

      const delayMs = fullJitterDelay(attempt, policy.baseDelayMs, policy.maxDelayMs);
      if (policy.onRetry) {
        policy.onRetry({
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          error
        });
      } else if (policy.label) {
        console.warn(`[retry] ${policy.label} attempt ${attempt} failed; retrying in ${delayMs}ms: ${errorSummary(error)}`);
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function fullJitterDelay(attempt, baseDelayMs = 250, maxDelayMs = 10000) {
  const cap = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * (cap + 1));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
