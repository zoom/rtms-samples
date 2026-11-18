import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createClaimRegistry } from '../shared/claims.js';
import { createLogger } from '../shared/log.js';
import { createTenantGate } from '../shared/tenantGate.js';
import { createTrace } from '../shared/trace.js';
import { readLiveConfig } from '../60-stream-lifecycle-client/src/liveSession.js';
import { createLiveBridge } from './src/liveBridge.js';
import { createArtifactReconciler } from '../70-reporting-dashboard/src/artifactLifecycle.js';
import { createOAuth, fileTokenStore, memoryTokenStore } from './src/oauth.js';
import { createRestClient } from './src/restClient.js';
import { createRetryingRestClient } from './src/retryingRestClient.js';
import { createStartService } from './src/service.js';

const env = process.env;
const port = Number(env.PORT_03 || 4803);
const host = env.HOST || '127.0.0.1';
const webhookPath = env.WEBHOOK_PATH || '/webhook';
const leaseMs = Number(env.CLAIM_LEASE_MS || 45_000);
const log = createLogger('rtms');

const missing = ['ZOOM_SECRET_TOKEN', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'].filter((k) => !env[k]);
if (missing.length) {
  log.error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill them in from your Marketplace app.`);
  process.exit(1);
}
const { config: live, errors: liveErrors } = readLiveConfig(env);
if (liveErrors.length) {
  for (const e of liveErrors) log.error(e);
  process.exit(1);
}

/**
 * Which Zoom accounts may open a stream. Either a tenants file, or for a quick start the account
 * IDs in TENANT_ACCOUNT_IDS (copy one from the `stream_refused` log line if you do not know it).
 */
function loadTenants() {
  if (env.TENANTS_FILE) return JSON.parse(readFileSync(env.TENANTS_FILE, 'utf8'));
  const accounts = String(env.TENANT_ACCOUNT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!accounts.length) return JSON.parse(readFileSync(new URL('./tenants.sample.json', import.meta.url), 'utf8'));
  return [{
    tenantId: env.TENANT_ID || 'local', accountIds: accounts, products: ['meeting', 'webinar'], media: live.media,
    consentRef: env.TENANT_CONSENT_REF || 'local-dev-consent', policyVersion: env.TENANT_POLICY_VERSION || 'local-dev', retentionClass: 'dev'
  }];
}
const tenants = loadTenants();
const trace = createTrace(env.TRACE_FILE || '.data/events.jsonl');
let service;

/**
 * Optional rule for "should we process this meeting?". Point CAPTURE_FILTER_MODULE at a file whose
 * default export is (stream) => true | false | { capture, reason }. See the readme for an example.
 */
let captureFilter = null;
if (env.CAPTURE_FILTER_MODULE) {
  const mod = await import(pathToFileURL(path.resolve(env.CAPTURE_FILTER_MODULE)).href);
  if (typeof mod.default !== 'function') {
    log.error(`CAPTURE_FILTER_MODULE ${env.CAPTURE_FILTER_MODULE} must export a default function`);
    process.exit(1);
  }
  captureFilter = mod.default;
}

// Public base URL of this service, used only in human-facing error text. Example:
// https://rtms.example.com. The authorize page itself is at PUBLIC_BASE_URL/oauth/authorize.
const publicBaseUrl = String(env.PUBLIC_BASE_URL || '');
// One OAuth token record per Zoom user, because RTMS acts on behalf of a user.
const perUserTokens = Boolean(env.ZOOM_REDIRECT_URI);
const oauth = createOAuth({
  clientId: env.ZOOM_CLIENT_ID,
  clientSecret: env.ZOOM_CLIENT_SECRET,
  redirectUri: env.ZOOM_REDIRECT_URI || '',
  webhookSecret: env.ZOOM_SECRET_TOKEN,
  store: env.OAUTH_STORE === 'memory' ? memoryTokenStore() : fileTokenStore(env.OAUTH_TOKEN_DIR || '.data/oauth'),
  requiredScopes: String(env.OAUTH_REQUIRED_SCOPES || '').split(',').map((s) => s.trim()).filter(Boolean),
  trace
});

// Stop reason 8 (stream revoked) requires deleting that stream's artifacts. The reconciler
// lists every file under the stream directory and removes it; both operations are idempotent.
const streamArtifactDir = (stream) => path.join(live.outputDir, String(stream.tenantId || 'unknown'), String(stream.streamId));
const listArtifacts = async (stream) => {
  try {
    const dir = streamArtifactDir(stream);
    return (await readdir(dir, { recursive: true })).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};
const artifactReconciler = createArtifactReconciler({
  listArtifacts,
  deleteArtifact: (file) => rm(file, { force: true, recursive: true }),
  trace
});

const bridge = createLiveBridge({
  credentials: { clientId: env.ZOOM_CLIENT_ID, clientSecret: env.ZOOM_CLIENT_SECRET },
  config: live, trace, log, getService: () => service, artifactReconciler
});

service = createStartService({
  secret: env.ZOOM_SECRET_TOKEN,
  clientId: env.ZOOM_CLIENT_ID,
  trace,
  claims: createClaimRegistry({ leaseMs }),
  gate: createTenantGate(tenants),
  rest: createRetryingRestClient(createRestClient({
    accessToken: env.ZOOM_ACCESS_TOKEN || '',
    clientId: env.ZOOM_CLIENT_ID,
    // With ZOOM_REDIRECT_URI set, each call uses the token of the user it acts for. Without it the
    // client keeps the single-token shortcut, or runs as a dry run.
    ...(perUserTokens ? {
      tokenProvider: (userId) => (userId ? oauth.accessToken(userId) : { ok: false, reason: 'no_user' }),
      onUnauthorized: (userId) => oauth.expireAccessToken(userId),
      onReauthorizationNeeded: (userId, reason) => oauth.markReauthorizationRequired(userId, reason)
    } : {})
  })),
  media: live.media,
  watchdogMs: Number(env.START_WATCHDOG_MS || 60_000),
  meetingPolicy: env.MEETING_POLICY || 'first_wins',
  captureFilter,
  log,
  onStreamReady: bridge.onStreamReady,
  onStreamRefresh: bridge.onStreamRefresh,
  onStreamStopped: bridge.onStreamStopped,
  // A declined stream (a second user's duplicate, or filtered out) still exists on Zoom's side.
  // Stop it with that user's own token so it does not sit there unconnected.
  onStreamDeclined: async ({ reason, stream }) => {
    log.info('stream declined', { reason, streamId: stream.streamId, meetingId: stream.meetingId, operatorId: stream.operatorId });
    if (env.STOP_DECLINED_STREAMS === 'false' || !stream.operatorId) return;
    const outcome = await service.requestStop(stream.meetingNumericId || stream.meetingId, { participantUserId: stream.operatorId });
    log.info('declined stream stop requested', { streamId: stream.streamId, outcome: outcome.name, dryRun: Boolean(outcome.dryRun) });
  },
  onAlert: (alert) => log.warn('alert', alert)
});

const app = express();
app.disable('x-powered-by');

// Verify against the raw bytes. Acknowledge first, work after.
app.post(webhookPath, express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const { status, body } = service.handleWebhook({ headers: req.headers, rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
  res.status(status).json(body);
});

// Operator API. Bound to localhost by default. Set ADMIN_API_TOKEN to require a bearer token.
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
const requireAdmin = (req, res, next) => {
  const token = env.ADMIN_API_TOKEN;
  // Fail closed: with no token configured the operator API answers 503 rather than standing open.
  if (!token) return res.status(503).json({ error: 'admin_api_token_not_configured' });
  if (!sameSecret(req.headers.authorization, `Bearer ${token}`)) return res.status(401).json({ error: 'unauthorized' });
  return next();
};
app.post('/api/start', requireAdmin, express.json(), async (req, res) => {
  if (!req.body?.meetingId || !req.body?.accountId) return res.status(400).json({ error: 'meetingId and accountId are required' });
  res.json(await service.requestStart(req.body));
});
app.post('/api/stop', requireAdmin, express.json(), async (req, res) => {
  if (!req.body?.meetingId) return res.status(400).json({ error: 'meetingId is required' });
  res.json(await service.requestStop(req.body.meetingId, { participantUserId: req.body.participantUserId }));
});
// Pause and resume use the same status endpoint. They are the building block for your own
// pause button where the client has none (for example a browser client).
for (const action of ['pause', 'resume']) {
  app.post(`/api/${action}`, requireAdmin, express.json(), async (req, res) => {
    if (!req.body?.meetingId) return res.status(400).json({ error: 'meetingId is required' });
    res.json(await service.requestControl(action, req.body.meetingId, { participantUserId: req.body.participantUserId }));
  });
}

// User authorization. These two routes are the only ones a user's browser reaches.
app.get('/oauth/authorize', (_req, res) => {
  try {
    res.redirect(oauth.beginAuthorization().url);
  } catch {
    res.status(503).send('OAuth is not configured: set ZOOM_REDIRECT_URI to the public URL of /oauth/callback.');
  }
});
app.get('/oauth/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
    try {
      const result = await oauth.completeAuthorization({ code, state });
    log.info('user authorized', { userId: result.userId, status: result.status });
    res.status(200).send(result.status === 'authorized' ? 'Authorized. You can close this window.' : 'Authorized, but the app needs more permissions. Please authorize again.');
    } catch (error) {
      // Only a state problem falls through to the marketplace-initiated path. A token-exchange
      // failure under a valid state is the real error: retrying the same code without state would
      // double-exchange and mask it.
      if (error.message !== 'invalid_or_expired_state') {
        log.warn('authorization failed', { error: error.message });
        res.status(400).send(`Authorization failed. Authorize via ${publicBaseUrl || '/oauth/authorize'} and try again.`);
        return;
      }
      try {
        const result = await oauth.completeAuthorizationDirect({ code });
      log.info('marketplace-initiated authorization', { userId: result.userId, status: result.status, stateError: error.message });
      res.status(200).send(result.status === 'authorized' ? 'Authorized. You can close this window.' : 'Authorized, but the app needs more permissions. Please authorize again.');
      } catch (directError) {
        log.warn('authorization failed', { error: directError.message, stateError: error.message });
        res.status(400).send(`Authorization failed. Authorize via ${publicBaseUrl || '/oauth/authorize'} and try again.`);
      }
  }
});
// Zoom posts here when a user removes the app. Delete the tokens and every other piece of that user's data.
app.post('/oauth/deauthorize', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  const result = await oauth.handleDeauthorization({ headers: req.headers, rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
  if (result.userId) log.warn('user deauthorized: delete their stored data', { userId: result.userId, accountId: result.accountId });
  res.status(result.status).json(result.body);
});
app.get('/api/oauth/users', requireAdmin, async (_req, res) => res.json({ summary: await oauth.summary(), users: await oauth.users() }));
app.get('/api/state', requireAdmin, (_req, res) => res.json({
  ...service.snapshot(),
  live: [...bridge.sessions.entries()].map(([streamId, s]) => ({ streamId, ...s.client.snapshot(), segments: undefined, gaps: undefined, counts: s.counts }))
}));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const heartbeat = setInterval(() => service.heartbeat(), Math.max(1000, Math.floor(leaseMs / 3)));
const server = app.listen(port, host, () => {
  log.info('listening for Zoom webhooks', {
    url: `http://${host}:${port}${webhookPath}`, media: live.media, videoMode: live.videoMode, bufferData: live.bufferData,
    tenants: tenants.map((t) => ({ tenantId: t.tenantId, accounts: t.accountIds.length })), restStart: perUserTokens ? 'per-user tokens' : env.ZOOM_ACCESS_TOKEN ? 'live' : 'dry-run', output: live.outputDir
  });
  if (!env.TENANTS_FILE && !env.TENANT_ACCOUNT_IDS) {
    log.warn('No TENANT_ACCOUNT_IDS or TENANTS_FILE set, so the sample tenants are used and a real webhook will be refused as unknown_account. The refusal log shows the account ID to put in TENANT_ACCOUNT_IDS.');
  }
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return process.exit(1);
    closing = true;
    clearInterval(heartbeat);
    service.cancelTimers();
    log.info('shutting down: closing live streams');
    await bridge.shutdown().catch((error) => log.error('shutdown error', { error: error.message }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
