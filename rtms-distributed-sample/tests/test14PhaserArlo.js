import { spawn } from 'child_process';
import net from 'net';

const port = await getFreePort();
const child = spawn(process.execPath, ['09-phaser-arlo/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PHASER_ARLO_PORT: String(port),
    PHASER_ARLO_REALTIME_CACHE_URL: `http://127.0.0.1:${port + 1000}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

const logs = [];
child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

try {
  await waitFor(() => fetchJson(`http://127.0.0.1:${port}/health`), 'arlo health');
  const health = await fetchJson(`http://127.0.0.1:${port}/health`);
  assert(health.ok === true && health.service === 'phaser-arlo', 'health payload mismatch');
  pass('health_ready', `port=${port}`);

  const html = await fetchText(`http://127.0.0.1:${port}/`);
  assert(html.includes('rtms-arlo-root') && html.includes('RTMS Arlo Workshop') && html.includes('Stress 150'), 'missing app shell');
  pass('single_page_loaded');

  const js = await fetchText(`http://127.0.0.1:${port}/src/main.js`);
  assert(js.includes('new PIXI.Application') && js.includes('DummyRealtimeFeed') && js.includes('powerPreference'), 'missing Pixi dummy code');
  assert(js.includes('Webhook Police Station') && js.includes('Reconnect Hospital') && js.includes('failReconnect'), 'missing rejected/reconnect map areas');
  assert(js.includes('highDensityMode') && js.includes('seedStress') && js.includes('drawBulkActors'), 'missing high-density stress support');
  assert(js.includes('prisonTextureKey') && js.includes('REJECTED_GATE_PROGRESS'), 'missing prison stripe rejected-webhook state');
  pass('pixi_script_loaded');

  const pixi = await fetchText(`http://127.0.0.1:${port}/vendor/pixi.min.js`);
  assert(pixi.includes('PIXI'), 'Pixi runtime was not served');
  pass('pixi_runtime_served');

  const asset = await fetch(`http://127.0.0.1:${port}/assets/arlo-sprite.jpg`);
  assert(asset.ok && Number(asset.headers.get('content-length') || 0) > 1000, 'sprite asset missing');
  pass('arlo_sprite_served');

  const streams = await fetchJson(`http://127.0.0.1:${port}/api/cache/streams`);
  assert(Array.isArray(streams.streams), 'cache streams fallback did not return an array');
  assert(streams.unavailable === true, 'cache fallback should mark unavailable when upstream is absent');
  pass('cache_proxy_fallback');

  console.log('14 Pixi Arlo tester passed');
} finally {
  child.kill('SIGTERM');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(operation, label, timeoutMs = 5000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message || logs.join('')}`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(name, reason = '') {
  console.log(`PASS ${name}${reason ? ` reason=${reason}` : ''}`);
}
