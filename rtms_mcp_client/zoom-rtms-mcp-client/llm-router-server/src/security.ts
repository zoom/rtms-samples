import crypto from 'node:crypto';

function exactMatch(receivedValue: string, expectedValue: string): boolean {
  const received = Buffer.from(receivedValue);
  const expected = Buffer.from(expectedValue);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

export function isBearerAuthorized(header: string | undefined, expectedToken: string): boolean {
  return Boolean(header?.startsWith('Bearer ') && exactMatch(header.slice(7), expectedToken));
}

export function safeTenantMatch(receivedTenant: string, expectedTenant: string): boolean {
  return exactMatch(receivedTenant, expectedTenant);
}

export function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; status?: unknown; name?: unknown };
    return String(candidate.code || candidate.status || candidate.name || 'operation_failed').slice(0, 80);
  }
  return 'operation_failed';
}

export function audit(event: string, fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: 'llm-router', event, ...fields }));
}
