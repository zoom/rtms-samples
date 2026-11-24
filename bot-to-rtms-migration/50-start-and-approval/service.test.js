import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaimRegistry } from '../shared/claims.js';
import { createMemoryTrace } from '../shared/trace.js';
import { createTenantGate } from '../shared/tenantGate.js';
import { signWebhook } from '../shared/webhookSignature.js';
import { createRestClient, encodeMeetingId } from './src/restClient.js';
import { createStartService } from './src/service.js';

const SECRET = 'unit-secret';
const TENANT = { tenantId: 'acme', accountIds: ['A1'], products: ['meeting'], media: ['audio', 'transcript'], consentRef: 'consent-1', policyVersion: 'p1' };

function setup(overrides = {}) {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const trace = createMemoryTrace(clock.now);
  const claims = overrides.claims || createClaimRegistry({ leaseMs: 1000, now: clock.now });
  const timers = [];
  const calls = { ready: [], refresh: [], stopped: [], alerts: [], declined: [] };
  const service = createStartService({
    secret: SECRET, clientId: 'cid', workerId: overrides.workerId || 'w1', trace, claims,
    gate: createTenantGate([TENANT]), rest: overrides.rest || createRestClient({ clientId: 'cid' }),
    now: clock.now, random: () => 0.5, watchdogMs: 5000,
    setTimer: (fn, ms) => { const h = { fn, ms, cancelled: false }; timers.push(h); return h; },
    clearTimer: (h) => { h.cancelled = true; },
    onStreamReady: (s) => calls.ready.push(s), onStreamRefresh: (s) => calls.refresh.push(s),
    onStreamStopped: (s, d) => calls.stopped.push({ s, d }), onAlert: (a) => calls.alerts.push(a),
    onStreamDeclined: (d) => calls.declined.push(d),
    ...(overrides.serviceOptions || {})
  });
  const send = async (event, payload, { eventTs, requestId, headers, rawOverride } = {}) => {
    const rawBody = rawOverride || Buffer.from(JSON.stringify({ event, event_ts: eventTs ?? clock.now(), payload }));
    const result = service.handleWebhook({ headers: headers || { ...signWebhook(rawBody, SECRET, Math.floor(clock.now() / 1000)), 'x-zm-request-id': requestId }, rawBody });
    await result.done;
    return result;
  };
  const types = () => trace.events.map((e) => e.type);
  return { service, trace, claims, clock, timers, calls, send, types };
}

const started = (extra = {}) => ({ account_id: 'A1', meeting_uuid: 'M1', meeting_id: '123', rtms_stream_id: 'S1', operator_id: 'u1', server_urls: { audio: 'wss://x/audio' }, ...extra });

test('unsigned, wrongly signed, stale and malformed webhooks are rejected before any work', async () => {
  const s = setup();
  assert.equal((await s.send('meeting.rtms_started', started(), { headers: {} })).status, 401);
  const raw = Buffer.from(JSON.stringify({ event: 'meeting.rtms_started', payload: started() }));
  assert.equal((await s.send('x', {}, { rawOverride: raw, headers: signWebhook(raw, 'wrong', Math.floor(s.clock.now() / 1000)) })).status, 401);
  assert.equal((await s.send('x', {}, { rawOverride: raw, headers: signWebhook(raw, SECRET, Math.floor(s.clock.now() / 1000) - 1000) })).status, 401);
  const junk = Buffer.from('not json');
  assert.equal((await s.send('x', {}, { rawOverride: junk, headers: signWebhook(junk, SECRET, Math.floor(s.clock.now() / 1000)) })).status, 400);
  assert.equal(s.calls.ready.length, 0);
  assert.deepEqual(s.types(), ['webhook_rejected', 'webhook_rejected', 'webhook_rejected', 'webhook_rejected']);
});

test('URL validation is answered with the encrypted token', async () => {
  const s = setup();
  const r = await s.send('endpoint.url_validation', { plainToken: 'abc' });
  assert.equal(r.status, 200);
  assert.equal(r.body.plainToken, 'abc');
  assert.match(r.body.encryptedToken, /^[0-9a-f]{64}$/);
});

test('started opens exactly one stream; retries and refreshes never open a second', async () => {
  const s = setup();
  assert.equal((await s.send('meeting.rtms_started', started(), { eventTs: 10 })).body.status, 'accepted');
  assert.equal(s.calls.ready.length, 1);
  assert.equal(s.calls.ready[0].consentRef, 'consent-1');
  assert.equal((await s.send('meeting.rtms_started', started(), { eventTs: 10 })).body.status, 'duplicate', 'Zoom retry has the same natural key');
  assert.equal((await s.send('meeting.rtms_started', started(), { eventTs: 11, requestId: 'r-1' })).body.status, 'accepted');
  assert.equal(s.calls.ready.length, 1, 'fresh started for a live stream is a refresh');
  assert.equal(s.calls.refresh.length, 1);
  assert.equal((await s.send('meeting.rtms_started', started(), { eventTs: 12, requestId: 'r-1' })).body.status, 'duplicate', 'same delivery id');
  assert.deepEqual(s.types().filter((t) => t !== 'webhook_duplicate'), ['stream_claimed', 'stream_refresh']);
});

test('a second worker sharing the registry cannot take a healthy stream', async () => {
  const first = setup();
  const second = setup({ claims: first.claims, workerId: 'w2' });
  await first.send('meeting.rtms_started', started(), { eventTs: 1 });
  await second.send('meeting.rtms_started', started(), { eventTs: 2 });
  assert.equal(second.calls.ready.length, 0);
  assert.ok(second.types().includes('duplicate_stream_dropped'));
});

test('a crashed owner is superseded after its lease expires, and the old owner is fenced', async () => {
  const first = setup();
  const second = setup({ claims: first.claims, workerId: 'w2' });
  await first.send('meeting.rtms_started', started(), { eventTs: 1 });
  first.clock.advance(1500); // w1 stopped renewing; both services share one test clock via claims
  const secondNow = second.clock; secondNow.advance(1500);
  // Registry uses the first clock. Ask the second worker to take over.
  await second.send('meeting.rtms_started', started(), { eventTs: 2 });
  assert.equal(second.calls.ready.length, 1);
  assert.equal(second.calls.ready[0].generation, 2);
  assert.equal(first.service.heartbeat().length, 1, 'old owner finds out it was fenced');
  assert.ok(first.types().includes('claim_fenced'));
  assert.equal(first.calls.alerts.at(-1).type, 'claim_fenced');
});

test('heartbeat keeps a healthy lease alive', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started(), { eventTs: 1 });
  for (let i = 0; i < 5; i += 1) { s.clock.advance(600); assert.equal(s.service.heartbeat().length, 0); }
  assert.equal(s.service.snapshot().active.length, 1);
});

test('unknown account or missing consent never gets a claim', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started({ account_id: 'nobody' }), { eventTs: 1 });
  assert.equal(s.trace.events.at(-1).reason, 'unknown_account');
  assert.equal(s.claims.size(), 0);
  assert.equal(s.calls.alerts[0].type, 'stream_refused');
  await s.send('meeting.rtms_started', { account_id: 'A1', meeting_uuid: 'M2' }, { eventTs: 2 });
  assert.equal(s.trace.events.at(-1).reason, 'incomplete_payload');
});

test('stopped finalizes, releases the claim and blocks late duplicates', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started(), { eventTs: 1 });
  await s.send('meeting.rtms_stopped', { account_id: 'A1', meeting_uuid: 'M1', rtms_stream_id: 'S1', stop_reason: 6 }, { eventTs: 2 });
  const stop = s.trace.events.find((e) => e.type === 'stream_stopped');
  assert.deepEqual([stop.held, stop.reasonName, stop.restart, stop.purge], [true, 'meeting_ended', 'none', false]);
  assert.equal(s.calls.stopped.length, 1);
  assert.equal(s.service.snapshot().active.length, 0);
  await s.send('meeting.rtms_started', started(), { eventTs: 3 });
  assert.equal(s.trace.events.at(-1).type, 'late_duplicate_dropped');
  assert.equal(s.calls.ready.length, 1);
  await s.send('meeting.rtms_stopped', { account_id: 'A1', meeting_uuid: 'M1', rtms_stream_id: 'S1', stop_reason: 6 }, { eventTs: 4 });
  assert.equal(s.trace.events.at(-1).held, false, 'a duplicate stop is idempotent');
});

test('stream revoked asks for purge and raises an alert', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started(), { eventTs: 1 });
  await s.send('meeting.rtms_stopped', { account_id: 'A1', meeting_uuid: 'M1', rtms_stream_id: 'S1', stop_reason: 8 }, { eventTs: 2 });
  assert.equal(s.trace.events.find((e) => e.type === 'stream_stopped').purge, true);
  assert.equal(s.calls.alerts.at(-1).type, 'stop_alert');
  assert.equal(s.calls.stopped[0].d.purge, true);
});

test('late stream_revoked after releaseStream still purges and alerts, and releaseStream frees concurrency', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started(), { eventTs: 1 });
  await s.send('rtms.concurrency_limited', { account_id: 'A1', concurrency_number: 10, concurrency_limit: 10 }, { eventTs: 2 });
  assert.equal(s.service.startsAllowed({ critical: true }).reason, 'concurrency_limited');
  s.service.releaseStream('S1', 'client_finished');
  assert.equal(s.service.startsAllowed({ critical: true }).allowed, true, 'releasing a stream frees a slot from limited to near');
  await s.send('meeting.rtms_stopped', { account_id: 'A1', meeting_uuid: 'M1', rtms_stream_id: 'S1', stop_reason: 8 }, { eventTs: 3 });
  assert.equal(s.calls.alerts.at(-1).type, 'stop_alert');
  assert.equal(s.calls.stopped.at(-1).d.purge, true);
});

test('an interrupted webhook is recorded and does not open anything', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started(), { eventTs: 1 });
  await s.send('meeting.rtms_interrupted', { account_id: 'A1', meeting_uuid: 'M1', rtms_stream_id: 'S1' }, { eventTs: 2 });
  assert.equal(s.calls.ready.length, 1);
  assert.deepEqual(s.trace.events.at(-1), { ...s.trace.events.at(-1), type: 'stream_interrupted', held: true, source: 'webhook' });
});

test('request_status 7 pauses starts until the reboot time, 8 resumes, unknown alerts', async () => {
  const s = setup();
  await s.send('rtms.request_status', { status: 7, reboot_in_minutes: 10 }, { eventTs: 1 });
  const gate = s.service.startsAllowed();
  assert.equal(gate.allowed, false);
  assert.equal(gate.retryAt, s.clock.now() + 10 * 60_000);
  const refused = await s.service.requestStart({ meetingId: '1', accountId: 'A1' });
  assert.equal(refused.reason, 'server_update_scheduled');
  await s.send('rtms.request_status', { status: 8 }, { eventTs: 2 });
  assert.equal(s.service.startsAllowed().allowed, true);
  await s.send('rtms.request_status', { status: 99 }, { eventTs: 3 });
  assert.equal(s.calls.alerts.at(-1).type, 'request_status_alert');
});

test('concurrency: near the limit sheds noncritical starts, limited blocks all, a stop frees capacity', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started(), { eventTs: 1 });
  await s.send('rtms.concurrency_near_limit', { account_id: 'A1', concurrency_number: 95, concurrency_limit: 100 }, { eventTs: 2 });
  assert.equal(s.service.startsAllowed().reason, 'concurrency_near_limit_shedding');
  assert.equal(s.service.startsAllowed({ critical: true }).allowed, true);
  await s.send('rtms.concurrency_limited', { account_id: 'A1', concurrency_number: 100, concurrency_limit: 100 }, { eventTs: 3 });
  const blocked = s.service.startsAllowed({ critical: true });
  assert.deepEqual([blocked.allowed, blocked.reason], [false, 'concurrency_limited']);
  assert.ok(blocked.retryAfterMs > 0);
  assert.deepEqual(s.trace.events.at(-1), { ...s.trace.events.at(-1), type: 'concurrency', level: 'limited', number: 100, limit: 100 });
  await s.send('meeting.rtms_stopped', { account_id: 'A1', meeting_uuid: 'M1', rtms_stream_id: 'S1', stop_reason: 6 }, { eventTs: 4 });
  assert.equal(s.service.startsAllowed({ critical: true }).allowed, true);
  assert.equal(s.service.startsAllowed().reason, 'concurrency_near_limit_shedding', 'one slot freed at the limit is near the limit, not open');
  s.clock.advance(5 * 60_000 + 1);
  assert.equal(s.service.startsAllowed().allowed, true, 'shedding expires without a fresh near-limit event');
});

test('REST start keeps an audit snapshot and waits for the webhook; the watchdog explains silence', async () => {
  const s = setup();
  const r = await s.service.requestStart({ meetingId: '123', participantUserId: 'u1', accountId: 'A1', policy: { participantPermission: 'always_ask' } });
  assert.equal(r.started, true);
  const attempt = s.trace.events.find((e) => e.type === 'start_attempt');
  assert.deepEqual([attempt.result, attempt.dryRun, attempt.outcome], ['accepted', true, 'accepted']);
  assert.deepEqual([attempt.audit.tenantId, attempt.audit.consentRef, attempt.audit.targetUser, attempt.audit.policySnapshot.participantPermission], ['acme', 'consent-1', 'u1', 'always_ask']);
  assert.equal(attempt.audit.appClientId, 'cid');
  assert.equal((await s.service.requestStart({ meetingId: '123', accountId: 'A1' })).reason, 'already_pending');
  s.timers[0].fn();
  const fired = s.trace.events.find((e) => e.type === 'start_watchdog_fired');
  assert.equal(fired.meetingId, '123');
  assert.ok(fired.auditOrder.includes('invite-list membership'));
  assert.equal(s.calls.alerts.at(-1).type, 'started_webhook_missing');
  assert.equal(s.service.snapshot().pendingStarts.length, 0);
});

test('the watchdog is cancelled by the started webhook or a matching request_status', async () => {
  const a = setup();
  await a.service.requestStart({ meetingId: '123', accountId: 'A1' });
  await a.send('meeting.rtms_started', started(), { eventTs: 1 });
  assert.equal(a.timers[0].cancelled, true);

  const b = setup();
  await b.service.requestStart({ meetingId: '777', participantUserId: 'u9', accountId: 'A1' });
  await b.send('rtms.request_status', { status: 3, operator_id: 'u9' }, { eventTs: 1 });
  assert.equal(b.timers[0].cancelled, true);
  assert.equal(b.service.snapshot().pendingStarts.length, 0);

  const c = setup();
  await c.service.requestStart({ meetingId: '888', accountId: 'A1' });
  await c.send('rtms.request_status', { status: 2, operator_id: 'someone-else' }, { eventTs: 1 });
  assert.equal(c.timers[0].cancelled, false, 'cannot correlate, so keep waiting');
  c.timers[0].fn();
  assert.deepEqual(c.trace.events.find((e) => e.type === 'start_watchdog_fired').unmatchedRequestStatus, [2]);
});

test('REST outcomes decide retry behavior, and a refused tenant never reaches Zoom', async () => {
  const responses = [
    { status: 400, body: { code: 13267, message: 'disabled' } },
    { status: 400, body: { code: 3000, message: 'not started' } },
    { status: 429, body: {} },
    { status: 204, body: null }
  ];
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const next = responses.shift();
    return { status: next.status, text: async () => (next.body ? JSON.stringify(next.body) : ''), headers: new Map([['retry-after', '7']]) };
  };
  const s = setup({ rest: createRestClient({ accessToken: 'tok', clientId: 'cid', fetchImpl }) });
  const a = await s.service.requestStart({ meetingId: '1', accountId: 'A1' });
  assert.deepEqual([a.started, a.outcome.name, a.outcome.retry], [false, 'rtms_app_disabled', 'after_fix']);
  assert.equal((await s.service.requestStart({ meetingId: '2', accountId: 'A1' })).outcome.retry, 'later');
  const rl = await s.service.requestStart({ meetingId: '3', accountId: 'A1' });
  assert.deepEqual([rl.outcome.retry, rl.outcome.retryAfterSeconds], ['backoff', 7]);
  assert.equal((await s.service.requestStart({ meetingId: '4', accountId: 'A1' })).started, true);
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen[0].init.body), { action: 'start', settings: { client_id: 'cid' } });
  assert.equal((await s.service.requestStart({ meetingId: '5', accountId: 'nobody' })).reason, 'unknown_account');
  assert.equal(seen.length, 4, 'the refused request made no call');
});

test('REST client: dry run without a token, double-encoded UUIDs, network errors', async () => {
  assert.equal(encodeMeetingId('abc=='), 'abc%3D%3D');
  assert.equal(encodeMeetingId('/abc//def=='), encodeURIComponent(encodeURIComponent('/abc//def==')));
  const dry = await createRestClient({ clientId: 'c' }).start('1', { participantUserId: 'u' });
  assert.deepEqual([dry.dryRun, dry.request.method, dry.request.body.settings.participant_user_id], [true, 'PATCH', 'u']);
  assert.equal(dry.outcome.waitForWebhook, true);
  const failing = await createRestClient({ accessToken: 't', fetchImpl: async () => { throw Object.assign(new Error('boom'), { code: 'ECONNRESET' }); } }).stop('1');
  assert.deepEqual([failing.outcome.name, failing.outcome.retry, failing.outcome.waitForWebhook], ['network_error', 'backoff', false]);
});

test('requestStop is recorded', async () => {
  const s = setup();
  const outcome = await s.service.requestStop('123');
  assert.equal(outcome.waitForWebhook, true);
  assert.equal(s.trace.events.at(-1).type, 'stop_requested');
});

test('a failed hand-off abandons the claim so a later webhook can start the stream', async () => {
  let attempts = 0;
  const s = setup();
  const failing = createStartService({
    secret: SECRET, workerId: 'w1', trace: s.trace, claims: s.claims, gate: createTenantGate([TENANT]), rest: createRestClient({}), now: s.clock.now,
    onStreamReady: () => { attempts += 1; if (attempts === 1) throw new Error('queue unavailable'); },
    onAlert: (a) => s.calls.alerts.push(a)
  });
  const send = async (eventTs) => {
    const rawBody = Buffer.from(JSON.stringify({ event: 'meeting.rtms_started', event_ts: eventTs, payload: started() }));
    await failing.handleWebhook({ headers: signWebhook(rawBody, SECRET, Math.floor(s.clock.now() / 1000)), rawBody }).done;
  };
  await send(1);
  assert.ok(s.types().includes('stream_start_failed'));
  assert.equal(s.calls.alerts.at(-1).type, 'stream_start_failed');
  assert.equal(failing.snapshot().active.length, 0, 'nothing for the heartbeat to keep alive');
  assert.equal(s.claims.size(), 0, 'no tombstone: the stream never ran');
  await send(2);
  assert.equal(attempts, 2);
  assert.equal(failing.snapshot().active.length, 1);
});

test('releaseStream ends lease renewal and blocks a late duplicate', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started(), { eventTs: 1 });
  assert.deepEqual(s.service.releaseStream('S1', 'client_gave_up'), { released: true });
  assert.deepEqual(s.service.releaseStream('S1'), { released: false });
  assert.equal(s.service.snapshot().active.length, 0);
  assert.equal(s.trace.events.at(-1).type, 'stream_released');
  await s.send('meeting.rtms_started', started(), { eventTs: 2 });
  assert.equal(s.trace.events.at(-1).type, 'late_duplicate_dropped');
});

test('two users in one meeting: the first stream wins, the second is declined, a restart by the same user is not', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S1', operator_id: 'alice' }), { eventTs: 1 });
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S2', operator_id: 'bob' }), { eventTs: 2 });

  assert.deepEqual(s.calls.ready.map((r) => r.streamId), ['S1']);
  assert.equal(s.calls.declined.length, 1);
  const d = s.calls.declined[0];
  assert.deepEqual([d.reason, d.stream.streamId, d.stream.operatorId, d.stream.meetingNumericId, d.heldByStreamId], ['duplicate_meeting_stream', 'S2', 'bob', '123', 'S1']);
  const refused = s.trace.events.find((e) => e.type === 'stream_refused');
  assert.deepEqual([refused.reason, refused.heldByOperatorId], ['duplicate_meeting_stream', 'alice']);
  assert.equal(s.claims.size(), 1, 'the declined stream never took a claim');

  // The same user starting again (a restart) is not a rival, even while the old claim is still held.
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S3', operator_id: 'alice' }), { eventTs: 3 });
  assert.deepEqual(s.calls.ready.map((r) => r.streamId), ['S1', 'S3']);

  // A different meeting is unaffected.
  await s.send('meeting.rtms_started', started({ meeting_uuid: 'M2', rtms_stream_id: 'S9', operator_id: 'bob' }), { eventTs: 4 });
  assert.equal(s.calls.ready.length, 3);
});

test('two users in one meeting: once the first stream ends, the second may start', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S1', operator_id: 'alice' }), { eventTs: 1 });
  s.service.releaseStream('S1');
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S2', operator_id: 'bob' }), { eventTs: 2 });
  assert.deepEqual(s.calls.ready.map((r) => r.streamId), ['S1', 'S2']);
  assert.equal(s.calls.declined.length, 0);
});

test('two webhooks for one meeting arriving together still open only one stream', async () => {
  const s = setup();
  const raw = (extra, ts) => Buffer.from(JSON.stringify({ event: 'meeting.rtms_started', event_ts: ts, payload: started(extra) }));
  const sign = (b) => signWebhook(b, SECRET, Math.floor(s.clock.now() / 1000));
  const a = raw({ rtms_stream_id: 'S1', operator_id: 'alice' }, 1);
  const b = raw({ rtms_stream_id: 'S2', operator_id: 'bob' }, 2);
  const first = s.service.handleWebhook({ headers: sign(a), rawBody: a });
  const second = s.service.handleWebhook({ headers: sign(b), rawBody: b });
  await Promise.all([first.done, second.done]);
  assert.equal(s.calls.ready.length, 1);
  assert.equal(s.calls.declined.length, 1);
});

test('keep_both opens every stream, and an unknown policy is rejected at start up', async () => {
  const s = setup({ serviceOptions: { meetingPolicy: 'keep_both' } });
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S1', operator_id: 'alice' }), { eventTs: 1 });
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S2', operator_id: 'bob' }), { eventTs: 2 });
  assert.equal(s.calls.ready.length, 2);
  assert.throws(() => setup({ serviceOptions: { meetingPolicy: 'owner_wins' } }), /meetingPolicy must be/);
});

test('without an operator ID the service cannot tell users apart, so it does not refuse', async () => {
  const s = setup();
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S1', operator_id: undefined }), { eventTs: 1 });
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S2', operator_id: 'bob' }), { eventTs: 2 });
  assert.equal(s.calls.ready.length, 2);
});

test('capture filter: declined meetings never claim, accepted ones proceed, a broken filter fails open', async () => {
  const seen = [];
  const s = setup({ serviceOptions: { captureFilter: (m) => { seen.push(m); return m.meetingId === 'M-small' ? { capture: false, reason: 'fewer_than_3_attendees' } : true; } } });
  await s.send('meeting.rtms_started', started({ meeting_uuid: 'M-small', rtms_stream_id: 'S1' }), { eventTs: 1 });
  await s.send('meeting.rtms_started', started({ meeting_uuid: 'M-big', rtms_stream_id: 'S2' }), { eventTs: 2 });
  assert.deepEqual(s.calls.ready.map((r) => r.streamId), ['S2']);
  const d = s.calls.declined[0];
  assert.deepEqual([d.reason, d.filterReason, d.stream.operatorId], ['filtered_out', 'fewer_than_3_attendees', 'u1']);
  assert.equal(seen[0].operatorId, 'u1');
  assert.equal(seen[0].tenantId, 'acme');
  assert.equal(s.claims.size(), 1);

  const broken = setup({ serviceOptions: { captureFilter: () => { throw new Error('filter bug'); } } });
  await broken.send('meeting.rtms_started', started(), { eventTs: 1 });
  assert.equal(broken.calls.ready.length, 1, 'a bug in the filter must not silently drop a meeting');
  assert.ok(broken.types().includes('capture_filter_failed'));
  assert.equal(broken.calls.alerts.at(-1).type, 'capture_filter_failed');
});

test('capture filter: a refresh for a live stream is never re-judged or stopped', async () => {
  let calls = 0;
  const s = setup({ serviceOptions: { captureFilter: () => { calls += 1; return calls === 1; } } });
  await s.send('meeting.rtms_started', started(), { eventTs: 1 });
  await s.send('meeting.rtms_started', started({ server_urls: { audio: 'wss://new/audio' } }), { eventTs: 2 });
  assert.equal(s.calls.ready.length, 1);
  assert.equal(s.calls.refresh.length, 1);
  assert.equal(s.calls.declined.length, 0);
  assert.equal(calls, 1);
});

test('a throwing decline hook is traced and does not break the next webhook', async () => {
  const s = setup({ serviceOptions: { onStreamDeclined: () => { throw new Error('hook bug'); } } });
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S1', operator_id: 'alice' }), { eventTs: 1 });
  await s.send('meeting.rtms_started', started({ rtms_stream_id: 'S2', operator_id: 'bob' }), { eventTs: 2 });
  assert.ok(s.types().includes('decline_hook_failed'));
  await s.send('meeting.rtms_started', started({ meeting_uuid: 'M3', rtms_stream_id: 'S3' }), { eventTs: 3 });
  assert.equal(s.calls.ready.length, 2);
});

test('pause and resume go through the same endpoint and are recorded', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { status: 204, text: async () => '', headers: new Map() }; };
  const s = setup({ rest: createRestClient({ accessToken: 'tok', clientId: 'cid', fetchImpl }) });
  assert.equal((await s.service.requestControl('pause', '123', { participantUserId: 'u1' })).name, 'accepted');
  await s.service.requestControl('resume', '123');
  assert.deepEqual(sent.map((x) => x.body.action), ['pause', 'resume']);
  assert.equal(sent[0].body.settings.participant_user_id, 'u1');
  assert.equal(s.trace.events.filter((e) => e.type === 'control_requested').length, 2);
  await assert.rejects(() => s.service.requestControl('start', '123'), /pause or resume/);
});

test('REST client with a per-user token provider: the right token, one refresh on 401, then a clear reauthorization answer', async () => {
  const seen = [];
  let rejectAlways = false;
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.authorization);
    const unauthorized = rejectAlways || seen.length === 1;
    return { status: unauthorized ? 401 : 204, text: async () => (unauthorized ? '{"code":124,"message":"Invalid access token."}' : ''), headers: new Map() };
  };
  const tokens = { alice: 'alice-old' };
  const events = [];
  const rest = createRestClient({
    clientId: 'cid', fetchImpl,
    tokenProvider: async (userId) => (tokens[userId] ? { ok: true, accessToken: tokens[userId] } : { ok: false, reason: 'unknown_user' }),
    onUnauthorized: async (userId) => { events.push(`expire:${userId}`); tokens[userId] = 'alice-new'; },
    onReauthorizationNeeded: async (userId, reason) => events.push(`reauth:${userId}:${reason}`)
  });

  const ok = await rest.start('123', { participantUserId: 'alice' });
  assert.equal(ok.outcome.name, 'accepted');
  assert.deepEqual(seen, ['Bearer alice-old', 'Bearer alice-new'], 'one retry with the refreshed token');
  assert.deepEqual(events, ['expire:alice']);

  const stranger = await rest.start('123', { participantUserId: 'carol' });
  assert.equal(stranger.outcome.name, 'no_token_for_user');
  assert.equal(seen.length, 2, 'no request is sent for a user without a token');

  rejectAlways = true;
  const rejected = await rest.stop('123', { participantUserId: 'alice' });
  assert.equal(rejected.outcome.name, 'token_invalid');
  assert.ok(events.includes('reauth:alice:rest_401'));
});

test('REST client: a user flagged for reauthorization gets an explicit outcome and no network call', async () => {
  let called = 0;
  const rest = createRestClient({
    clientId: 'cid', fetchImpl: async () => { called += 1; return { status: 204, text: async () => '', headers: new Map() }; },
    tokenProvider: async () => ({ ok: false, reason: 'reauthorization_required', detail: 'missing_scope:x' })
  });
  const r = await rest.start('123', { participantUserId: 'alice' });
  assert.deepEqual([r.outcome.name, r.outcome.message, called], ['reauthorization_required', 'missing_scope:x', 0]);
});
