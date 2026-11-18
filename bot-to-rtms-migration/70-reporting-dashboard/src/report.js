/**
 * Turn the event trace into the numbers a migration needs after go-live.
 *
 * Input is a list of trace events (shared/trace.js). Output is plain data, so the HTML page,
 * the JSON endpoint and the tests all read the same thing. Nothing here touches a database:
 * in production, compute the same panels from your own logging or analytics store.
 */

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(values) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, avg: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length, min: Math.min(...values), p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99),
    max: Math.max(...values), avg: Math.round(sum / values.length)
  };
}

const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };
export const FUNNEL = ['claimed', 'signaling_connected', 'media_connected', 'client_ready_sent', 'streaming', 'finalized'];
export const SPAN_NAMES = ['webhook_to_signaling_connected', 'signaling_ping_rtt', 'signaling_to_media_handshake', 'media_handshake_to_first_packet', 'reconnect'];

export function buildReport(events, { windowMs = null, nowMs = null } = {}) {
  const maxTs = events.reduce((m, e) => Math.max(m, e.tsMs || 0), 0);
  const end = nowMs ?? maxTs;
  const scoped = windowMs ? events.filter((e) => e.tsMs >= end - windowMs) : events;
  const streams = new Map();
  const stream = (id) => {
    if (!id) return null;
    if (!streams.has(id)) streams.set(id, { streamId: id, tenantId: null, meetingId: null, generation: 1, phases: new Set(), startTs: null, endTs: null, stop: null });
    return streams.get(id);
  };

  const r = {
    window: { from: scoped[0]?.tsMs ?? null, to: scoped.at(-1)?.tsMs ?? null, events: scoped.length },
    webhooks: { rejected: {}, duplicates: 0, refused: {}, accepted: 0 },
    duplicates: { webhook: 0, stream: 0, lateStream: 0, refresh: 0, chunks: 0 },
    starts: { attempts: {}, outcomes: {}, requestStatus: {}, watchdogFired: 0 },
    spans: {}, spansByMedia: {},
    recovery: { socketsClosed: 0, socketsRecovered: 0, reconnectFailed: 0, keepAliveSilence: 0, interrupted: 0, paused: 0, resumed: 0, handshakeRetries: 0, handshakeRejected: 0, claimFenced: 0, downMs: [] },
    stops: { byReason: {}, restart: {} },
    concurrency: { latest: null, limit: null, nearEvents: 0, limitedEvents: 0, peak: 0, series: [] },
    usage: {},
    artifacts: [],
    crm: { byStatus: {}, notQueued: [] },
    video: { requests: 0, refused: 0, failed: 0, resubscribes: 0 },
    alerts: []
  };
  for (const name of SPAN_NAMES) r.spans[name] = [];

  const crmLatest = new Map();
  for (const e of scoped) {
    const s = stream(e.streamId);
    if (s) {
      s.tenantId ??= e.tenantId ?? null;
      s.meetingId ??= e.meetingId ?? null;
    }
    switch (e.type) {
      case 'webhook_rejected': bump(r.webhooks.rejected, e.reason || 'unknown'); break;
      case 'webhook_duplicate': r.duplicates.webhook += 1; break;
      case 'stream_refused': bump(r.webhooks.refused, e.reason || 'unknown'); break;
      case 'duplicate_stream_dropped': r.duplicates.stream += 1; break;
      case 'late_duplicate_dropped': r.duplicates.lateStream += 1; break;
      case 'stream_refresh': r.duplicates.refresh += 1; break;
      case 'stream_claimed':
        r.webhooks.accepted += 1;
        s.phases.add('claimed');
        s.startTs = Math.min(s.startTs ?? Infinity, e.tsMs);
        break;
      case 'stream_phase':
        if (e.phase === 'webhook_received') { s.phases.add('claimed'); s.startTs = Math.min(s.startTs ?? Infinity, e.tsMs); }
        if (FUNNEL.includes(e.phase)) s.phases.add(e.phase);
        break;
      case 'stream_state':
        if (e.state === 'PAUSED') r.recovery.paused += 1;
        if (e.state === 'RESUMED') r.recovery.resumed += 1;
        if (e.state === 'INTERRUPTED') r.recovery.interrupted += 1;
        break;
      case 'stream_stopped':
        if (s) {
          s.stop = s.stop || { name: e.reasonName || 'unknown', restart: e.restart || 'unknown', source: 'webhook' };
          if (e.held !== false) s.endTs = Math.min(s.endTs ?? Infinity, e.tsMs);
          if (e.purge) r.alerts.push({ level: 'critical', at: e.tsMs, text: `Stream ${e.streamId} was revoked: delete its assets and confirm deletion.` });
        }
        break;
      case 'stream_finalized': {
        s.phases.add('finalized');
        s.endTs = Math.min(s.endTs ?? Infinity, e.tsMs);
        s.stop = s.stop || { name: e.stopName || 'unknown', restart: e.restart || 'unknown', source: 'client' };
        s.generation = e.generation ?? s.generation;
        const u = (r.usage[s.tenantId || 'unknown'] ||= { tenantId: s.tenantId || 'unknown', streams: 0, durationMs: 0, packets: 0, bytes: 0, degraded: 0 });
        u.streams += 1; u.durationMs += e.durationMs || 0; u.packets += e.packets || 0; u.bytes += e.bytes || 0; u.degraded += e.degraded ? 1 : 0;
        r.duplicates.chunks += e.duplicatesDropped || 0;
        r.artifacts.push({
          at: e.tsMs, streamId: e.streamId, meetingId: e.meetingId, tenantId: s.tenantId, generation: e.generation ?? 1, schemaVersion: e.schemaVersion ?? null,
          writerVersion: e.artifactWriterVersion ?? null, mediaParamsHash: e.mediaParamsHash ?? null, consentRef: e.consentRef ?? null, policyVersion: e.policyVersion ?? null,
          degraded: Boolean(e.degraded), gaps: e.gaps ?? 0, gapMs: e.gapMs ?? 0, stop: e.stopName ?? null
        });
        break;
      }
      case 'latency_span':
        if (e.span in r.spans) r.spans[e.span].push(e.ms);
        if (e.mediaType) (r.spansByMedia[`${e.span}:${e.mediaType}`] ||= []).push(e.ms);
        break;
      case 'socket_closed': r.recovery.socketsClosed += 1; break;
      case 'socket_recovered': r.recovery.socketsRecovered += 1; r.recovery.downMs.push(e.downMs); break;
      case 'reconnect_failed': r.recovery.reconnectFailed += 1; break;
      case 'keepalive_silence': r.recovery.keepAliveSilence += 1; break;
      case 'stream_interrupted': r.recovery.interrupted += 1; break;
      case 'handshake_retry': r.recovery.handshakeRetries += 1; break;
      case 'handshake_rejected': r.recovery.handshakeRejected += 1; break;
      case 'claim_fenced':
        r.recovery.claimFenced += 1;
        r.alerts.push({ level: 'warning', at: e.tsMs, text: `Stream ${e.streamId} lost its claim to another worker.` });
        break;
      case 'start_attempt':
        bump(r.starts.attempts, e.result || 'unknown');
        if (e.outcome) bump(r.starts.outcomes, e.outcome);
        break;
      case 'request_status': bump(r.starts.requestStatus, e.name || String(e.code)); break;
      case 'start_watchdog_fired':
        r.starts.watchdogFired += 1;
        r.alerts.push({ level: 'warning', at: e.tsMs, text: `No started webhook arrived for meeting ${e.meetingId} after a start request.` });
        break;
      case 'concurrency':
        r.concurrency.latest = { level: e.level, number: e.number ?? null, limit: e.limit ?? null, at: e.tsMs };
        if (e.limit) r.concurrency.limit = e.limit;
        if (e.level === 'near') r.concurrency.nearEvents += 1;
        if (e.level === 'limited') {
          r.concurrency.limitedEvents += 1;
          r.alerts.push({ level: 'critical', at: e.tsMs, text: `Concurrency limit reached (${e.number ?? '?'} of ${e.limit ?? '?'}). New streams are blocked.` });
        }
        break;
      case 'crm_sync':
        crmLatest.set(e.streamId, e.status || 'unknown');
        break;
      case 'video_subscription_refused': r.video.refused += 1; break;
      case 'video_subscription_failed': case 'video_subscription_timeout': r.video.failed += 1; break;
      case 'video_resubscribe': r.video.resubscribes += 1; break;
      case 'video_subscription_changed': r.video.requests += 1; break;
      default: break;
    }
  }

  for (const status of crmLatest.values()) bump(r.crm.byStatus, status);
  r.crm.notQueued = r.artifacts.filter((a) => !crmLatest.has(a.streamId)).map((a) => a.streamId);

  // funnel
  const all = [...streams.values()].filter((s) => s.phases.size > 0);
  const base = all.filter((s) => s.phases.has('claimed')).length;
  r.funnel = FUNNEL.map((stage) => {
    const count = all.filter((s) => s.phases.has(stage)).length;
    return { stage, count, pct: base ? Math.round((count / base) * 1000) / 10 : null };
  });
  r.streams = { total: all.length, tenants: [...new Set(all.map((s) => s.tenantId).filter(Boolean))].length };

  // stops: one reason per stream
  for (const s of all) {
    if (!s.stop) continue;
    bump(r.stops.byReason, s.stop.name);
    bump(r.stops.restart, s.stop.restart);
  }

  // concurrency over time: sweep stream intervals
  const points = [];
  for (const s of all) {
    if (s.startTs === null) continue;
    points.push({ t: s.startTs, d: 1 });
    if (s.endTs !== null) points.push({ t: s.endTs, d: -1 });
  }
  points.sort((a, b) => a.t - b.t || a.d - b.d);
  let level = 0;
  for (const p of points) {
    level += p.d;
    r.concurrency.peak = Math.max(r.concurrency.peak, level);
    r.concurrency.series.push({ t: p.t, level });
  }
  r.concurrency.openNow = all.filter((s) => s.startTs !== null && s.endTs === null).length;
  r.concurrency.utilization = r.concurrency.limit ? Math.round((r.concurrency.peak / r.concurrency.limit) * 1000) / 10 : null;

  // latency summaries
  r.latency = Object.fromEntries(Object.entries(r.spans).map(([k, v]) => [k, summarize(v)]));
  r.latencyByMedia = Object.fromEntries(Object.entries(r.spansByMedia).map(([k, v]) => [k, summarize(v)]));
  r.recovery.downSummary = summarize(r.recovery.downMs);
  delete r.spans; delete r.spansByMedia; delete r.recovery.downMs;

  // artifacts without consent are an audit finding
  for (const a of r.artifacts) {
    if (!a.consentRef) r.alerts.push({ level: 'critical', at: a.at, text: `Artifact for stream ${a.streamId} has no consent reference.` });
  }
  r.alerts.sort((a, b) => b.at - a.at);
  r.usage = Object.values(r.usage).sort((a, b) => b.durationMs - a.durationMs);
  r.artifacts.sort((a, b) => b.at - a.at);
  return r;
}
