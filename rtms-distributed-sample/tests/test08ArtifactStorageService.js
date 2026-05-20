import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(repoRoot, '.data', `test-artifacts-${process.pid}`);
const children = [];
let shuttingDown = false;

try {
  const port = await getFreePort();
  const serviceUrl = `http://127.0.0.1:${port}`;
  children.push(spawnService('08-artifact-storage/server.js', {
    ARTIFACT_STORAGE_PORT: String(port),
    ARTIFACT_STORAGE_PROVIDER: 'local',
    ARTIFACT_LOCAL_ROOT: dataDir
  }));

  const health = await waitForJson(`${serviceUrl}/health`, 'artifact storage health');
  assert(health.storage?.provider === 'local', 'artifact storage did not use local provider');
  console.log(`PASS artifact_storage_health port=${port}`);

  const streamId = `artifact-stream-${Date.now()}`;
  const markdown = '# Final Summary\n\nThis is a test artifact.\n';
  const upload = await postJson(`${serviceUrl}/artifacts`, {
    streamId,
    rtmsId: 'artifact-rtms',
    regionCode: 'IAD',
    productType: 'meeting',
    artifactType: 'summary_final',
    fileName: 'final.md',
    contentType: 'text/markdown',
    content: markdown,
    metadata: {
      test: true
    }
  });

  const artifact = upload.artifact;
  assert(artifact.blobUri?.startsWith('local://artifacts/'), 'missing local blob uri');
  assert(artifact.objectKey.includes('artifact_type=summary_final'), 'object key missing artifact type partition');
  assert(artifact.objectKey.includes(`stream_id=${streamId}`), 'object key missing stream id partition');
  assert(artifact.byteSize === Buffer.byteLength(markdown), 'byte size mismatch');
  assert(artifact.sha256 === sha256(markdown), 'sha mismatch');

  const localFile = path.join(dataDir, artifact.objectKey);
  assert(fs.existsSync(localFile), 'artifact file was not written');
  assert(fs.readFileSync(localFile, 'utf8') === markdown, 'artifact file content mismatch');
  console.log(`PASS json_artifact_uploaded blobUri=${artifact.blobUri}`);

  const rawBody = Buffer.from('raw audio placeholder');
  const rawResponse = await fetch(`${serviceUrl}/streams/${encodeURIComponent(streamId)}/artifacts/audio_final/final-audio.wav?regionCode=IAD&productType=meeting`, {
    method: 'PUT',
    headers: {
      'content-type': 'audio/wav',
      'x-rtms-artifact-metadata': JSON.stringify({ test: 'raw' })
    },
    body: rawBody
  });
  assert(rawResponse.status === 201, `raw upload failed status=${rawResponse.status}`);
  const rawUpload = await rawResponse.json();
  assert(rawUpload.artifact.contentType === 'audio/wav', 'raw artifact content type mismatch');
  assert(rawUpload.artifact.byteSize === rawBody.length, 'raw artifact byte size mismatch');
  assert(fs.existsSync(path.join(dataDir, rawUpload.artifact.objectKey)), 'raw artifact file was not written');
  console.log(`PASS raw_artifact_uploaded blobUri=${rawUpload.artifact.blobUri}`);

  console.log('08 artifact storage service tester passed: 3/3');
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
      console.error(`[test08] ${script} exited code=${code} signal=${signal || ''}`);
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
