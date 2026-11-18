import { backoffDelayMs, decideRequestStatus, decideStop, MEDIA_TYPE, TIMING } from '../../shared/codes.js';
import { streamKey } from '../../shared/claims.js';
import { normalizeStartedPayload, isInterruptedEvent, isStartedEvent, isStoppedEvent } from '../../shared/rtmsPayload.js';
import { urlValidationResponse, verifyWebhook, webhookDedupeKey } from '../../shared/webhookSignature.js';
import { silentLogger } from '../../shared/log.js';

const DEDUPE_TTL_MS = 65 * 60 * 1000; // Zoom retries a webhook for up to an hour
const MAX_DEDUPE_ENTRIES = 50_000;

/**
 * Start and approval service.
 *
 * It does three jobs that a Meeting SDK bot never had to do:
 *   1. Receive the lifecycle webhooks safely: verify, acknowledge, drop duplicates, then act.
 *   2. Decide whether a stream may be opened (tenant and consent gate, capacity, claim).
 *   3. Start RTMS on purpose (REST), remember why, and notice when the started webhook never comes.
 *
 * It opens no WebSockets. A verified, claimed stream is handed to `onStreamReady`; the stream-lifecycle client
 * shows what a client does with it.
 *
 * Two policies decide whether a verified stream is wanted at all, before anything is claimed:
 *   meetingPolicy  'first_wins' (default) refuses a second stream for the same meeting that a
 *                  different user started while the first is live. 'keep_both' opens every stream.
 *   captureFilter  your rule for "should we process this meeting?", for example a minimum number
 *                  of attendees. Auto-start cannot express such rules, so you accept the webhook,
 *                  decide here, and (through onStreamDeclined) stop the stream by REST.
 * A declined stream is traced as `stream_refused` and passed to `onStreamDeclined`.
 */
export function createStartService({
  secret,
  clientId = '',
  workerId = `worker-${process.pid}`,
  trace,
  claims,
  gate,
  rest,
  media = ['audio', 'transcript'],
  watchdogMs = 60_000,
  nearLimitHoldMs = 5 * 60_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
  log = silentLogger,
  onStreamReady = () => {},
  onStreamRefresh = () => {},
  onStreamStopped = () => {},
  onStreamDeclined = () => {},
  meetingPolicy = 'first_wins',
  captureFilter = null,
  onAlert = () => {}
}) {
  if (!['first_wins', 'keep_both'].includes(meetingPolicy)) throw new Error(`meetingPolicy must be first_wins or keep_both, got ${meetingPolicy}`);
  const seen = new Map(); // dedupe key -> expiry
  const active = new Map(); // claim key -> stream
  // Streams this worker held and then released (client finished, stop webhook). A stop webhook
  // that arrives after the release is normal; a purge-class one (reason 8) must still act.
  const releasedStreams = new Map();
  const rememberReleased = (stream) => {
    releasedStreams.set(stream.streamId, { streamId: stream.streamId, tenantId: stream.tenantId ?? null, meetingId: stream.meetingId ?? null });
    if (releasedStreams.size > 200) releasedStreams.delete(releasedStreams.keys().next().value);
  };
  // meetingId -> { participantUserId, timer, at, audit }. A start against a meeting that has
  // already ended stays here until the watchdog fires: Zoom accepts the PATCH but never sends
  // started for a dead meeting, and the entry blocks retries with already_pending. The map is
  // in-memory; a restart is the documented way to clear a stale pending start.
  const pendingStarts = new Map();
  const unmatchedRequestStatus = [];
  const state = { startsPausedUntil: 0, concurrency: { level: 'ok', number: null, limit: null, at: null } };

  // --- webhook layer ------------------------------------------------------

  function remember(key) {
    const t = now();
    if (seen.size >= MAX_DEDUPE_ENTRIES) for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
    if (seen.has(key) && seen.get(key) > t) return false;
    seen.set(key, t + DEDUPE_TTL_MS);
    return true;
  }

  /**
   * Returns { status, body, done }. The HTTP answer is decided before any work happens.
   * `done` resolves when the follow-up work has finished (tests await it; the server ignores it).
   */
  function handleWebhook({ headers, rawBody }) {
    const verified = verifyWebhook({ headers, rawBody, secret, nowMs: now() });
    if (!verified.ok) {
      trace.append('webhook_rejected', { reason: verified.reason });
      return { status: 401, body: { error: verified.reason }, done: Promise.resolve() };
    }
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      trace.append('webhook_rejected', { reason: 'invalid_json' });
      return { status: 400, body: { error: 'invalid_json' }, done: Promise.resolve() };
    }
    if (body.event === 'endpoint.url_validation' && body.payload?.plainToken) {
      return { status: 200, body: urlValidationResponse(body.payload.plainToken, secret), done: Promise.resolve() };
    }

    const event = String(body.event || '');
    const requestId = headers['x-zm-request-id'];
    const key = webhookDedupeKey(body);
    // A retry of the same event is a duplicate by its natural key, or by its delivery id.
    const newByKey = remember(key);
    const newByRequestId = requestId ? remember(`req:${requestId}`) : true;
    if (!newByKey || !newByRequestId) {
      trace.append('webhook_duplicate', { event, key });
      return { status: 200, body: { status: 'duplicate' }, done: Promise.resolve() };
    }

    const done = Promise.resolve().then(() => dispatch(event, body)).catch((error) => {
      log.error('dispatch_failed', { event, error: error.message });
      trace.append('dispatch_failed', { event, error: error.message });
    });
    return { status: 200, body: { status: 'accepted' }, done };
  }

  function dispatch(event, body) {
    const payload = body.payload || {};
    if (isStartedEvent(event)) return onStarted(event, payload);
    if (isStoppedEvent(event)) return onStopped(event, payload);
    if (isInterruptedEvent(event)) return onInterrupted(event, payload);
    if (event === 'rtms.request_status') return onRequestStatus(payload);
    if (event === 'rtms.concurrency_near_limit' || event === 'rtms.concurrency_limited') return onConcurrency(event, payload);
    trace.append('webhook_ignored', { event });
    return undefined;
  }

  // --- lifecycle events ---------------------------------------------------

  async function onStarted(event, payload) {
    const s = normalizeStartedPayload(event, payload);
    clearPending(s.meetingId, s.meetingNumericId);

    const verdict = gate.check({ accountId: s.accountId, product: s.product, media });
    if (!verdict.ok) {
      trace.append('stream_refused', { streamId: s.streamId, meetingId: s.meetingId, accountId: s.accountId, reason: verdict.reason, tenantId: verdict.tenantId || null });
      onAlert({ type: 'stream_refused', reason: verdict.reason, streamId: s.streamId, accountId: s.accountId });
      return;
    }
    if (!s.streamId || !s.meetingId || !s.serverUrls) {
      trace.append('stream_refused', { streamId: s.streamId, meetingId: s.meetingId, reason: 'incomplete_payload' });
      return;
    }

    const key = streamKey({ tenantId: verdict.tenantId, product: s.product, meetingId: s.meetingId, streamId: s.streamId });
    const base = { tenantId: verdict.tenantId, product: s.product, meetingId: s.meetingId, streamId: s.streamId };

    // A started webhook for a stream we already hold is a refresh. Never re-judge (and never stop) a live stream.
    if (captureFilter && !active.has(key)) {
      const wanted = await runCaptureFilter(base, s);
      if (!wanted.capture) return decline('filtered_out', base, s, { filterReason: wanted.reason || null });
    }

    // From here to active.set nothing awaits, so two started webhooks for one meeting cannot interleave.
    const rival = meetingPolicy === 'first_wins' ? findRival(base, s.operatorId) : null;
    if (rival) return decline('duplicate_meeting_stream', base, s, { heldByStreamId: rival.streamId, heldByOperatorId: rival.operatorId });

    const result = claims.claim(key, workerId);

    if (!result.ok) {
      trace.append(result.outcome === 'already_finished' ? 'late_duplicate_dropped' : 'duplicate_stream_dropped', { ...base, heldBy: result.owner });
      return;
    }
    if (result.outcome === 'renewed') {
      // The same stream is already ours and live. Opening a second connection would kick the first one.
      trace.append('stream_refresh', base);
      onStreamRefresh(active.get(key) || { ...base, ...s }, s);
      return;
    }

    const stream = { ...base, key, operatorId: s.operatorId || null, meetingNumericId: s.meetingNumericId || null, generation: result.generation, consentRef: verdict.consentRef, policyVersion: verdict.policyVersion, startedAt: now(), envelope: s };
    active.set(key, stream);
    trace.append('stream_claimed', { ...base, claim: result.outcome, claimGeneration: result.generation, consentRef: verdict.consentRef, policyVersion: verdict.policyVersion });
    try {
      await onStreamReady(stream);
    } catch (error) {
      // The hand-off failed, so nobody is running this stream. Do not let the heartbeat keep a dead claim alive.
      active.delete(key);
      claims.abandon(key, workerId, stream.generation);
      trace.append('stream_start_failed', { ...base, error: error.message });
      onAlert({ type: 'stream_start_failed', streamId: s.streamId, error: error.message });
    }
    return undefined;
  }

  /** A different user's stream for the same meeting that is still live. A new stream by the same user is a restart, not a rival. */
  function findRival(base, operatorId) {
    if (!operatorId) return null;
    for (const a of active.values()) {
      if (a.tenantId === base.tenantId && a.product === base.product && a.meetingId === base.meetingId
        && a.streamId !== base.streamId && a.operatorId && a.operatorId !== operatorId) return a;
    }
    return null;
  }

  async function runCaptureFilter(base, s) {
    try {
      const r = await captureFilter({ ...base, accountId: s.accountId, operatorId: s.operatorId, meetingNumericId: s.meetingNumericId, originalHost: s.originalHost, envelope: s });
      if (typeof r === 'boolean') return { capture: r };
      return { capture: r?.capture !== false, reason: r?.reason };
    } catch (error) {
      // A broken filter must not silently drop meetings. Capture, and say so loudly.
      trace.append('capture_filter_failed', { ...base, error: error.message });
      onAlert({ type: 'capture_filter_failed', streamId: base.streamId, error: error.message });
      return { capture: true };
    }
  }

  async function decline(reason, base, s, extra = {}) {
    trace.append('stream_refused', { ...base, accountId: s.accountId, operatorId: s.operatorId || null, reason, ...extra });
    try {
      await onStreamDeclined({ reason, stream: { ...base, operatorId: s.operatorId || null, meetingNumericId: s.meetingNumericId || null, accountId: s.accountId }, ...extra });
    } catch (error) {
      trace.append('decline_hook_failed', { streamId: base.streamId, error: error.message });
    }
    return undefined;
  }

  function onStopped(event, payload) {
    const s = normalizeStartedPayload(event, payload);
    const reasonCode = payload.stop_reason ?? payload.reason ?? payload.object?.stop_reason ?? payload.object?.reason;
    const decision = decideStop(reasonCode);
    const match = [...active.values()].find((a) => a.streamId === s.streamId);
    const base = { streamId: s.streamId, meetingId: s.meetingId, reason: decision.code, reasonName: decision.name, restart: decision.restart };

    if (!match) {
      // A stop for a stream we do not hold is normal: duplicates, another worker owns it, or a
      // release that raced ahead of this webhook. A purge-class stop still has to act, so
      // reconcile against the remembered release; the reconciler is idempotent.
      const prior = releasedStreams.get(s.streamId);
      if (decision.purge || decision.alert) {
        trace.append('stream_stopped', { ...base, tenantId: prior?.tenantId ?? null, held: false, purge: decision.purge, late: true });
        if (decision.purge) return onStreamStopped({ streamId: s.streamId, tenantId: prior?.tenantId ?? null, meetingId: prior?.meetingId ?? s.meetingId }, decision);
      } else {
        trace.append('stream_stopped', { ...base, held: false });
      }
      return;
    }
    claims.release(match.key, workerId, match.generation, decision.name);
    rememberReleased(match);
    active.delete(match.key);
    // A stop frees one slot. At the limit we are now one below it, which is "near", not "plenty of room".
    if (state.concurrency.level === 'limited') state.concurrency = { ...state.concurrency, level: 'near', at: now() };
    trace.append('stream_stopped', { ...base, tenantId: match.tenantId, held: true, purge: decision.purge, durationMs: now() - match.startedAt });
    if (decision.alert) onAlert({ type: 'stop_alert', ...base, action: decision.action });
    return onStreamStopped(match, decision);
  }

  function onInterrupted(event, payload) {
    const s = normalizeStartedPayload(event, payload);
    const match = [...active.values()].find((a) => a.streamId === s.streamId);
    trace.append('stream_interrupted', { streamId: s.streamId, meetingId: s.meetingId, held: Boolean(match), source: 'webhook' });
    // The interruption is recovered by the owner's own reconnect. Do not open a second connection.
  }

  function onRequestStatus(payload) {
    const d = decideRequestStatus(payload);
    trace.append('request_status', { code: d.code, name: d.name, known: d.known, retry: d.retry, streamId: d.streamId, operatorId: d.operatorId, rebootInMinutes: d.rebootInMinutes });
    if (d.pauseStarts) state.startsPausedUntil = now() + (d.rebootInMinutes || 15) * 60_000;
    if (d.resumeStarts) state.startsPausedUntil = 0;
    if (d.alert) onAlert({ type: 'request_status_alert', code: d.code, action: d.action });

    const matched = matchPending(payload, d);
    if (matched) clearPending(matched);
    else unmatchedRequestStatus.push({ at: now(), code: d.code });
    return d;
  }

  function onConcurrency(event, payload) {
    const p = payload.object && typeof payload.object === 'object' ? { ...payload, ...payload.object } : payload;
    const level = event === 'rtms.concurrency_limited' ? 'limited' : 'near';
    state.concurrency = { level, number: Number(p.concurrency_number) || null, limit: Number(p.concurrency_limit) || null, at: now() };
    trace.append('concurrency', { level, ...state.concurrency, tenantId: p.account_id || null });
    if (level === 'limited') onAlert({ type: 'concurrency_limited', ...state.concurrency });
  }

  // --- starting on purpose ------------------------------------------------

  /** Can a new stream be requested right now? Near the limit we shed noncritical starts. */
  function startsAllowed({ critical = false } = {}) {
    if (state.startsPausedUntil > now()) return { allowed: false, reason: 'server_update_scheduled', retryAt: state.startsPausedUntil };
    if (state.concurrency.level === 'limited') {
      return { allowed: false, reason: 'concurrency_limited', retryAfterMs: backoffDelayMs(2, { random, baseMs: 5000, capMs: 60_000 }) };
    }
    // Without a fresh near-limit event we cannot know the count, so shedding expires instead of lasting forever.
    const nearIsFresh = state.concurrency.level === 'near' && now() - (state.concurrency.at ?? 0) < nearLimitHoldMs;
    if (nearIsFresh && !critical) return { allowed: false, reason: 'concurrency_near_limit_shedding', retryAt: state.concurrency.at + nearLimitHoldMs };
    return { allowed: true };
  }

  /**
   * Request a REST start for a joined invitee and keep the evidence.
   * request: { meetingId, participantUserId?, accountId, product?, policy?, critical? }
   */
  async function requestStart(request) {
    const product = request.product || 'meeting';
    const gateVerdict = gate.check({ accountId: request.accountId, product, media });
    const audit = buildAudit(request, gateVerdict);

    if (!gateVerdict.ok) {
      trace.append('start_attempt', { meetingId: request.meetingId, result: 'refused', reason: gateVerdict.reason, audit });
      return { started: false, reason: gateVerdict.reason };
    }
    const allowance = startsAllowed({ critical: request.critical });
    if (!allowance.allowed) {
      trace.append('start_attempt', { meetingId: request.meetingId, result: 'deferred', reason: allowance.reason, audit });
      return { started: false, ...allowance };
    }
    if (pendingStarts.has(request.meetingId)) {
      trace.append('start_attempt', { meetingId: request.meetingId, result: 'already_pending', audit });
      return { started: false, reason: 'already_pending' };
    }

    const response = await rest.start(request.meetingId, { participantUserId: request.participantUserId });
    const outcome = response.outcome;
    trace.append('start_attempt', {
      meetingId: request.meetingId, result: outcome.waitForWebhook ? 'accepted' : 'rejected', dryRun: Boolean(response.dryRun),
      outcome: outcome.name, httpStatus: outcome.httpStatus ?? null, code: outcome.code ?? null, retry: outcome.retry, audit
    });
    if (!outcome.waitForWebhook) return { started: false, outcome };

    const timer = setTimer(() => watchdogFired(request.meetingId), watchdogMs);
    timer?.unref?.();
    pendingStarts.set(request.meetingId, { participantUserId: request.participantUserId, at: now(), timer, audit });
    return { started: true, outcome, waitingForWebhookMs: watchdogMs };
  }

  async function requestStop(meetingId, opts = {}) {
    const response = await rest.stop(meetingId, opts);
    trace.append('stop_requested', { meetingId, outcome: response.outcome.name, dryRun: Boolean(response.dryRun), httpStatus: response.outcome.httpStatus ?? null });
    return response.outcome;
  }

  /** Pause or resume a running stream through the REST status endpoint. The stream state messages tell you when it took effect. */
  async function requestControl(action, meetingId, opts = {}) {
    if (action !== 'pause' && action !== 'resume') throw new Error(`action must be pause or resume, got ${action}`);
    const response = await rest[action](meetingId, opts);
    trace.append('control_requested', { meetingId, action, outcome: response.outcome.name, dryRun: Boolean(response.dryRun), httpStatus: response.outcome.httpStatus ?? null });
    return response.outcome;
  }

  /** What to store at start time so support can tell policy from capability from approval. */
  function buildAudit(request, gateVerdict) {
    return {
      meetingId: request.meetingId,
      targetUser: request.participantUserId || 'token_subject',
      appClientId: clientId || null,
      policySnapshot: request.policy || null,
      authorization: gateVerdict.ok ? 'allowed' : gateVerdict.reason,
      tenantId: gateVerdict.tenantId || null,
      consentRef: gateVerdict.consentRef || null,
      mediaRequested: media.filter((m) => MEDIA_TYPE[m]),
      requestedAt: new Date(now()).toISOString()
    };
  }

  function watchdogFired(meetingId) {
    const pending = pendingStarts.get(meetingId);
    if (!pending) return;
    pendingStarts.delete(meetingId);
    const nearby = unmatchedRequestStatus.filter((r) => r.at >= pending.at);
    trace.append('start_watchdog_fired', {
      meetingId, waitedMs: now() - pending.at, unmatchedRequestStatus: nearby.map((r) => r.code),
      auditOrder: ['app installation', 'attendee-side external-meeting policy', 'invite-list membership', 'host presence', 'host approval', 'host tools', 'rtms.request_status']
    });
    // Causes seen live: dry-run without a token, the meeting ended before the webhook, the
    // account missing from TENANT_ACCOUNT_IDS, or a stale webhook secret bouncing Zoom's
    // validation probes with 401. Also check the app's Meetings surface is enabled in Marketplace.
    onAlert({ type: 'started_webhook_missing', meetingId });
  }

  function matchPending(payload, decision) {
    const p = payload.object && typeof payload.object === 'object' ? { ...payload, ...payload.object } : payload;
    for (const id of [p.meeting_id, p.meeting_uuid]) if (id && pendingStarts.has(String(id))) return String(id);
    for (const [meetingId, pending] of pendingStarts) {
      if (pending.participantUserId && pending.participantUserId === decision.operatorId) return meetingId;
    }
    return null;
  }

  function clearPending(...ids) {
    for (const id of ids) {
      const pending = id && pendingStarts.get(String(id));
      if (pending) {
        clearTimer(pending.timer);
        pendingStarts.delete(String(id));
      }
    }
  }

  // --- leases ---------------------------------------------------------------

  /**
   * Call when the lifecycle client for a stream has finished for any reason (stopped, gave up,
   * crashed and was cleaned up). Stops the lease renewal and marks the stream finished, so a
   * late duplicate cannot reopen it.
   */
  function releaseStream(streamId, reason = 'client_finished') {
    const stream = [...active.values()].find((a) => a.streamId === streamId);
    if (!stream) return { released: false };
    rememberReleased(stream);
    active.delete(stream.key);
    claims.release(stream.key, workerId, stream.generation, reason);
    trace.append('stream_released', { streamId, meetingId: stream.meetingId, tenantId: stream.tenantId, reason });
    return { released: true };
  }

  /** Call on an interval of about leaseMs / 3. A fenced stream means another worker took over: stop using it. */
  function heartbeat() {
    const fenced = [];
    for (const [key, stream] of active) {
      const result = claims.renew(key, workerId, stream.generation);
      if (!result.ok) {
        fenced.push(stream);
        active.delete(key);
        trace.append('claim_fenced', { streamId: stream.streamId, meetingId: stream.meetingId, outcome: result.outcome });
        onAlert({ type: 'claim_fenced', streamId: stream.streamId });
      }
    }
    return fenced;
  }

  function cancelTimers() {
    for (const pending of pendingStarts.values()) clearTimer(pending.timer);
    pendingStarts.clear();
  }

  return {
    handleWebhook,
    requestStart,
    requestStop,
    requestControl,
    startsAllowed,
    heartbeat,
    releaseStream,
    cancelTimers,
    snapshot: () => ({
      active: [...active.values()].map((a) => ({ streamId: a.streamId, meetingId: a.meetingId, tenantId: a.tenantId, operatorId: a.operatorId || null, generation: a.generation })),
      meetingPolicy,
      pendingStarts: [...pendingStarts.keys()],
      concurrency: { ...state.concurrency },
      startsPausedUntil: state.startsPausedUntil || null,
      dedupeEntries: seen.size,
      watchdogMs,
      toleranceSeconds: TIMING.webhookToleranceSeconds
    })
  };
}
