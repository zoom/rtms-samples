import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { buildEnvelope } from '../shared/envelope.js';
import { buildDummyRtmsWebhook, getStopEvent } from './dummyRtms.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repoRoot, '.data', `test-compute-startup-${process.pid}`);
const children = [];
let shuttingDown = false;

try {
  const storePort = await getFreePort();
  const computePort = await getFreePort();
  const storeUrl = `http://127.0.0.1:${storePort}`;
  const streamId = `startup-load-${Date.now()}`;
  const rtmsId = `startup-rtms-${Date.now()}`;

  children.push(spawnService('05-control-store/server.js', {
    STORE_ROLE: 'regional',
    STORE_REGION: 'amer-east',
    CENTRAL_PORT: String(storePort),
    CONTROL_DATA_DIR: dataDir
  }));

  await waitForJson(`${storeUrl}/health`, 'regional store health');
  console.log(`PASS regional_store_ready port=${storePort}`);

  const startWebhook = buildDummyRtmsWebhook({ region: 'IAD', streamId, rtmsId });
  const startEnvelope = buildEnvelope(
    startWebhook.event,
    startWebhook.payload,
    'test06-compute-startup',
    startWebhook
  );

  await putJson(`${storeUrl}/streams/${encodeURIComponent(streamId)}/route`, {
    regionCode: 'amer-east',
    selectedRegionCode: 'IAD',
    productType: startEnvelope.productType,
    rtmsId: startEnvelope.rtmsId,
    envelope: startEnvelope,
    webhook: startWebhook
  });
  console.log(`PASS start_envelope_saved stream=${streamId}`);

  children.push(spawnService('04-regional-compute-job/server.js', {
    SPOKE_REGION: 'amer-east',
    SPOKE_NODE_ID: 'test-startup-compute',
    COMPUTE_PORT: String(computePort),
    REGIONAL_STORE_URL: storeUrl,
    CENTRAL_STORE_URL: storeUrl,
    RTMS_STREAM_ID: streamId,
    RTMS_ENVELOPE_REF: `regional-store:/streams/${streamId}`,
    LEASE_RENEW_INTERVAL_MS: '500',
    LEASE_TTL_MS: '5000',
    DRY_RUN: 'true'
  }));

  await waitForCondition(async () => {
    const stream = await fetchStream(storeUrl, streamId);
    return stream?.state === 'dry_run_connected' && stream?.ownerNodeId === 'test-startup-compute';
  }, 'compute loaded start envelope');
  console.log(`PASS compute_loaded_full_start_webhook stream=${streamId}`);

  const stopWebhook = buildDummyRtmsWebhook({
    event: getStopEvent(startWebhook.event),
    streamId,
    rtmsId
  });
  const stopEnvelope = buildEnvelope(
    stopWebhook.event,
    stopWebhook.payload,
    'test06-compute-startup',
    stopWebhook
  );

  await postJson(`${storeUrl}/streams/${encodeURIComponent(streamId)}/state`, {
    state: 'stop_requested',
    stopEnvelope
  });
  console.log(`PASS stop_envelope_saved stream=${streamId}`);

  await waitForCondition(async () => {
    const stream = await fetchStream(storeUrl, streamId);
    return stream?.state === 'stopped';
  }, 'compute handled stored stop envelope');
  console.log(`PASS compute_handled_full_stop_webhook stream=${streamId}`);

  console.log('06 compute startup from store tester passed: 5/5');
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
      console.error(`[test06] ${script} exited code=${code} signal=${signal || ''}`);
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

async function fetchStream(storeUrl, streamId) {
  const response = await fetch(`${storeUrl}/streams/${encodeURIComponent(streamId)}`);
  if (!response.ok) return null;
  return response.json();
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`PUT ${url} failed status=${response.status}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${url} failed status=${response.status}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
