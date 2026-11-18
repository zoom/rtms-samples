/**
 * Deterministic sample trace, shaped exactly like the real samples write it.
 * The same seed always gives the same events, so the dashboard looks the same on every machine.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SAMPLE_BASE_MS = Date.UTC(2026, 10, 5, 0, 0, 0);
const TENANTS = [
  { id: 'acme', account: 'acct-acme', consentRef: 'consent-acme-2026-10', policyVersion: 'policy-7' },
  { id: 'globex', account: 'acct-globex', consentRef: 'consent-globex-2026-09', policyVersion: 'policy-2' },
  { id: 'initech', account: 'acct-initech', consentRef: 'consent-initech-2026-08', policyVersion: 'policy-1' }
];
const STOPS = [
  [6, 'meeting_ended', 'none', 58], [1, 'host_triggered', 'policy', 10], [2, 'user_triggered', 'policy', 10], [3, 'user_left', 'policy', 6],
  [5, 'host_disabled_app', 'wait_for_host', 4], [10, 'internal_exception', 'backoff', 4], [19, 'await_reconnection_timeout', 'policy', 4], [4, 'user_ejected', 'never', 4]
];

export function generateSampleEvents({ seed = 20, streams = 24, hours = 4, limit = null } = {}) {
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const weighted = (rows) => {
    const total = rows.reduce((s, r) => s + r[3], 0);
    let x = rnd() * total;
    for (const row of rows) { x -= row[3]; if (x <= 0) return row; }
    return rows[0];
  };
  const out = [];
  const intervals = [];
  const add = (tsMs, type, fields = {}) => out.push({ v: 1, ts: new Date(tsMs).toISOString(), tsMs, type, ...fields });

  for (let i = 0; i < streams; i += 1) {
    // Stream 2 is one deliberate audit finding: an artifact whose consent reference was never recorded.
    const tenant = i === 2 ? { ...TENANTS[2], consentRef: null } : TENANTS[i % TENANTS.length];
    const streamId = `rtms-${String(1000 + i)}`;
    const meetingId = `meeting-${String(500 + Math.floor(i / 1.3))}`;
    const generation = i > 0 && meetingId === `meeting-${String(500 + Math.floor((i - 1) / 1.3))}` ? 2 : 1;
    const t0 = SAMPLE_BASE_MS + Math.floor((i / streams) * hours * 3_600_000) + between(0, 60_000);
    const durationMs = between(8, 70) * 60_000;
    let t = t0;

    if (rnd() < 0.35) {
      add(t - 3000, 'start_attempt', { meetingId, result: 'accepted', dryRun: false, outcome: 'accepted', httpStatus: 204, code: 204, retry: 'never' });
    } else if (rnd() < 0.08) {
      add(t - 3000, 'start_attempt', { meetingId, result: 'rejected', outcome: pick(['rtms_app_disabled', 'meeting_not_started', 'rate_limited']), retry: 'after_fix' });
    }
    if (rnd() < 0.1) add(t - 2500, 'request_status', { code: pick([1, 3, 2]), name: pick(['request_denied', 'host_denied_app', 'app_owner_not_present']), known: true });
    if (rnd() < 0.2) {
      add(t - 100, 'webhook_duplicate', { event: 'meeting.rtms_started' });
    }
    add(t, 'stream_claimed', { tenantId: tenant.id, product: 'meeting', meetingId, streamId, claim: 'claimed', generation, consentRef: tenant.consentRef, policyVersion: tenant.policyVersion });
    add(t, 'stream_phase', { streamId, meetingId, tenantId: tenant.id, phase: 'webhook_received' });
    const webhookToSignal = between(120, 900);
    t += webhookToSignal;
    add(t, 'latency_span', { streamId, meetingId, span: 'webhook_to_signaling_connected', ms: webhookToSignal });
    add(t, 'latency_span', { streamId, meetingId, span: 'signaling_ping_rtt', ms: between(18, 160) });
    add(t, 'stream_phase', { streamId, meetingId, tenantId: tenant.id, phase: 'signaling_connected' });
    const failEarly = rnd() < 0.03;
    if (!failEarly) {
      for (const mediaType of ['audio', 'transcript']) {
        add(t + 90, 'latency_span', { streamId, meetingId, span: 'signaling_to_media_handshake', ms: between(80, 600), mediaType });
        add(t + 700, 'latency_span', { streamId, meetingId, span: 'media_handshake_to_first_packet', ms: between(150, mediaType === 'audio' ? 2200 : 4200), mediaType });
      }
      t += 120;
      add(t, 'stream_phase', { streamId, meetingId, tenantId: tenant.id, phase: 'media_connected' });
      add(t + 5, 'client_ready_sent', { streamId, meetingId });
      add(t + 5, 'stream_phase', { streamId, meetingId, tenantId: tenant.id, phase: 'client_ready_sent' });
      add(t + 800, 'stream_phase', { streamId, meetingId, tenantId: tenant.id, phase: 'streaming' });
    }

    let degraded = false;
    let gaps = 0;
    let gapMs = 0;
    let reconnects = 0;
    if (!failEarly) {
      const flaps = rnd() < 0.35 ? between(1, 3) : 0;
      for (let f = 0; f < flaps; f += 1) {
        const at = t0 + Math.floor(durationMs * ((f + 1) / (flaps + 1)));
        const socket = pick(['audio', 'transcript', 'signaling']);
        const down = between(300, rnd() < 0.15 ? 30_000 : 4000);
        add(at, 'socket_closed', { streamId, socket, attempt: 0 });
        add(at + down, 'socket_recovered', { streamId, socket, downMs: down, attempts: between(1, 3) });
        add(at + down, 'latency_span', { streamId, meetingId, span: 'reconnect', ms: down, socket });
        reconnects += 1;
        degraded = true;
        if (down > 10_000) { gaps += 1; gapMs += down; }
      }
      if (rnd() < 0.15) {
        add(t0 + Math.floor(durationMs * 0.4), 'stream_state', { streamId, meetingId, state: 'PAUSED' });
        add(t0 + Math.floor(durationMs * 0.45), 'stream_state', { streamId, meetingId, state: 'RESUMED' });
      }
    }

    const [code, name, restart] = failEarly ? [18, 'authentication_failure', 'never'] : weighted(STOPS);
    const end = t0 + (failEarly ? 4000 : durationMs);
    intervals.push([t0, end]);
    if (code === 19) { degraded = true; add(end - 60_000, 'reconnect_failed', { streamId, socket: 'signaling', why: 'window_exceeded', downMs: 60_000 }); }
    add(end, 'stream_stopped', { streamId, meetingId, tenantId: tenant.id, held: true, reason: code, reasonName: name, restart, purge: false, durationMs: end - t0 });
    add(end + 20, 'stream_finalized', {
      streamId, meetingId, tenantId: tenant.id, generation, stopCode: code, stopName: name, restart, degraded, packets: between(2000, 90_000), bytes: between(200_000, 90_000_000),
      duplicatesDropped: between(0, 6), gaps, gapMs, reconnects, durationMs: end - t0, consentRef: tenant.consentRef, policyVersion: tenant.policyVersion,
      schemaVersion: 1, artifactWriterVersion: '1', mediaParamsHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'
    });
    // CRM sync, as written by the customer's own pipeline
    if (!failEarly && rnd() < 0.9) {
      const status = pick(['synced', 'synced', 'synced', 'pending', 'failed']);
      add(end + 3000, 'crm_sync', { streamId, tenantId: tenant.id, status: 'pending' });
      if (status !== 'pending') add(end + 9000, 'crm_sync', { streamId, tenantId: tenant.id, status, attempts: status === 'failed' ? 3 : 1 });
    }
    if (rnd() < 0.08) add(end + 500, 'late_duplicate_dropped', { tenantId: tenant.id, meetingId, streamId });
    if (rnd() < 0.08) add(t0 + 5000, 'stream_refresh', { tenantId: tenant.id, meetingId, streamId });
    if (rnd() < 0.05) add(t0 + 1000, 'duplicate_stream_dropped', { tenantId: tenant.id, meetingId, streamId, heldBy: 'worker-a' });
  }

  // webhook hygiene, capacity and watchdog events spread across the window
  const span = hours * 3_600_000;
  for (const reason of ['invalid_x_zm_signature', 'invalid_x_zm_signature', 'stale_x_zm_request_timestamp', 'missing_x_zm_signature']) {
    add(SAMPLE_BASE_MS + between(0, span), 'webhook_rejected', { reason });
  }
  add(SAMPLE_BASE_MS + Math.floor(span * 0.5), 'start_watchdog_fired', { meetingId: 'meeting-505', waitedMs: 60_000, unmatchedRequestStatus: [] });
  add(SAMPLE_BASE_MS + Math.floor(span * 0.62), 'stream_refused', { streamId: 'rtms-x', meetingId: 'meeting-9', reason: 'unknown_account' });
  // Capacity events follow the streams we generated: a limit equal to the busiest moment is reached once, one stream earlier is "near".
  const marks = intervals.flatMap(([a, b]) => [[a, 1], [b, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let level = 0;
  let peak = 0;
  for (const [, d] of marks) { level += d; peak = Math.max(peak, level); }
  const cap = limit ?? peak;
  level = 0;
  let nearAt = null;
  let limitedAt = null;
  for (const [t, d] of marks) {
    level += d;
    if (nearAt === null && level >= cap - 1) nearAt = [t, level];
    if (limitedAt === null && level >= cap) limitedAt = [t, level];
  }
  if (nearAt && cap > 1) add(nearAt[0], 'concurrency', { level: 'near', number: nearAt[1], limit: cap, tenantId: 'acct-acme' });
  if (limitedAt) add(limitedAt[0] + 1, 'concurrency', { level: 'limited', number: limitedAt[1], limit: cap, tenantId: 'acct-acme' });

  return out.sort((a, b) => a.tsMs - b.tsMs);
}
