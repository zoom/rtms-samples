import assert from 'node:assert/strict';
import test from 'node:test';
import { isBearerAuthorized, safeErrorCode, safeTenantMatch } from './security.js';

test('requires exact service and tenant credentials', () => {
  assert.equal(isBearerAuthorized('Bearer shared-secret', 'shared-secret'), true);
  assert.equal(isBearerAuthorized('Bearer wrong', 'shared-secret'), false);
  assert.equal(isBearerAuthorized(undefined, 'shared-secret'), false);
  assert.equal(safeTenantMatch('account-a', 'account-a'), true);
  assert.equal(safeTenantMatch('account-b', 'account-a'), false);
});

test('reduces provider errors to a safe code', () => {
  assert.equal(safeErrorCode({ status: 429, message: 'secret response body' }), '429');
  assert.equal(safeErrorCode(new Error('secret response body')), 'Error');
});
