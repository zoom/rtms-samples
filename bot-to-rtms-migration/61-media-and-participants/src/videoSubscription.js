import { MSG } from '../../shared/codes.js';

/**
 * One individual-video subscription at a time.
 *
 * RTMS gives you ONE selected participant's camera on the individual-video socket. To switch,
 * unsubscribe the current person and then subscribe the next. Rather than queueing operations
 * (which go stale), this manager keeps two facts and reconciles them after every response:
 *
 *   current  who the server is sending video for, as last confirmed
 *   desired  who we want
 *
 * It never has two requests in flight. When `current` differs from `desired` it sends the one
 * next step: unsubscribe `current`, or subscribe `desired`. It also copes with:
 *
 *   - the selected person turns video off or leaves: the subscription is over, the stream is not
 *   - the video socket reconnects: the old connection is gone, so subscribe again
 *   - a subscribe request that times out: the server state is unknown, so clean it up first
 *   - a frame for someone who is not the current subscription: it is never attributed
 *
 * afterVideoEnds: 'none' leaves nobody selected, 'next' selects another person whose video is on.
 */
export function createVideoSubscriptionManager({
  registry, send, trace, streamId, afterVideoEnds = 'none', responseTimeoutMs = 5000,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now
}) {
  let current = null;
  let desired = null;
  let inflight = null;
  let cleanup = null; // a user whose subscribe timed out: the server may or may not have it
  const stats = { requests: 0, refused: 0, failed: 0, switches: 0, resubscribes: 0, unattributedFrames: 0 };
  const note = (type, fields = {}) => trace?.append(type, { streamId, ...fields });

  function request(userId) {
    stats.requests += 1;
    if (!registry.isVideoOn(userId)) {
      stats.refused += 1;
      note('video_subscription_refused', { userId, reason: 'video_not_on' });
      return { ok: false, reason: 'video_not_on' };
    }
    if (desired === userId) return { ok: true, reason: current === userId && !inflight ? 'already_selected' : 'in_progress' };
    if (current !== null && current !== userId) stats.switches += 1;
    desired = userId;
    pump();
    return { ok: true, reason: 'queued' };
  }

  /** Select nobody. */
  function release() {
    if (desired === null && current === null) return { ok: true, reason: 'nothing_selected' };
    desired = null;
    pump();
    return { ok: true, reason: 'queued' };
  }

  function sendOp(op) {
    inflight = { ...op, at: now(), timer: setTimer(() => timedOut(op), responseTimeoutMs) };
    inflight.timer?.unref?.();
    send({ msg_type: MSG.VIDEO_SUBSCRIPTION_REQ, user_id: op.userId, subscribe: op.subscribe, timestamp: now() });
  }

  /** Take the single next step toward `desired`. */
  function pump() {
    if (inflight) return;
    if (cleanup !== null) return sendOp({ userId: cleanup, subscribe: false, cleanup: true });
    if (desired !== null && !registry.isVideoOn(desired)) {
      stats.refused += 1;
      note('video_subscription_refused', { userId: desired, reason: 'video_off_before_send' });
      desired = current;
    }
    if (current !== null && current !== desired) return sendOp({ userId: current, subscribe: false });
    if (desired !== null && current !== desired) return sendOp({ userId: desired, subscribe: true });
    return undefined;
  }

  function failed(op, why, status = null) {
    stats.failed += 1;
    note(why, { userId: op.userId, subscribe: op.subscribe, status });
    if (op.cleanup) {
      cleanup = null;
    } else if (op.subscribe) {
      if (desired === op.userId) desired = null; // stop trying for this person
      if (why === 'video_subscription_timeout') cleanup = op.userId; // we do not know what the server did
    } else {
      desired = current; // could not release the current person, so do not try to switch
    }
  }

  function timedOut(op) {
    if (!inflight || inflight.userId !== op.userId || inflight.subscribe !== op.subscribe) return;
    inflight = null;
    failed(op, 'video_subscription_timeout');
    pump();
  }

  /** Pass the VIDEO_SUBSCRIPTION_RESP message here. */
  function handleResponse(msg) {
    if (!inflight || inflight.userId !== msg.user_id) {
      note('video_subscription_unexpected', { userId: msg.user_id });
      return { handled: false };
    }
    clearTimer(inflight.timer);
    const op = inflight;
    inflight = null;
    if (msg.status_code === 0) {
      if (op.cleanup) cleanup = null;
      else if (op.subscribe) {
        // The person may have turned video off while the request was in flight. The server already dropped it.
        if (registry.isVideoOn(op.userId)) current = op.userId;
        else if (desired === op.userId) desired = null;
      } else if (current === op.userId) current = null;
      note('video_subscription_changed', { userId: op.userId, subscribe: op.subscribe, current });
    } else {
      failed(op, 'video_subscription_failed', msg.status_code);
    }
    pump();
    return { handled: true, ok: msg.status_code === 0 };
  }

  /** The registry told us someone's video interval ended (video off, or they left). */
  function handleParticipantChange(change) {
    if (change.type !== 'video_off' && change.type !== 'leave') return;
    const user = change.userId;
    const wasCurrent = current === user;
    const wasDesired = desired === user;
    if (!wasCurrent && !wasDesired) return;
    if (wasCurrent) current = null; // the server dropped it. Do not wait for it, do not send an unsubscribe.
    if (wasDesired) {
      if (!wasCurrent) {
        stats.refused += 1;
        note('video_subscription_refused', { userId: user, reason: 'video_off_before_send' });
      }
      // Fall back to whatever is already confirmed or on its way, instead of churning.
      desired = inflight?.subscribe && inflight.userId !== user ? inflight.userId : current;
    }
    note('video_subscription_ended', { userId: user, cause: change.cause || change.type });
    if (afterVideoEnds === 'next') {
      const next = registry.videoOnUsers().find((id) => id !== user);
      if (next !== undefined) request(next);
    }
    pump();
  }

  /** The video media socket reconnected. The server side of the subscription is unknown, so do it again. */
  function handleVideoSocketRecovered() {
    const want = desired ?? current;
    if (inflight) clearTimer(inflight.timer);
    inflight = null;
    cleanup = null;
    current = null;
    desired = null;
    if (want === null || want === undefined) return { resubscribed: false };
    stats.resubscribes += 1;
    note('video_resubscribe', { userId: want });
    request(want);
    return { resubscribed: true, userId: want };
  }

  /** Frames are attributed only to the current subscription. */
  function attributeFrame(packet) {
    if (current !== null && packet.userId === current) return { attributed: true, userId: current };
    stats.unattributedFrames += 1;
    return { attributed: false, userId: null };
  }

  return {
    request, release, handleResponse, handleParticipantChange, handleVideoSocketRecovered, attributeFrame,
    state: () => ({ current, desired, cleanup, inflight: inflight ? { userId: inflight.userId, subscribe: inflight.subscribe } : null, stats: { ...stats } })
  };
}
