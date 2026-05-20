import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let shuttingDown = false;

try {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const streamId = `realtime-cache-${Date.now()}`;

  children.push(spawnService('06-realtime-cache/server.js', {
    REALTIME_CACHE_PORT: String(port),
    REALTIME_CACHE_BACKEND: 'memory',
    REALTIME_CACHE_TTL_SECONDS: '60'
  }));

  const health = await waitForJson(`${baseUrl}/health`, 'realtime cache health');
  assert(health.ok === true && health.backend === 'memory', 'realtime cache did not start in memory mode');
  console.log(`PASS realtime_cache_ready port=${port}`);

  await postJson(`${baseUrl}/streams/${encodeURIComponent(streamId)}/state`, {
    state: 'connected',
    regionCode: 'amer-east',
    nodeId: 'test-node'
  });
  await postJson(`${baseUrl}/streams/${encodeURIComponent(streamId)}/metrics`, {
    metrics: {
      audio_bytes_total: 1200,
      video_bytes_total: 2400
    }
  });
  await postJson(`${baseUrl}/streams/${encodeURIComponent(streamId)}/summary`, {
    text: 'live summary',
    userName: 'Tester'
  });
  await postJson(`${baseUrl}/streams/${encodeURIComponent(streamId)}/events`, {
    type: 'first_packet'
  });
  console.log(`PASS realtime_cache_writes stream=${streamId}`);

  const stream = await waitForJson(`${baseUrl}/streams/${encodeURIComponent(streamId)}`, 'realtime stream read');
  assert(stream.state?.state === 'connected', 'state was not stored');
  assert(stream.metrics?.audio_bytes_total === 1200, 'metrics were not stored');
  assert(stream.summary?.text === 'live summary', 'summary was not stored');
  assert(stream.events?.[0]?.type === 'first_packet', 'event was not stored');
  console.log('PASS realtime_cache_readback');

  const dashboard = await fetchText(`${baseUrl}/dashboard`);
  assert(dashboard.includes('RTMS Realtime Cache'), 'dashboard html missing title');
  console.log('PASS realtime_cache_dashboard');

  const metrics = await fetchText(`${baseUrl}/metrics`);
  assert(metrics.includes('rtms_realtime_active_streams 1'), 'prometheus active stream metric missing');
  assert(metrics.includes('metric="audio_bytes_total"'), 'prometheus summed metric missing');
  console.log('PASS realtime_cache_prometheus_metrics');

  console.log('12 realtime cache tester passed: 5/5');
} finally {
  shuttingDown = true;
  for (const child of children.reverse()) {
    child.kill('SIGTERM');
  }
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
      console.error(`[test12] ${script} exited code=${code} signal=${signal || ''}`);
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

async function waitForJson(url, label, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (_error) {
      // retry
    }
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

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed status=${response.status}`);
  return response.text();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
