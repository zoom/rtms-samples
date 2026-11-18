import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTrace } from '../shared/trace.js';
import { buildReport, percentile, summarize } from './src/report.js';
import { fmtBytes, fmtMs, renderHtml, renderText } from './src/render.js';
import { generateSampleEvents } from './sample-data/generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ev = (tsMs, type, fields = {}) => ({ v: 1, ts: new Date(tsMs).toISOString(), tsMs, type, ...fields });

test('percentiles use nearest rank and handle empty and single values', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 99), 7);
  const v = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual([percentile(v, 50), percentile(v, 95), percentile(v, 99), percentile(v, 100)], [50, 95, 99, 100]);
  assert.deepEqual(summarize([10, 20, 30, 40]), { count: 4, min: 10, p50: 20, p95: 40, p99: 40, max: 40, avg: 25 });
  assert.equal(summarize([]).count, 0);
});

test('funnel, concurrency sweep and stop reasons are derived per stream', () => {
  const events = [
    ev(1000, 'stream_claimed', { streamId: 'a', tenantId: 't1', meetingId: 'm1' }),
    ev(1000, 'stream_phase', { streamId: 'a', phase: 'webhook_received' }),
    ev(1100, 'stream_phase', { streamId: 'a', phase: 'signaling_connected' }),
    ev(1200, 'stream_phase', { streamId: 'a', phase: 'media_connected' }),
    ev(1300, 'stream_phase', { streamId: 'a', phase: 'streaming' }),
    ev(1500, 'stream_claimed', { streamId: 'b', tenantId: 't1', meetingId: 'm2' }),
    ev(1600, 'stream_phase', { streamId: 'b', phase: 'signaling_connected' }),
    ev(1700, 'concurrency', { level: 'near', number: 2, limit: 3 }),
    ev(2000, 'stream_stopped', { streamId: 'a', held: true, reasonName: 'meeting_ended', restart: 'none' }),
    ev(2010, 'stream_finalized', { streamId: 'a', tenantId: 't1', stopName: 'meeting_ended', restart: 'none', durationMs: 1000, packets: 10, bytes: 2048, degraded: false, consentRef: 'c1', generation: 1 }),
    ev(2500, 'stream_finalized', { streamId: 'b', tenantId: 't1', stopName: 'await_reconnection_timeout', restart: 'policy', durationMs: 1000, packets: 5, bytes: 1024, degraded: true, consentRef: 'c1', generation: 1, gaps: 1, gapMs: 400 })
  ];
  const r = buildReport(events);
  assert.deepEqual(r.funnel.map((f) => f.count), [2, 2, 1, 0, 1, 2]);
  assert.equal(r.funnel[2].pct, 50);
  assert.deepEqual([r.concurrency.peak, r.concurrency.limit, r.concurrency.utilization, r.concurrency.openNow], [2, 3, 66.7, 0]);
  assert.deepEqual(r.stops.byReason, { meeting_ended: 1, await_reconnection_timeout: 1 }, 'one reason per stream, webhook view wins over client view');
  assert.deepEqual(r.usage[0], { tenantId: 't1', streams: 2, durationMs: 2000, packets: 15, bytes: 3072, degraded: 1 });
  assert.equal(r.artifacts.length, 2);
  assert.equal(r.artifacts.find((a) => a.streamId === 'b').gaps, 1);
});

test('open streams count as concurrent, and a window filters old events', () => {
  const events = [
    ev(1_000, 'stream_claimed', { streamId: 'old', tenantId: 't' }),
    ev(2_000, 'stream_finalized', { streamId: 'old', tenantId: 't', stopName: 'meeting_ended', durationMs: 1000 }),
    ev(100_000, 'stream_claimed', { streamId: 'live', tenantId: 't' })
  ];
  const all = buildReport(events);
  assert.equal(all.concurrency.openNow, 1);
  const recent = buildReport(events, { windowMs: 10_000 });
  assert.equal(recent.streams.total, 1);
  assert.equal(recent.window.events, 1);
});

test('latency summaries, per-media first packet and recovery numbers', () => {
  const events = [
    ev(1, 'latency_span', { streamId: 's', span: 'media_handshake_to_first_packet', ms: 100, mediaType: 'audio' }),
    ev(2, 'latency_span', { streamId: 's', span: 'media_handshake_to_first_packet', ms: 300, mediaType: 'audio' }),
    ev(3, 'latency_span', { streamId: 's', span: 'media_handshake_to_first_packet', ms: 900, mediaType: 'transcript' }),
    ev(4, 'latency_span', { streamId: 's', span: 'signaling_ping_rtt', ms: 42 }),
    ev(5, 'latency_span', { streamId: 's', span: 'made_up_span', ms: 1 }),
    ev(6, 'socket_closed', { streamId: 's' }), ev(7, 'socket_recovered', { streamId: 's', downMs: 1500 }), ev(8, 'reconnect_failed', { streamId: 's' }),
    ev(9, 'stream_state', { streamId: 's', state: 'PAUSED' }), ev(10, 'stream_state', { streamId: 's', state: 'RESUMED' }), ev(11, 'keepalive_silence', { streamId: 's' })
  ];
  const r = buildReport(events);
  assert.equal(r.latency.media_handshake_to_first_packet.count, 3);
  assert.equal(r.latency.media_handshake_to_first_packet.p50, 300);
  assert.equal(r.latency.signaling_ping_rtt.p99, 42);
  assert.equal(r.latencyByMedia['media_handshake_to_first_packet:audio'].max, 300);
  assert.equal(r.latency.made_up_span, undefined, 'unknown spans are not invented into panels');
  assert.deepEqual([r.recovery.socketsClosed, r.recovery.socketsRecovered, r.recovery.reconnectFailed, r.recovery.paused, r.recovery.resumed, r.recovery.keepAliveSilence], [1, 1, 1, 1, 1, 1]);
  assert.equal(r.recovery.downSummary.p50, 1500);
});

test('duplicates, rejected webhooks, start requests, CRM and alerts', () => {
  const events = [
    ev(1, 'webhook_rejected', { reason: 'invalid_x_zm_signature' }), ev(2, 'webhook_rejected', { reason: 'invalid_x_zm_signature' }),
    ev(3, 'webhook_duplicate'), ev(4, 'duplicate_stream_dropped'), ev(5, 'late_duplicate_dropped'), ev(6, 'stream_refresh'),
    ev(7, 'stream_refused', { reason: 'unknown_account' }),
    ev(8, 'start_attempt', { result: 'accepted', outcome: 'accepted' }), ev(9, 'start_attempt', { result: 'rejected', outcome: 'rtms_app_disabled' }),
    ev(10, 'request_status', { code: 3, name: 'host_denied_app' }), ev(11, 'start_watchdog_fired', { meetingId: 'm9' }),
    ev(12, 'concurrency', { level: 'limited', number: 10, limit: 10 }), ev(13, 'claim_fenced', { streamId: 'x' }),
    ev(14, 'stream_stopped', { streamId: 'rev', held: true, reasonName: 'stream_revoked', restart: 'never', purge: true }),
    ev(15, 'stream_finalized', { streamId: 'f1', tenantId: 't', stopName: 'meeting_ended', durationMs: 1, consentRef: null }),
    ev(16, 'stream_finalized', { streamId: 'f2', tenantId: 't', stopName: 'meeting_ended', durationMs: 1, consentRef: 'ok' }),
    ev(17, 'crm_sync', { streamId: 'f2', status: 'pending' }), ev(18, 'crm_sync', { streamId: 'f2', status: 'synced' })
  ];
  const r = buildReport(events);
  assert.deepEqual(r.webhooks.rejected, { invalid_x_zm_signature: 2 });
  assert.deepEqual([r.duplicates.webhook, r.duplicates.stream, r.duplicates.lateStream, r.duplicates.refresh], [1, 1, 1, 1]);
  assert.deepEqual(r.starts.attempts, { accepted: 1, rejected: 1 });
  assert.deepEqual([r.starts.watchdogFired, r.starts.requestStatus.host_denied_app], [1, 1]);
  assert.deepEqual(r.crm.byStatus, { synced: 1 }, 'the latest CRM status per stream wins');
  assert.deepEqual(r.crm.notQueued, ['f1']);
  const text = r.alerts.map((a) => a.text).join('\n');
  for (const needle of ['revoked', 'consent reference', 'Concurrency limit reached', 'lost its claim', 'No started webhook']) assert.ok(text.includes(needle), needle);
  assert.ok(r.alerts.some((a) => a.level === 'critical'));
});

test('the HTML page escapes event data and stays a single static file', () => {
  const r = buildReport([ev(1, 'webhook_rejected', { reason: '<script>alert(1)</script>' }), ev(2, 'stream_finalized', { streamId: '"><img src=x>', tenantId: '<b>t</b>', stopName: 'meeting_ended', durationMs: 1, consentRef: '</code><script>x</script>' })]);
  const html = renderHtml(r, { title: '<x>', source: '"quoted"' });
  assert.ok(!html.includes('<script'), 'no script tag at all');
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(!/(src|href)=["']https?:/.test(html), 'no external assets');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html, /<title>&lt;x&gt;<\/title>/);
  assert.ok(renderText(r).includes('Streams 1'));
  assert.equal(fmtMs(1500), '1.50 s');
  assert.equal(fmtMs(90_000), '1.5 min');
  assert.equal(fmtBytes(2_500_000), '2.5 MB');
});

test('an empty trace still renders', () => {
  const html = renderHtml(buildReport([]));
  assert.ok(html.includes('No events.'));
  assert.ok(html.includes('Not enough stream activity'));
});

test('sample data is deterministic, covers every panel and matches the committed file', () => {
  const a = generateSampleEvents();
  assert.deepEqual(a, generateSampleEvents());
  assert.notDeepEqual(a, generateSampleEvents({ seed: 3 }));
  const r = buildReport(a);
  assert.ok(r.streams.total >= 20 && r.streams.tenants === 3);
  assert.ok(r.concurrency.limit && r.concurrency.peak <= r.concurrency.limit);
  assert.ok(Object.keys(r.stops.byReason).length >= 5);
  assert.ok(r.artifacts.some((x) => !x.consentRef), 'one deliberate audit finding');
  assert.ok(Object.keys(r.crm.byStatus).length >= 2 && r.duplicates.chunks > 0 && r.recovery.socketsClosed > 0);
  assert.ok(Object.values(r.latency).every((s) => s.count > 0));
  const file = readTrace(path.join(here, 'sample-data', 'events.sample.jsonl'));
  assert.equal(file.malformed, 0);
  assert.deepEqual(file.events, generateSampleEvents({ streams: 6 }));
  assert.ok(buildReport(file.events).streams.total === 6);
});

test('every event type the dashboard reads is written by a real source file', () => {
  // The dashboard and the samples that write the trace only agree through event names. If a writer
  // renames an event, a panel silently goes empty. This fails instead.
  const root = path.resolve(here, '../..');
  const sources = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.data') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js') && !name.endsWith('.test.js')) sources.push(full);
    }
  })(root);
  const writers = sources.filter((f) => !f.includes(`${path.sep}70-reporting-dashboard${path.sep}`));
  const text = writers.map((f) => readFileSync(f, 'utf8')).join('\n');

  const reportSource = readFileSync(path.join(here, 'src', 'report.js'), 'utf8');
  const consumed = [...reportSource.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]).filter((t) => !['PAUSED', 'RESUMED', 'INTERRUPTED'].includes(t));
  assert.ok(consumed.length >= 25, `expected the report to read many event types, found ${consumed.length}`);
  const writtenByCustomer = new Set(['crm_sync']); // your pipeline writes this one, see the readme
  const missing = consumed.filter((type) => !writtenByCustomer.has(type) && !text.includes(`'${type}'`));
  assert.deepEqual(missing, [], `no source file writes: ${missing.join(', ')}`);
});
