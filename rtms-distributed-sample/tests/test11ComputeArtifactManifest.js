import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { buildEnvelope } from '../shared/envelope.js';
import { buildDummyRtmsWebhook, getStopEvent } from './dummyRtms.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repoRoot, '.data', `test-compute-artifact-${process.pid}`);
const envelopeFile = path.join(dataDir, 'envelope.json');
const artifactRoot = path.join(dataDir, 'artifacts');
const children = [];
let shuttingDown = false;

try {
  fs.mkdirSync(dataDir, { recursive: true });
  const storePort = await getFreePort();
  const computePort = await getFreePort();
  const artifactPort = await getFreePort();
  const storeUrl = `http://127.0.0.1:${storePort}`;
  const artifactStorageUrl = `http://127.0.0.1:${artifactPort}`;
  const streamId = `compute-artifact-${Date.now()}`;
  const rtmsId = `compute-artifact-rtms-${Date.now()}`;
  const startWebhook = buildDummyRtmsWebhook({ region: 'IAD', streamId, rtmsId });

  fs.writeFileSync(envelopeFile, JSON.stringify(startWebhook, null, 2), 'utf8');
  console.log(`PASS envelope_file_written stream=${streamId}`);

  children.push(spawnService('05-control-store/server.js', {
    STORE_ROLE: 'regional',
    STORE_REGION: 'amer-east',
    CENTRAL_PORT: String(storePort),
    CONTROL_DATA_DIR: dataDir
  }));
  await waitForJson(`${storeUrl}/health`, 'regional store health');
  console.log(`PASS regional_store_ready port=${storePort}`);

  children.push(spawnService('08-artifact-storage/server.js', {
    ARTIFACT_STORAGE_PORT: String(artifactPort),
    ARTIFACT_STORAGE_PROVIDER: 'local',
    ARTIFACT_LOCAL_ROOT: artifactRoot
  }));
  const health = await waitForJson(`${artifactStorageUrl}/health`, 'artifact storage health');
  assert(health.storage?.provider === 'local', 'artifact storage did not use local provider');
  console.log(`PASS artifact_storage_ready port=${artifactPort}`);

  children.push(spawnService('04-regional-compute-job/server.js', {
    SPOKE_REGION: 'amer-east',
    SPOKE_NODE_ID: 'test-artifact-compute',
    COMPUTE_PORT: String(computePort),
    REGIONAL_STORE_URL: storeUrl,
    CENTRAL_STORE_URL: storeUrl,
    ARTIFACT_STORAGE_URL: artifactStorageUrl,
    RTMS_ENVELOPE_FILE: envelopeFile,
    LEASE_RENEW_INTERVAL_MS: '500',
    LEASE_TTL_MS: '5000',
    REALTIME_CACHE_URL: '',
    DRY_RUN: 'true',
    ONE_STREAM_PER_JOB: 'true'
  }));

  await waitForCondition(async () => {
    const stream = await fetchStream(storeUrl, streamId);
    return stream?.state === 'dry_run_connected' && stream?.ownerNodeId === 'test-artifact-compute';
  }, 'compute loaded webhook file');
  console.log(`PASS compute_loaded_full_webhook_file stream=${streamId}`);

  const stopWebhook = buildDummyRtmsWebhook({
    event: getStopEvent(startWebhook.event),
    streamId,
    rtmsId
  });
  const stopEnvelope = buildEnvelope(
    stopWebhook.event,
    stopWebhook.payload,
    'test11-compute-artifact',
    stopWebhook
  );

  await postJson(`${storeUrl}/streams/${encodeURIComponent(streamId)}/state`, {
    state: 'stop_requested',
    stopEnvelope
  });
  console.log(`PASS stop_envelope_saved stream=${streamId}`);

  const stoppedStream = await waitForCondition(async () => {
    const stream = await fetchStream(storeUrl, streamId);
    const manifest = stream?.blobs?.find((blob) => blob.metadata?.artifactType === 'manifest');
    if (stream?.state === 'stopped' && manifest) return { stream, manifest };
    return null;
  }, 'compute uploaded final manifest');

  const manifestPath = stoppedStream.manifest.blobUri.replace('local://artifacts/', '');
  const fullPath = path.join(artifactRoot, manifestPath);
  assert(fs.existsSync(fullPath), 'manifest artifact file was not written');
  const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  assert(manifest.streamId === streamId, 'manifest stream id mismatch');
  assert(manifest.rtmsId === rtmsId, 'manifest rtms id mismatch');
  console.log(`PASS compute_manifest_uploaded blobUri=${stoppedStream.manifest.blobUri}`);

  console.log('11 compute artifact manifest tester passed: 6/6');
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
      console.error(`[test11] ${script} exited code=${code} signal=${signal || ''}`);
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${url} failed status=${response.status}`);
  return response.json();
}

async function fetchStream(storeUrl, streamId) {
  const response = await fetch(`${storeUrl}/streams/${encodeURIComponent(streamId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET stream failed status=${response.status}`);
  return response.json();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
