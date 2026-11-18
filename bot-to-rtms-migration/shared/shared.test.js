import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backoffDelayMs, classifyClientMessage, classifyRestOutcome, decideRequestStatus, decideStop,
  REQUEST_STATUS, STOP_REASONS
} from './codes.js';
import { rtmsHandshakeSignature, signWebhook, urlValidationResponse, verifyWebhook, webhookDedupeKey } from './webhookSignature.js';
import { createClaimRegistry, streamKey } from './claims.js';
import { createTenantGate } from './tenantGate.js';
import { createTrace, readTrace } from './trace.js';
import { normalizeStartedPayload } from './rtmsPayload.js';

const SECRET = 'test-secret';

test('webhook signature round trip, tamper, stale and missing header', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'meeting.rtms_started', payload: {} }));
  const headers = signWebhook(rawBody, SECRET);
  assert.equal(verifyWebhook({ headers, rawBody, secret: SECRET }).ok, true);
  assert.equal(verifyWebhook({ headers, rawBody: Buffer.from('{"x":1}'), secret: SECRET }).reason, 'invalid_x_zm_signature');
  assert.equal(verifyWebhook({ headers, rawBody, secret: 'other' }).reason, 'invalid_x_zm_signature');
  const old = signWebhook(rawBody, SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyWebhook({ headers: old, rawBody, secret: SECRET }).reason, 'stale_x_zm_request_timestamp');
  assert.equal(verifyWebhook({ headers: {}, rawBody, secret: SECRET }).reason, 'missing_x_zm_signature');
  assert.equal(verifyWebhook({ headers, rawBody, secret: '' }).reason, 'missing_webhook_secret_token');
});

test('url validation and handshake signature are deterministic HMACs', () => {
  const a = urlValidationResponse('abc', SECRET);
  assert.equal(a.plainToken, 'abc');
  assert.match(a.encryptedToken, /^[0-9a-f]{64}$/);
  const s1 = rtmsHandshakeSignature('cid', 'mtg', 'stream', 'secret');
  assert.equal(s1, rtmsHandshakeSignature('cid', 'mtg', 'stream', 'secret'));
  assert.notEqual(s1, rtmsHandshakeSignature('cid', 'mtg', 'stream2', 'secret'));
});

test('dedupe key ignores delivery metadata and keeps stream identity', () => {
  const body = { event: 'meeting.rtms_started', event_ts: 1700000000000, payload: { account_id: 'A', meeting_uuid: 'M', rtms_stream_id: 'S' } };
  assert.equal(webhookDedupeKey(body), 'meeting.rtms_started|A|M|S|1700000000000');
  assert.notEqual(webhookDedupeKey(body), webhookDedupeKey({ ...body, payload: { ...body.payload, rtms_stream_id: 'S2' } }));
});

test('payload shape accepts flat and payload.object forms', () => {
  const flat = normalizeStartedPayload('meeting.rtms_started', { meeting_uuid: 'M', rtms_stream_id: 'S', account_id: 'A' });
  const nested = normalizeStartedPayload('meeting.rtms_started', { object: { meeting_uuid: 'M', rtms_stream_id: 'S', account_id: 'A' } });
  assert.deepEqual([flat.meetingId, flat.streamId, flat.accountId], [nested.meetingId, nested.streamId, nested.accountId]);
});

test('claim registry: one winner, duplicate rejected, stale lease superseded and fenced', () => {
  let t = 1000;
  const reg = createClaimRegistry({ leaseMs: 100, now: () => t });
  const key = streamKey({ tenantId: 't', product: 'meeting', meetingId: 'm', streamId: 's' });
  const a = reg.claim(key, 'worker-a');
  assert.deepEqual([a.ok, a.outcome, a.generation], [true, 'claimed', 1]);
  const dup = reg.claim(key, 'worker-b');
  assert.deepEqual([dup.ok, dup.outcome], [false, 'duplicate']);
  t += 150; // worker-a stopped renewing
  const b = reg.claim(key, 'worker-b');
  assert.deepEqual([b.ok, b.outcome, b.generation, b.previousOwner], [true, 'superseded', 2, 'worker-a']);
  assert.equal(reg.renew(key, 'worker-a', 1).outcome, 'fenced');
  assert.equal(reg.release(key, 'worker-a', 1).outcome, 'fenced');
  assert.equal(reg.owns(key, 'worker-b', 2), true);
  assert.equal(reg.release(key, 'worker-b', 2).outcome, 'released');
  assert.equal(reg.claim(key, 'worker-c').outcome, 'already_finished');
  assert.equal(reg.release(key, 'worker-b', 2).outcome, 'already_released');
});

test('claim registry: the same owner re-claiming renews instead of superseding', () => {
  let t = 0;
  const reg = createClaimRegistry({ leaseMs: 100, now: () => t });
  reg.claim('k', 'a');
  t = 50;
  assert.equal(reg.claim('k', 'a').outcome, 'renewed');
  t = 140;
  assert.equal(reg.claim('k', 'b').outcome, 'duplicate');
});

test('request status: known codes map to actions, unknown is never success', () => {
  for (const code of Object.keys(REQUEST_STATUS)) assert.equal(decideRequestStatus({ status: Number(code) }).known, true);
  const upd = decideRequestStatus({ status: 7, reboot_in_minutes: 15, rtms_stream_id: 'S' });
  assert.deepEqual([upd.pauseStarts, upd.rebootInMinutes, upd.retry], [true, 15, 'wait_for_reboot']);
  assert.equal(decideRequestStatus({ status: 8 }).resumeStarts, true);
  assert.equal(decideRequestStatus({ status: 6 }).retry, 'backoff');
  const unknown = decideRequestStatus({ status: 99 });
  assert.deepEqual([unknown.known, unknown.alert, unknown.retry], [false, true, 'never']);
});

test('stop reasons: every stop finalizes, revoked purges, unknown alerts', () => {
  for (const code of Object.keys(STOP_REASONS)) assert.equal(decideStop(Number(code)).finalize, true);
  assert.equal(decideStop(8).purge, true);
  assert.equal(decideStop(6).restart, 'none');
  assert.equal(decideStop(4).restart, 'never');
  assert.equal(decideStop(999).alert, true);
});

test('REST outcomes classify by body code first, then http status', () => {
  assert.equal(classifyRestOutcome(204).waitForWebhook, true);
  assert.equal(classifyRestOutcome(400, { code: 13267 }).name, 'rtms_app_disabled');
  assert.equal(classifyRestOutcome(400, { code: 3000 }).retry, 'later');
  assert.equal(classifyRestOutcome(429).retry, 'backoff');
  assert.equal(classifyRestOutcome(404).name, 'not_found');
  assert.equal(classifyRestOutcome(500).known, false);
});

test('client messages match case-insensitively and carry the hint', () => {
  assert.equal(classifyClientMessage('request sent to the host.').state, 'pending_host');
  assert.equal(classifyClientMessage('Host disabled your app from sharing content.').retry, 'never');
  assert.equal(classifyClientMessage('something else'), null);
});

test('backoff grows, is capped and is jittered', () => {
  const max = () => 0.9999;
  assert.ok(backoffDelayMs(0, { random: max }) < 1000);
  assert.ok(backoffDelayMs(3, { random: max }) < 8000);
  assert.ok(backoffDelayMs(20, { random: max, capMs: 30000 }) < 30000);
  assert.equal(backoffDelayMs(5, { random: () => 0 }), 0);
});

test('tenant gate: allow, deny reasons, revoke and path safety', () => {
  const gate = createTenantGate([
    { tenantId: 'acme', accountIds: ['A1'], products: ['meeting'], media: ['audio', 'transcript'], consentRef: 'consent-1', policyVersion: 'p7' },
    { tenantId: 'noconsent', accountIds: ['A2'], products: ['meeting'], media: ['audio'] }
  ]);
  assert.equal(gate.check({ accountId: 'A1', product: 'meeting', media: ['audio'] }).ok, true);
  assert.equal(gate.check({ accountId: 'A1', product: 'meeting', media: ['audio'] }).consentRef, 'consent-1');
  assert.equal(gate.check({ accountId: 'A9', product: 'meeting' }).reason, 'unknown_account');
  assert.equal(gate.check({ accountId: 'A1', product: 'webinar' }).reason, 'product_not_enabled');
  assert.deepEqual(gate.check({ accountId: 'A1', product: 'meeting', media: ['video'] }).missing, ['video']);
  assert.equal(gate.check({ accountId: 'A2', product: 'meeting', media: ['audio'] }).reason, 'missing_consent_ref');
  assert.equal(gate.revoke('acme'), true);
  assert.equal(gate.check({ accountId: 'A1', product: 'meeting' }).reason, 'tenant_revoked');
  assert.equal(gate.tenantPath('acme', 'date=2026-11-05', 'x.md'), 'tenant=acme/date=2026-11-05/x.md');
  assert.throws(() => gate.tenantPath('acme', '../other'), /invalid_path_part/);
  assert.throws(() => gate.tenantPath('../x', 'a'), /invalid_tenant_id/);
});

test('trace writes one line per event and skips malformed lines on read', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'trace-')), 'nested', 'events.jsonl');
  const trace = createTrace(file, { now: () => 1700000000000 });
  trace.append('start_attempt', { streamId: 'S' });
  trace.append('stream_state', { streamId: 'S', state: 'ACTIVE' });
  appendFileSync(file, 'not json\n{"no":"type"}\n');
  const { events, malformed } = readTrace(file);
  assert.equal(events.length, 2);
  assert.equal(malformed, 2);
  assert.equal(events[0].type, 'start_attempt');
  assert.equal(events[0].v, 1);
  assert.deepEqual(readTrace(join(tmpdir(), 'does-not-exist.jsonl')), { events: [], malformed: 0 });
  writeFileSync(file, '');
  assert.equal(readTrace(file).events.length, 0);
});

test('claim registry: abandon leaves no tombstone, and a fenced owner cannot abandon', () => {
  let t = 0;
  const reg = createClaimRegistry({ leaseMs: 100, now: () => t });
  reg.claim('k', 'a');
  assert.equal(reg.abandon('k', 'b', 1).outcome, 'fenced');
  assert.equal(reg.abandon('k', 'a', 1).outcome, 'abandoned');
  assert.equal(reg.size(), 0);
  assert.equal(reg.claim('k', 'c').outcome, 'claimed', 'the key is free again');
  assert.equal(reg.abandon('missing', 'a', 1).outcome, 'not_held');
});
