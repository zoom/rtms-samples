import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { buildEnvelope } from '../shared/envelope.js';
import { buildInternalSignatureHeaders } from '../shared/internalSignature.js';
import { buildDummyRtmsWebhook, getStopEvent, parseArgs } from './dummyRtms.js';

const args = parseArgs(process.argv.slice(2));
const secret = args.secret || process.env.INTERNAL_WEBHOOK_SECRET || 'testsecrettoken';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repoRoot, '.data', `test-direct-spoke-${process.pid}`);
const children = [];
let shuttingDown = false;

try {
  const storePort = await getFreePort();
  const computePort = await getFreePort();
  const spokePort = await getFreePort();
  const storeUrl = `http://127.0.0.1:${storePort}`;
  const computeUrl = `http://127.0.0.1:${computePort}`;
  const spokeUrl = `http://127.0.0.1:${spokePort}`;

  children.push(spawnService('05-control-store/server.js', {
    STORE_ROLE: 'regional',
    STORE_REGION: 'amer-east',
    CENTRAL_PORT: String(storePort),
    CONTROL_DATA_DIR: dataDir
  }));

  children.push(spawnService('04-regional-compute-job/server.js', {
    SPOKE_REGION: 'amer-east',
    SPOKE_NODE_ID: 'test-compute-node',
    COMPUTE_PORT: String(computePort),
    REGIONAL_STORE_URL: storeUrl,
    CENTRAL_STORE_URL: storeUrl,
    DRY_RUN: 'true'
  }));

  children.push(spawnService('03-regional-webhook-spoke/server.js', {
    SPOKE_REGION: 'amer-east',
    SPOKE_PORT: String(spokePort),
    INTERNAL_WEBHOOK_SECRET: secret,
    REGIONAL_STORE_URL: storeUrl,
    COMPUTE_ENDPOINTS: JSON.stringify([`${computeUrl}/compute/webhook`])
  }));

  const storeHealth = await waitForJson(`${storeUrl}/health`, 'regional store health');
  assert(storeHealth.sqlite?.journalMode === 'wal', 'regional store is not using SQLite WAL mode');
  pass('regional_store_sqlite_health', `port=${storePort}`);

  const computeHealth = await waitForJson(`${computeUrl}/health`, 'compute health');
  assert(computeHealth.dryRun === true, 'compute is not in dry-run mode');
  pass('compute_health', `port=${computePort}`);

  const spokeHealth = await waitForJson(`${spokeUrl}/health`, 'spoke health');
  assert(spokeHealth.internalSignatureVerification === 'required', 'spoke does not require internal signature');
  pass('spoke_health', `port=${spokePort}`);

  const streamId = `direct-handoff-${Date.now()}`;
  const rtmsId = `direct-rtms-${Date.now()}`;
  const startWebhook = buildDummyRtmsWebhook({ region: 'IAD', streamId, rtmsId });
  const startEnvelope = buildEnvelope(
    startWebhook.event,
    startWebhook.payload,
    'test04-direct-handoff',
    startWebhook
  );

  const startResponse = await postSignedJson(`${spokeUrl}/spoke/webhook`, startEnvelope, secret);
  assert(startResponse.status === 202, `start handoff returned ${startResponse.status}`);
  pass('signed_start_accepted', `stream=${streamId}`);

  await waitForCondition(async () => {
    const stream = await fetchStream(storeUrl, streamId);
    return stream?.state === 'dry_run_connected' && stream?.documents?.length > 0;
  }, 'compute dry-run state');
  pass('start_reached_compute_and_sqlite', `stream=${streamId}`);

  const stopWebhook = buildDummyRtmsWebhook({
    event: getStopEvent(startWebhook.event),
    streamId,
    rtmsId
  });
  const stopEnvelope = buildEnvelope(
    stopWebhook.event,
    stopWebhook.payload,
    'test04-direct-handoff',
    stopWebhook
  );

  const stopResponse = await postSignedJson(`${spokeUrl}/spoke/webhook`, stopEnvelope, secret);
  assert(stopResponse.status === 202, `stop handoff returned ${stopResponse.status}`);
  pass('signed_stop_accepted', `stream=${streamId}`);

  await waitForCondition(async () => {
    const stream = await fetchStream(storeUrl, streamId);
    return stream?.state === 'stopped';
  }, 'compute stopped state');
  pass('stop_reached_compute_and_sqlite', `stream=${streamId}`);

  console.log('04 direct spoke handoff tester passed: 7/7');
} finally {
  shuttingDown = true;
  for (const child of children.reverse()) {
    child.kill('SIGTERM');
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function spawnService(script, env) {
  const child = spawn(process.execPath, [path.join(repoRoot, script)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    if (process.env.TEST_VERBOSE) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (process.env.TEST_VERBOSE) process.stderr.write(chunk);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[test04] ${script} exited code=${code} signal=${signal || ''}`);
    }
  });
  return child;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, label) {
  return waitForCondition(async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return response.json();
    } catch (_error) {
      return null;
    }
  }, label);
}

async function waitForCondition(check, label, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function postSignedJson(url, body, signingSecret) {
  const bodyText = JSON.stringify(body);
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildInternalSignatureHeaders(bodyText, signingSecret)
    },
    body: bodyText
  });
}

async function fetchStream(storeUrl, streamId) {
  const response = await fetch(`${storeUrl}/streams/${encodeURIComponent(streamId)}`);
  if (!response.ok) return null;
  return response.json();
}

function pass(name, reason = '') {
  console.log(`PASS ${name}${reason ? ` reason=${reason}` : ''}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
