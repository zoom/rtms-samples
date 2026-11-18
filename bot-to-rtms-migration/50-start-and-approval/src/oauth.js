import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { verifyWebhook } from '../../shared/webhookSignature.js';

/**
 * Per-user OAuth for an RTMS app.
 *
 * RTMS acts on behalf of a Zoom user, so REST start, stop, pause and resume need that user's
 * access token. A bot had one service identity. This keeps one token record per Zoom user:
 *
 *   - exchange the authorization code and learn who authorized
 *   - hand out a valid access token, refreshing it shortly before it expires
 *   - store the newest refresh token every time (Zoom rotates it)
 *   - mark a user `reauthorization_required` when only a new authorization can fix it
 *   - delete everything for a user who deauthorizes the app
 *
 * Access tokens last one hour. Refresh tokens last 90 days and rotate. A scope added to the app
 * later is not on tokens issued earlier, so existing users must authorize again.
 *
 * Tokens are secrets. The file store writes mode 0600 and is for development. In production use
 * your secret store or an encrypted column, and keep the same get/set/delete/list contract.
 */

export function memoryTokenStore() {
  const map = new Map();
  return {
    get: (userId) => (map.has(userId) ? { ...map.get(userId) } : null),
    set: (userId, record) => { map.set(userId, { ...record }); },
    delete: (userId) => { map.delete(userId); },
    list: () => [...map.entries()].map(([userId, record]) => ({ userId, ...record }))
  };
}

export function fileTokenStore(dir) {
  const fileFor = (userId) => path.join(dir, `${encodeURIComponent(userId)}.json`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    get(userId) {
      try { return JSON.parse(readFileSync(fileFor(userId), 'utf8')); } catch { return null; }
    },
    set(userId, record) {
      const target = fileFor(userId);
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    },
    delete(userId) {
      if (existsSync(fileFor(userId))) unlinkSync(fileFor(userId));
    },
    list() {
      return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
        try { return { userId: decodeURIComponent(f.slice(0, -5)), ...JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }; } catch { return null; }
      }).filter(Boolean);
    }
  };
}

const STATE_TTL_MS = 10 * 60 * 1000;

export function createOAuth({
  clientId,
  clientSecret,
  redirectUri = '',
  webhookSecret = '',
  store = memoryTokenStore(),
  trace = null,
  requiredScopes = [],
  fetchImpl = fetch,
  now = Date.now,
  oauthBase = 'https://zoom.us',
  apiBase = 'https://api.zoom.us/v2',
  skewMs = 60_000,
  timeoutMs = 10_000
}) {
  const states = new Map(); // state -> { expiresAt, context }
  const inflight = new Map(); // userId -> Promise, so concurrent callers share one refresh
  const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  const note = (type, fields) => trace?.append(type, fields);
  const scopeList = (scope) => String(scope || '').split(/[\s,]+/).filter(Boolean);
  const missingScopes = (scope) => requiredScopes.filter((s) => !scopeList(scope).includes(s));

  // --- authorization --------------------------------------------------------

  /** Step 1: send the user to Zoom. `context` is your own data (for example your logged-in user) returned after the callback. */
  function beginAuthorization(context = null) {
    if (!redirectUri) throw new Error('ZOOM_REDIRECT_URI is not set');
    const t = now();
    for (const [k, v] of states) if (v.expiresAt <= t) states.delete(k);
    const state = randomBytes(16).toString('hex');
    states.set(state, { expiresAt: t + STATE_TTL_MS, context });
    const url = new URL('/oauth/authorize', oauthBase);
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state }).toString();
    return { url: url.toString(), state };
  }

  /** Step 2: Zoom redirects back with ?code and ?state. A state works once and expires. */
  async function completeAuthorization({ code, state }) {
    const entry = states.get(state);
    states.delete(state);
    if (!code || !entry || entry.expiresAt <= now()) throw new Error('invalid_or_expired_state');
    const record = await exchangeCode(code, { context: entry.context });
    return record;
  }

  /**
   * Step 2, marketplace-initiated variant. The Authorize button inside Marketplace omits our state
   * entirely, because the state is this server's own CSRF value and Zoom cannot know it. Exchange
   * the code directly; every check the state would carry is implicit in the code being single use
   * and bound to this client by the token endpoint.
   */
  async function completeAuthorizationDirect({ code }) {
    if (!code) throw new Error('missing_code');
    return exchangeCode(code, { context: null });
  }

  // Network blips during the callback cost the single-use authorization code, so a transport
  // failure is retried once before giving up. Zoom-level failures (4xx/5xx with a JSON body)
  // are returned as-is: retrying cannot fix a bad code or a config error.
  async function fetchOnce(url, options, { attempts = 2 } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetchImpl(url, options);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw lastError;
  }

  async function tokenRequest(params) {
    const res = await fetchOnce(`${oauthBase}/oauth/token`, {
      method: 'POST',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }

  /**
   * Trade an authorization code for tokens, then ask Zoom who the user is (GET /users/me needs the
   * user:read:user scope). Pass { userId } to skip the lookup if your app does not request that scope.
   */
  async function exchangeCode(code, { userId = null, context = null } = {}) {
    const r = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (r.status !== 200 || !r.json?.access_token) throw new Error(`token_exchange_failed:${r.json?.reason || r.json?.error || r.status}`);

    let accountId = null;
    let id = userId;
    if (!id) {
      const me = await fetchOnce(`${apiBase}/users/me`, { headers: { authorization: `Bearer ${r.json.access_token}` }, signal: AbortSignal.timeout(timeoutMs) });
      const profile = me.status === 200 ? await me.json().catch(() => null) : null;
      if (!profile?.id) throw new Error('user_lookup_failed: add the user:read:user scope, or pass the Zoom user ID');
      id = profile.id;
      accountId = profile.account_id || null;
    }
    const missing = missingScopes(r.json.scope);
    const record = {
      accessToken: r.json.access_token,
      refreshToken: r.json.refresh_token,
      expiresAt: now() + Number(r.json.expires_in || 3600) * 1000,
      scope: r.json.scope || '',
      accountId,
      status: missing.length ? 'reauthorization_required' : 'authorized',
      reason: missing.length ? `missing_scope:${missing.join(',')}` : null,
      authorizedAt: now()
    };
    await store.set(id, record);
    note('user_authorized', { userId: id, accountId, status: record.status, missingScopes: missing });
    return { userId: id, accountId, status: record.status, context };
  }

  // --- tokens ---------------------------------------------------------------

  /** A valid access token for this user, or the reason there is none. Never throws for expected states. */
  async function accessToken(userId) {
    const record = await store.get(userId);
    if (!record) return { ok: false, reason: 'unknown_user' };
    if (record.status === 'reauthorization_required') return { ok: false, reason: 'reauthorization_required', detail: record.reason };
    if (record.expiresAt - now() > skewMs) return { ok: true, accessToken: record.accessToken, expiresAt: record.expiresAt };
    return refresh(userId);
  }

  function refresh(userId) {
    if (inflight.has(userId)) return inflight.get(userId);
    const work = (async () => {
      const record = await store.get(userId);
      if (!record) return { ok: false, reason: 'unknown_user' };
      let r;
      try {
        r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: record.refreshToken });
      } catch (error) {
        return { ok: false, reason: 'refresh_failed_retryable', detail: error.code || error.message };
      }
      if (r.status === 200 && r.json?.access_token) {
        const missing = missingScopes(r.json.scope ?? record.scope);
        const next = {
          ...record,
          accessToken: r.json.access_token,
          // Zoom rotates the refresh token. Always keep the newest one.
          refreshToken: r.json.refresh_token || record.refreshToken,
          expiresAt: now() + Number(r.json.expires_in || 3600) * 1000,
          scope: r.json.scope ?? record.scope,
          refreshedAt: now(),
          status: missing.length ? 'reauthorization_required' : 'authorized',
          reason: missing.length ? `missing_scope:${missing.join(',')}` : null
        };
        await store.set(userId, next);
        if (missing.length) {
          note('user_reauthorization_required', { userId, reason: next.reason });
          return { ok: false, reason: 'reauthorization_required', detail: next.reason };
        }
        return { ok: true, accessToken: next.accessToken, expiresAt: next.expiresAt };
      }
      if (r.status === 400 || r.status === 401) {
        // The refresh token is invalid or expired. Only a new authorization can fix this.
        await markReauthorizationRequired(userId, `refresh_rejected:${r.status}`);
        return { ok: false, reason: 'reauthorization_required', detail: `refresh_rejected:${r.status}` };
      }
      return { ok: false, reason: 'refresh_failed_retryable', detail: r.status };
    })().finally(() => inflight.delete(userId));
    inflight.set(userId, work);
    return work;
  }

  /** Force the next call to refresh. Use it when Zoom answers 401 to a token you thought was valid. */
  async function expireAccessToken(userId) {
    const record = await store.get(userId);
    if (record) await store.set(userId, { ...record, expiresAt: 0 });
  }

  async function markReauthorizationRequired(userId, reason) {
    const record = await store.get(userId);
    if (!record) return;
    await store.set(userId, { ...record, status: 'reauthorization_required', reason });
    note('user_reauthorization_required', { userId, reason });
  }

  // --- deauthorization --------------------------------------------------------

  /** Delete the user's tokens. Your own per-user data must be deleted too: Zoom requires it. */
  async function revoke(userId) {
    await store.delete(userId);
    note('user_deauthorized', { userId });
  }

  /**
   * Handle the `app_deauthorized` notification. Verify it like any webhook, then delete.
   * Returns { status, body, userId? } for the route to send.
   */
  async function handleDeauthorization({ headers, rawBody }) {
    const verified = verifyWebhook({ headers, rawBody, secret: webhookSecret, nowMs: now() });
    if (!verified.ok) return { status: 401, body: { error: verified.reason } };
    let body;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: { error: 'invalid_json' } }; }
    if (body.event !== 'app_deauthorized') return { status: 200, body: { status: 'ignored' } };
    const p = body.payload || {};
    if (p.client_id && p.client_id !== clientId) return { status: 200, body: { status: 'ignored' } };
    if (!p.user_id) return { status: 400, body: { error: 'missing_user_id' } };
    await revoke(p.user_id);
    return { status: 200, body: { status: 'deleted' }, userId: p.user_id, accountId: p.account_id || null };
  }

  // --- reporting (never returns a token) ---------------------------------------

  async function users() {
    const all = await store.list();
    return all.map((u) => ({
      userId: u.userId, accountId: u.accountId || null, status: u.status, reason: u.reason || null,
      scopes: scopeList(u.scope), expiresAt: u.expiresAt, authorizedAt: u.authorizedAt || null, refreshedAt: u.refreshedAt || null
    }));
  }

  async function summary() {
    const all = await users();
    return {
      total: all.length,
      authorized: all.filter((u) => u.status === 'authorized').length,
      reauthorizationRequired: all.filter((u) => u.status === 'reauthorization_required').length
    };
  }

  return { beginAuthorization, completeAuthorization, completeAuthorizationDirect, exchangeCode, accessToken, expireAccessToken, markReauthorizationRequired, revoke, handleDeauthorization, users, summary };
}
