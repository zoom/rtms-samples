import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryTrace } from '../shared/trace.js';
import { signWebhook } from '../shared/webhookSignature.js';
import { createOAuth, fileTokenStore, memoryTokenStore } from './src/oauth.js';

// Zoom is replaced by a scripted fetch. Nothing here touches the network.
function setup({ scopes = 'meeting:read:meeting_audio meeting:update:participant_rtms_app_status', required = [], tokenResponses = [] } = {}) {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const calls = [];
  const queue = [...tokenResponses];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.endsWith('/oauth/token')) {
      const next = queue.shift() || { status: 200, json: { access_token: `at${calls.length}`, refresh_token: `rt${calls.length}`, expires_in: 3600, scope: scopes } };
      return { status: next.status, text: async () => JSON.stringify(next.json ?? {}) };
    }
    if (u.endsWith('/users/me')) return { status: 200, json: async () => ({ id: 'user-1', account_id: 'acct-1' }) };
    throw new Error(`unexpected url ${u}`);
  };
  const trace = createMemoryTrace(clock.now);
  const store = memoryTokenStore();
  const oauth = createOAuth({
    clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://app.example.com/oauth/callback', webhookSecret: 'whsec',
    store, trace, fetchImpl, now: clock.now, requiredScopes: required
  });
  const tokenCalls = () => calls.filter((c) => c.url.endsWith('/oauth/token'));
  return { oauth, store, trace, clock, calls, tokenCalls };
}

test('authorize: state works once, the code is exchanged, and the user is identified', async () => {
  const s = setup();
  const { url, state } = s.oauth.beginAuthorization({ product_user: 'u-42' });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://zoom.us/oauth/authorize');
  assert.equal(parsed.searchParams.get('client_id'), 'cid');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app.example.com/oauth/callback');

  const result = await s.oauth.completeAuthorization({ code: 'abc', state });
  assert.deepEqual([result.userId, result.accountId, result.status, result.context], ['user-1', 'acct-1', 'authorized', { product_user: 'u-42' }]);

  const exchange = s.tokenCalls()[0];
  assert.match(exchange.init.headers.authorization, /^Basic /);
  assert.match(exchange.init.body, /grant_type=authorization_code/);
  assert.match(exchange.init.body, /code=abc/);

  await assert.rejects(() => s.oauth.completeAuthorization({ code: 'abc', state }), /invalid_or_expired_state/);
  await assert.rejects(() => s.oauth.completeAuthorization({ code: 'abc', state: 'made-up' }), /invalid_or_expired_state/);
  assert.ok(s.trace.events.some((e) => e.type === 'user_authorized' && e.userId === 'user-1'));
});

test('authorize: a state that is too old is refused', async () => {
  const s = setup();
  const { state } = s.oauth.beginAuthorization();
  s.clock.advance(11 * 60 * 1000);
  await assert.rejects(() => s.oauth.completeAuthorization({ code: 'abc', state }), /invalid_or_expired_state/);
});

test('tokens: a fresh token is reused, an expiring one is refreshed, and the new refresh token is kept', async () => {
  const s = setup();
  await s.oauth.exchangeCode('abc');
  const first = await s.oauth.accessToken('user-1');
  assert.equal(first.ok, true);
  assert.equal(s.tokenCalls().length, 1, 'no refresh while the token is fresh');

  s.clock.advance(3600 * 1000 - 30_000); // inside the 60 second safety margin
  const second = await s.oauth.accessToken('user-1');
  assert.equal(second.ok, true);
  assert.notEqual(second.accessToken, first.accessToken);
  const refreshCall = s.tokenCalls()[1];
  assert.match(refreshCall.init.body, /grant_type=refresh_token/);
  assert.match(refreshCall.init.body, /refresh_token=rt1/);
  assert.equal((await s.store.get('user-1')).refreshToken, 'rt3', 'the newest refresh token replaces the old one');
});

test('tokens: callers that arrive together share one refresh', async () => {
  const s = setup();
  await s.oauth.exchangeCode('abc');
  s.clock.advance(3600 * 1000);
  const results = await Promise.all([s.oauth.accessToken('user-1'), s.oauth.accessToken('user-1'), s.oauth.accessToken('user-1')]);
  assert.equal(s.tokenCalls().length, 2, 'one exchange plus exactly one refresh');
  assert.equal(new Set(results.map((r) => r.accessToken)).size, 1);
});

test('tokens: a rejected refresh token means the user must authorize again, and nothing else is retried', async () => {
  const s = setup({ tokenResponses: [
    { status: 200, json: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 's' } },
    { status: 400, json: { reason: 'Invalid_refresh_token' } }
  ] });
  await s.oauth.exchangeCode('abc');
  s.clock.advance(3600 * 1000);
  const r = await s.oauth.accessToken('user-1');
  assert.deepEqual([r.ok, r.reason], [false, 'reauthorization_required']);
  const before = s.tokenCalls().length;
  const again = await s.oauth.accessToken('user-1');
  assert.equal(again.reason, 'reauthorization_required');
  assert.equal(s.tokenCalls().length, before, 'no further network calls for a user who must reauthorize');
  assert.ok(s.trace.events.some((e) => e.type === 'user_reauthorization_required'));
});

test('tokens: a transient refresh failure is not treated as a reason to reauthorize', async () => {
  const s = setup({ tokenResponses: [
    { status: 200, json: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 's' } },
    { status: 503, json: {} }
  ] });
  await s.oauth.exchangeCode('abc');
  s.clock.advance(3600 * 1000);
  const r = await s.oauth.accessToken('user-1');
  assert.equal(r.reason, 'refresh_failed_retryable');
  assert.equal((await s.store.get('user-1')).status, 'authorized');
});

test('scopes: tokens issued before a scope was added are flagged for reauthorization', async () => {
  const s = setup({ scopes: 'meeting:read:meeting_audio', required: ['meeting:read:meeting_audio', 'meeting:read:meeting_transcript'] });
  const result = await s.oauth.exchangeCode('abc');
  assert.equal(result.status, 'reauthorization_required');
  const r = await s.oauth.accessToken('user-1');
  assert.deepEqual([r.ok, r.reason], [false, 'reauthorization_required']);
  assert.match(r.detail, /missing_scope:meeting:read:meeting_transcript/);
  assert.deepEqual(await s.oauth.summary(), { total: 1, authorized: 0, reauthorizationRequired: 1 });
});

test('401 from the API: the next call refreshes, and a user can be flagged by hand', async () => {
  const s = setup();
  await s.oauth.exchangeCode('abc');
  const before = (await s.oauth.accessToken('user-1')).accessToken;
  await s.oauth.expireAccessToken('user-1');
  const after = (await s.oauth.accessToken('user-1')).accessToken;
  assert.notEqual(before, after);
  await s.oauth.markReauthorizationRequired('user-1', 'rest_401');
  assert.equal((await s.oauth.accessToken('user-1')).reason, 'reauthorization_required');
});

test('unknown users get a clear answer, and reports never contain a token', async () => {
  const s = setup();
  assert.equal((await s.oauth.accessToken('nobody')).reason, 'unknown_user');
  await s.oauth.exchangeCode('abc');
  const dump = JSON.stringify(await s.oauth.users());
  assert.doesNotMatch(dump, /at\d|rt\d/);
});

test('deauthorization: a signed notification deletes the user, a forged one does nothing', async () => {
  const s = setup();
  await s.oauth.exchangeCode('abc');
  const body = Buffer.from(JSON.stringify({ event: 'app_deauthorized', event_ts: s.clock.now(), payload: { user_id: 'user-1', account_id: 'acct-1', client_id: 'cid' } }));
  const ts = Math.floor(s.clock.now() / 1000);

  const forged = await s.oauth.handleDeauthorization({ headers: signWebhook(body, 'wrong-secret', ts), rawBody: body });
  assert.equal(forged.status, 401);
  assert.ok(await s.store.get('user-1'));

  const good = await s.oauth.handleDeauthorization({ headers: signWebhook(body, 'whsec', ts), rawBody: body });
  assert.deepEqual([good.status, good.userId], [200, 'user-1']);
  assert.equal(await s.store.get('user-1'), null);
  assert.ok(s.trace.events.some((e) => e.type === 'user_deauthorized'));

  const other = Buffer.from(JSON.stringify({ event: 'app_deauthorized', event_ts: s.clock.now(), payload: { user_id: 'user-2', client_id: 'someone-else' } }));
  const ignored = await s.oauth.handleDeauthorization({ headers: signWebhook(other, 'whsec', ts), rawBody: other });
  assert.equal(ignored.body.status, 'ignored');
});

test('file store: round trip, owner-only permissions, and delete', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'oauth-')), 'tokens');
  const store = fileTokenStore(dir);
  await store.set('a/b', { accessToken: 'x', refreshToken: 'y', status: 'authorized' });
  assert.equal((await store.get('a/b')).refreshToken, 'y');
  assert.deepEqual((await store.list()).map((u) => u.userId), ['a/b']);
  const file = path.join(dir, `${encodeURIComponent('a/b')}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await store.delete('a/b');
  assert.equal(await store.get('a/b'), null);
});
