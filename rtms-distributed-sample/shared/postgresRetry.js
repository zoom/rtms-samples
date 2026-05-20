import { retryWithBackoff } from './retry.js';

const TRANSIENT_POSTGRES_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01'
]);

export function isPostgresTransientError(error) {
  if (!error) return false;
  if (TRANSIENT_POSTGRES_CODES.has(error.code)) return true;
  if (error.cause) return isPostgresTransientError(error.cause);
  return false;
}

export function withPostgresRetry(operation, options = {}) {
  return retryWithBackoff(operation, {
    label: options.label || 'postgres operation',
    maxAttempts: options.maxAttempts || 5,
    baseDelayMs: options.baseDelayMs || 250,
    maxDelayMs: options.maxDelayMs || 5000,
    shouldRetry: isPostgresTransientError
  });
}
