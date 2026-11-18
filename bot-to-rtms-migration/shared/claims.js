/**
 * In-memory lease registry for the connection layer.
 *
 * One logical stream is tenant + product + meeting/session + rtms_stream_id.
 * Only one worker may hold the claim. A lease that is not renewed expires, so a
 * crashed worker cannot hold the lock forever. Every claim carries a generation
 * (a fencing token): a worker whose lease was taken over cannot renew or release.
 *
 * Production swap: this registry is process-local. In a real deployment use an
 * atomic unique-key insert in your own database, or Redis `SET key owner NX PX leaseMs`,
 * and keep the same claim/renew/release contract.
 */
export function streamKey({ tenantId, product, meetingId, streamId }) {
  return [tenantId, product, meetingId, streamId].join('|');
}

export function createClaimRegistry({ leaseMs = 45_000, now = Date.now } = {}) {
  const claims = new Map();

  const expired = (c) => now() >= c.expiresAt;

  function claim(key, owner) {
    const existing = claims.get(key);
    const t = now();
    if (!existing) {
      claims.set(key, { owner, generation: 1, claimedAt: t, expiresAt: t + leaseMs, state: 'held' });
      return { ok: true, outcome: 'claimed', generation: 1 };
    }
    if (existing.state === 'released') {
      // A stopped stream id is never reused. A late duplicate must not reopen it.
      return { ok: false, outcome: 'already_finished', owner: existing.owner, generation: existing.generation };
    }
    if (existing.owner === owner && !expired(existing)) {
      existing.expiresAt = t + leaseMs;
      return { ok: true, outcome: 'renewed', generation: existing.generation };
    }
    if (!expired(existing)) {
      return { ok: false, outcome: 'duplicate', owner: existing.owner, generation: existing.generation };
    }
    const previousOwner = existing.owner;
    const generation = existing.generation + 1;
    claims.set(key, { owner, generation, claimedAt: t, expiresAt: t + leaseMs, state: 'held', supersedes: previousOwner });
    return { ok: true, outcome: 'superseded', generation, previousOwner };
  }

  function owns(key, owner, generation) {
    const c = claims.get(key);
    return Boolean(c && c.state === 'held' && c.owner === owner && c.generation === generation);
  }

  function renew(key, owner, generation) {
    const c = claims.get(key);
    if (!c || c.state !== 'held') return { ok: false, outcome: 'not_held' };
    if (c.owner !== owner || c.generation !== generation) return { ok: false, outcome: 'fenced', currentOwner: c.owner };
    c.expiresAt = now() + leaseMs;
    return { ok: true, outcome: 'renewed', generation };
  }

  function release(key, owner, generation, reason = 'released') {
    const c = claims.get(key);
    if (!c) return { ok: false, outcome: 'not_held' };
    if (c.state === 'released') return { ok: true, outcome: 'already_released' };
    if (c.owner !== owner || c.generation !== generation) return { ok: false, outcome: 'fenced', currentOwner: c.owner };
    c.state = 'released';
    c.releasedAt = now();
    c.reason = reason;
    return { ok: true, outcome: 'released' };
  }

  function get(key) {
    const c = claims.get(key);
    return c ? { ...c, expired: expired(c) } : null;
  }

  /**
   * Give up a claim that never became a running stream (for example the hand-off to a worker
   * failed). Unlike release(), this leaves no tombstone, so a later attempt can claim the same key.
   */
  function abandon(key, owner, generation) {
    const c = claims.get(key);
    if (!c || c.state !== 'held') return { ok: false, outcome: 'not_held' };
    if (c.owner !== owner || c.generation !== generation) return { ok: false, outcome: 'fenced', currentOwner: c.owner };
    claims.delete(key);
    return { ok: true, outcome: 'abandoned' };
  }

  /** Drop tombstones older than `olderThanMs`. Production: use a TTL on the key. */
  function pruneReleased(olderThanMs) {
    let removed = 0;
    for (const [key, c] of claims) {
      if (c.state === 'released' && now() - c.releasedAt >= olderThanMs) {
        claims.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  return { claim, owns, renew, release, abandon, get, pruneReleased, size: () => claims.size };
}
