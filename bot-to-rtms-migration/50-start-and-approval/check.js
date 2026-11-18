import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { probeWebhookEndpoint } from './src/probes.js';
import { liveMediaParams, readLiveConfig } from '../60-stream-lifecycle-client/src/liveSession.js';

/**
 * Check your setup for a real RTMS stream before you start a meeting. Prints which settings are
 * present, never their values.
 *
 *   npm run live:check
 *   npm run live:check -- --public-url https://rtms.example.com/webhook
 *
 * --public-url sends a signed endpoint.url_validation to that URL, exactly like Zoom does when you
 * save an event subscription. It proves the URL reaches this server and the secret token matches.
 */
const { values } = parseArgs({ options: { 'public-url': { type: 'string' }, local: { type: 'string' } } });
const env = process.env;
const rows = [];
const row = (status, text, detail = '') => rows.push({ status, text, detail });
const set = (name) => Boolean(env[name]);

for (const name of ['ZOOM_SECRET_TOKEN', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET']) {
  set(name) ? row('ok', `${name} is set`) : row('fail', `${name} is not set`, 'Copy it from your Marketplace app into .env');
}
row(set('ZOOM_ACCESS_TOKEN') || set('ZOOM_REDIRECT_URI') ? 'ok' : 'info',
  set('ZOOM_REDIRECT_URI') ? 'REST start uses each user\'s own token (ZOOM_REDIRECT_URI is set)'
    : set('ZOOM_ACCESS_TOKEN') ? 'ZOOM_ACCESS_TOKEN is set: REST start will call Zoom with that one token'
      : 'No access token and no ZOOM_REDIRECT_URI: REST start runs as a dry run',
  'Only needed to start RTMS from /api/start. Auto start and Zoom Apps start do not need it.');

const { config, errors } = readLiveConfig(env);
for (const e of errors) row('fail', e);
if (!errors.length) {
  const { problems } = liveMediaParams(config);
  if (problems.length) for (const p of problems) row('fail', `media setting: ${p}`);
  else row('ok', `media: ${config.media.join(', ')}${config.media.includes('video') ? ` (${config.videoMode})` : ''}`, `buffer_data ${config.bufferData}, reconnect windows ${config.windows.signalingMs / 1000}s signaling and ${config.windows.mediaMs / 1000}s media`);
  row('info', `output goes to ${config.outputDir}/<tenant>/<stream>/ (manifest.json${config.saveTranscript ? ', transcript.jsonl' : ''})`);
}

let tenants = [];
if (env.TENANTS_FILE) {
  try { tenants = JSON.parse(readFileSync(env.TENANTS_FILE, 'utf8')); row('ok', `tenants loaded from TENANTS_FILE (${tenants.length})`); } catch (e) { row('fail', `TENANTS_FILE could not be read: ${e.message}`); }
} else if (env.TENANT_ACCOUNT_IDS) {
  row('ok', `a dev tenant covers ${env.TENANT_ACCOUNT_IDS.split(',').filter(Boolean).length} account ID(s) from TENANT_ACCOUNT_IDS`);
} else {
  row('warn', 'No TENANT_ACCOUNT_IDS or TENANTS_FILE: a real webhook will be refused as unknown_account', 'Start once, read the account ID in the stream_refused log line, and put it in TENANT_ACCOUNT_IDS');
}

const port = env.PORT_03 || 4803;

// Per-user authorization. REST start, stop, pause and resume act for one Zoom user and need that user's token.
if (set('ZOOM_REDIRECT_URI')) {
  /^https:\/\//.test(env.ZOOM_REDIRECT_URI)
    ? row('ok', 'ZOOM_REDIRECT_URI is set', 'It must match the redirect URL in your Marketplace app exactly')
    : row('warn', 'ZOOM_REDIRECT_URI is not https', 'Zoom redirects users to it; use https outside local testing');
} else {
  row('info', 'ZOOM_REDIRECT_URI is not set: users cannot authorize through this server', 'Needed only for REST start and stop on behalf of users. Webhook-started streams do not need it');
}
if (env.MEETING_POLICY && !['first_wins', 'keep_both'].includes(env.MEETING_POLICY)) row('fail', `MEETING_POLICY must be first_wins or keep_both, got ${env.MEETING_POLICY}`);
else row('info', `meeting policy: ${env.MEETING_POLICY || 'first_wins'}`, 'What happens when two users of your app are in one meeting');
if (env.CAPTURE_FILTER_MODULE) {
  try { readFileSync(env.CAPTURE_FILTER_MODULE); row('ok', 'CAPTURE_FILTER_MODULE file found'); } catch { row('fail', `CAPTURE_FILTER_MODULE could not be read: ${env.CAPTURE_FILTER_MODULE}`); }
}
const local = values.local || `http://127.0.0.1:${port}/healthz`;
try {
  const res = await fetch(local, { signal: AbortSignal.timeout(2000) });
  row(res.ok ? 'ok' : 'warn', `the server answers at ${local}`);
} catch {
  row('info', `the server is not running at ${local}`, 'Start it with: npm run start:03');
}

if (values['public-url']) {
  const result = await probeWebhookEndpoint({ url: values['public-url'], secret: env.ZOOM_SECRET_TOKEN });
  result.ok
    ? row('ok', `${values['public-url']} answers Zoom's URL validation with your secret token`)
    : row('fail', `${values['public-url']} did not validate: ${result.reason}${result.status ? ` (HTTP ${result.status})` : ''}`, result.hint || 'Check the reverse proxy path, that the server is running, and that ZOOM_SECRET_TOKEN matches the Marketplace app');
} else {
  row('info', 'Public webhook URL not tested', 'Run: npm run live:check -- --public-url https://<your-host>/<webhook path>');
}

const mark = { ok: '[ ok ]', info: '[info]', warn: '[warn]', fail: '[FAIL]' };
for (const r of rows) {
  console.log(`${mark[r.status]} ${r.text}`);
  if (r.detail) console.log(`       ${r.detail}`);
}
const failed = rows.filter((r) => r.status === 'fail').length;
console.log(failed ? `\n${failed} problem(s) to fix before a real stream can connect.` : '\nReady. Start a meeting with RTMS enabled and watch the log.');
process.exit(failed ? 1 : 0);
