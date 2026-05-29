import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sampleRoot = path.resolve(__dirname, '..');
const publicRoot = path.join(__dirname, 'public');

dotenv.config({ path: path.join(sampleRoot, '.env') });

const app = express();
const port = Number(process.env.PHASER_ARLO_PORT || 4570);
const realtimeCacheUrl = trimTrailingSlash(process.env.PHASER_ARLO_REALTIME_CACHE_URL || process.env.REALTIME_CACHE_URL || 'http://127.0.0.1:4560');
const requestTimeoutMs = Number(process.env.PHASER_ARLO_CACHE_TIMEOUT_MS || 1200);

app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'phaser-arlo',
    realtimeCacheUrl,
    port
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    realtimeCacheUrl,
    defaultMode: 'dummy',
    pollIntervalMs: 2500
  });
});

app.get('/api/cache/streams', async (_req, res) => {
  const result = await proxyJson('/streams?include=all', { streams: [] });
  res.status(result.status).json(result.body);
});

app.get('/api/cache/webhooks/stats', async (_req, res) => {
  const result = await proxyJson('/webhooks/stats', {
    windows: [
      { key: '1m', label: 'Past minute', counts: { total: 0, accepted: 0, unverified: 0, duplicate: 0, concurrency_limited: 0 } },
      { key: '60m', label: 'Past 60 minutes', counts: { total: 0, accepted: 0, unverified: 0, duplicate: 0, concurrency_limited: 0 } },
      { key: '24h', label: 'Past 24 hours', counts: { total: 0, accepted: 0, unverified: 0, duplicate: 0, concurrency_limited: 0 } }
    ]
  });
  res.status(result.status).json(result.body);
});

app.get('/vendor/pixi.min.js', (_req, res) => {
  res.sendFile(path.join(sampleRoot, 'node_modules', 'pixi.js', 'dist', 'pixi.min.js'));
});

app.get('/assets/arlo-sprite.jpg', (_req, res) => {
  res.sendFile(path.join(__dirname, 'arlo sprite.jpg'));
});

app.use(express.static(publicRoot, {
  etag: true,
  maxAge: '0'
}));

app.listen(port, () => {
  console.log(`[09-phaser-arlo] listening on http://127.0.0.1:${port} realtimeCache=${realtimeCacheUrl}`);
});

async function proxyJson(route, fallbackBody) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${realtimeCacheUrl}${route}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    const body = await response.json();
    if (!response.ok) {
      return {
        status: 200,
        body: {
          ...fallbackBody,
          unavailable: true,
          upstreamStatus: response.status,
          upstreamError: body?.error || 'cache_request_failed'
        }
      };
    }
    return { status: 200, body };
  } catch (error) {
    return {
      status: 200,
      body: {
        ...fallbackBody,
        unavailable: true,
        upstreamError: error.name === 'AbortError' ? 'cache_timeout' : error.message
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}
