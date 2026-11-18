/**
 * Walk through the whole "start and approval" story with no network and no credentials.
 * Zoom is simulated: webhooks are signed with a throwaway secret and the REST API is dry-run.
 *   node demo.js                 prints the story
 *   node demo.js --write-trace   also appends the events to TRACE_FILE for the reporting dashboard
 */
import { createClaimRegistry } from '../shared/claims.js';
import { createMemoryTrace, createTrace } from '../shared/trace.js';
import { createTenantGate } from '../shared/tenantGate.js';
import { signWebhook } from '../shared/webhookSignature.js';
import { createRestClient } from './src/restClient.js';
import { createStartService } from './src/service.js';

const SECRET = 'demo-secret-token';
const writeTrace = process.argv.includes('--write-trace');
const trace = writeTrace ? createTrace(process.env.TRACE_FILE || '.data/events.jsonl') : createMemoryTrace();
const claims = createClaimRegistry({ leaseMs: 45_000 });
const gate = createTenantGate([{ tenantId: 'acme', accountIds: ['acct-acme'], products: ['meeting'], media: ['audio', 'transcript'], consentRef: 'consent-acme-1', policyVersion: 'policy-7' }]);

const timers = [];
const alerts = [];
const service = createStartService({
  secret: SECRET, clientId: 'demo-client', workerId: 'worker-a', trace, claims, gate, rest: createRestClient({ clientId: 'demo-client' }),
  watchdogMs: 60_000, setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cancelled = true; },
  onStreamReady: (s) => console.log(`        -> stream ready for the lifecycle client: ${s.streamId} (generation ${s.generation})`),
  onAlert: (a) => alerts.push(a)
});

const send = async (label, event, payload, opts = {}) => {
  const body = JSON.stringify({ event, event_ts: opts.eventTs ?? Date.now(), payload });
  const rawBody = Buffer.from(body);
  const headers = opts.unsigned ? {} : signWebhook(rawBody, opts.secret || SECRET, opts.timestamp);
  const result = service.handleWebhook({ headers: { ...headers, 'x-zm-request-id': opts.requestId }, rawBody });
  await result.done;
  const last = trace.read().events.at(-1);
  console.log(`  ${label}\n        HTTP ${result.status}  trace: ${last ? last.type : '-'}${last?.reason ? ` (${last.reason})` : ''}`);
};

const started = (extra = {}) => ({ account_id: 'acct-acme', meeting_uuid: 'uuid-1', meeting_id: '8675309', rtms_stream_id: 'stream-1', operator_id: 'u-ana', server_urls: { signaling: 'wss://example.invalid/signaling' }, ...extra });

console.log('1. Webhook safety');
await send('unsigned request', 'meeting.rtms_started', started(), { unsigned: true });
await send('wrong secret', 'meeting.rtms_started', started(), { secret: 'not-the-secret' });
await send('signed 20 minutes ago', 'meeting.rtms_started', started(), { timestamp: Math.floor(Date.now() / 1000) - 1200 });

console.log('\n2. Deliberate start with a REST call (dry run) and a watchdog');
const attempt = await service.requestStart({ meetingId: '8675309', participantUserId: 'u-ana', accountId: 'acct-acme', policy: { participantPermission: 'always_ask' } });
console.log(`  start requested: accepted=${attempt.started}, now waiting for the webhook (watchdog ${attempt.waitingForWebhookMs} ms)`);
await send('host denied the request', 'rtms.request_status', { status: 3, operator_id: 'u-ana', meeting_id: '8675309' });
console.log(`        watchdog still pending? ${service.snapshot().pendingStarts.length ? 'yes' : 'no, request_status explained the outcome'}`);

console.log('\n3. A start whose started webhook never arrives');
await service.requestStart({ meetingId: '5550100', accountId: 'acct-acme' });
timers.filter((t) => !t.cancelled).forEach((t) => t.fn());
console.log(`        last alert: ${alerts.at(-1).type} for ${alerts.at(-1).meetingId}`);

console.log('\n4. The stream starts');
await send('first started webhook', 'meeting.rtms_started', started(), { eventTs: 100 });
await send('Zoom retries it (identical body, only the first attempt counts)', 'meeting.rtms_started', started(), { eventTs: 100 });
await send('new started webhook for the same live stream (no second connection)', 'meeting.rtms_started', started(), { eventTs: 101 });
const other = createStartService({ secret: SECRET, workerId: 'worker-b', trace, claims, gate, rest: createRestClient({}), onStreamReady: () => console.log('        !! worker-b opened a second connection (this must never print)') });
const raw = Buffer.from(JSON.stringify({ event: 'meeting.rtms_started', event_ts: 3, payload: started() }));
await other.handleWebhook({ headers: signWebhook(raw, SECRET), rawBody: raw }).done;
console.log(`  second worker sees the same stream\n        trace: ${trace.read().events.at(-1).type}`);

console.log('\n5. Capacity');
await send('near the concurrency limit', 'rtms.concurrency_near_limit', { account_id: 'acct-acme', concurrency_number: 95, concurrency_limit: 100 });
console.log(`        noncritical start: ${JSON.stringify(service.startsAllowed())}`);
console.log(`        critical start:    ${JSON.stringify(service.startsAllowed({ critical: true }))}`);
await send('limit reached', 'rtms.concurrency_limited', { account_id: 'acct-acme', concurrency_number: 100, concurrency_limit: 100 });
console.log(`        any start:         ${JSON.stringify(service.startsAllowed({ critical: true }))}`);

console.log('\n6. The stream ends');
await send('stopped: meeting ended (reason 6)', 'meeting.rtms_stopped', { account_id: 'acct-acme', meeting_uuid: 'uuid-1', rtms_stream_id: 'stream-1', stop_reason: 6 });
await send('a late duplicate of the started webhook', 'meeting.rtms_started', started(), { eventTs: 4 });
console.log(`        after the stop: critical ${JSON.stringify(service.startsAllowed({ critical: true }))}, noncritical ${JSON.stringify(service.startsAllowed())}`);

console.log('\nEvents recorded:');
const counts = {};
for (const e of trace.read().events) counts[e.type] = (counts[e.type] || 0) + 1;
for (const [type, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(2)}  ${type}`);
service.cancelTimers();
if (writeTrace) console.log(`\nAppended to ${trace.file}`);
