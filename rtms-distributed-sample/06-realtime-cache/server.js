import dotenv from 'dotenv';
import express from 'express';
import { MemoryRealtimeCacheStore, RedisRealtimeCacheStore } from './store.js';
import { createRtmsObservabilityLogger } from '../shared/rtmsObservabilityLogger.js';

dotenv.config();

const app = express();
const port = Number(process.env.REALTIME_CACHE_PORT || 4560);
const defaultTtlSeconds = Number(process.env.REALTIME_CACHE_TTL_SECONDS || 7200);
const maxEventsPerStream = Number(process.env.REALTIME_CACHE_MAX_EVENTS || 100);
const webhookStatsRetentionSeconds = Number(process.env.REALTIME_WEBHOOK_STATS_RETENTION_SECONDS || 25 * 60 * 60);
const logger = createRtmsObservabilityLogger({
  service: 'realtime-cache',
  regionCode: process.env.SPOKE_REGION || process.env.REGION_CODE || 'central',
  nodeId: process.env.NODE_ID || `realtime-cache-${process.pid}`,
  level: process.env.SERVICE_LOG_LEVEL || process.env.RTMS_LOG_LEVEL || 'info',
  console: process.env.SERVICE_LOG_CONSOLE !== 'false'
});
const store = await createStore();

app.use(express.json({ limit: process.env.REALTIME_CACHE_JSON_LIMIT || '2mb' }));

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'realtime-cache',
    backend: store.backend,
    ttlSeconds: defaultTtlSeconds,
    maxEventsPerStream,
    webhookStatsRetentionSeconds,
    stats: await store.stats()
  });
});

app.get('/dashboard', (_req, res) => {
  res.type('html').send(renderDashboardHtml());
});

app.get('/streams', async (_req, res) => {
  res.json({ streams: await store.listStreams() });
});

app.get('/streams/:streamId', async (req, res) => {
  const stream = await store.getStream(req.params.streamId);
  if (!stream) return res.status(404).json({ error: 'stream_not_found' });
  return res.json(stream);
});

app.post('/streams/:streamId/state', async (req, res) => {
  const stream = await store.upsertState(req.params.streamId, req.body || {}, ttlFrom(req));
  res.json(stream);
});

app.post('/streams/:streamId/summary', async (req, res) => {
  const stream = await store.putSummary(req.params.streamId, req.body || {}, ttlFrom(req));
  res.json(stream);
});

app.post('/streams/:streamId/metrics', async (req, res) => {
  const stream = await store.putMetrics(req.params.streamId, req.body?.metrics || req.body || {}, ttlFrom(req));
  res.json(stream);
});

app.post('/streams/:streamId/latency', async (req, res) => {
  const stream = await store.putLatencySample(req.params.streamId, req.body?.latency || req.body || {}, ttlFrom(req));
  res.json(stream);
});

app.post('/streams/:streamId/participants', async (req, res) => {
  const stream = await store.putParticipants(req.params.streamId, req.body || {}, ttlFrom(req));
  res.json(stream);
});

app.post('/streams/:streamId/events', async (req, res) => {
  const stream = await store.appendEvent(req.params.streamId, req.body || {}, {
    ttlSeconds: ttlFrom(req),
    maxEvents: maxEventsPerStream
  });
  res.json(stream);
});

app.post('/nodes/:nodeId/health', async (req, res) => {
  const node = await store.putNodeHealth(req.params.nodeId, req.body || {}, ttlFrom(req));
  res.json(node);
});

app.post('/webhooks/observations', async (req, res) => {
  const stats = await store.recordWebhookObservation(req.body || {});
  res.json(stats);
});

app.get('/webhooks/stats', async (_req, res) => {
  res.json(await store.webhookStats());
});

app.get('/metrics', async (_req, res) => {
  const metrics = await store.prometheusMetrics();
  res.type('text/plain; version=0.0.4').send(metrics);
});

const server = app.listen(port, () => {
  logger.info(`[06-realtime-cache] listening on http://127.0.0.1:${port} backend=${store.backend}`);
});

async function createStore() {
  const backend = String(process.env.REALTIME_CACHE_BACKEND || (process.env.REALTIME_CACHE_REDIS_URL ? 'redis' : 'memory')).toLowerCase();
  if (backend === 'redis') {
    return RedisRealtimeCacheStore.create({
      url: process.env.REALTIME_CACHE_REDIS_URL || buildRedisUrl(),
      password: process.env.REALTIME_CACHE_REDIS_PASSWORD || process.env.REDIS_PASSWORD || undefined,
      defaultTtlSeconds,
      webhookStatsRetentionSeconds
    });
  }

  return new MemoryRealtimeCacheStore({ defaultTtlSeconds, webhookStatsRetentionSeconds });
}

function buildRedisUrl() {
  const host = process.env.REALTIME_CACHE_REDIS_HOST || '127.0.0.1';
  const portNumber = process.env.REDIS_PORT || '6379';
  return `redis://${host}:${portNumber}`;
}

function ttlFrom(req) {
  const value = Number(req.body?.ttlSeconds || req.query?.ttlSeconds || defaultTtlSeconds);
  return Number.isFinite(value) && value > 0 ? value : defaultTtlSeconds;
}

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RTMS Realtime Cache</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f5;
      --ink: #18211f;
      --muted: #60706a;
      --line: #d9e0dc;
      --panel: #ffffff;
      --accent: #0d7c66;
      --warn: #b45309;
      --danger: #9f1239;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
      letter-spacing: 0;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
    }
    main {
      display: grid;
      grid-template-columns: minmax(260px, 360px) 1fr;
      min-height: calc(100vh - 65px);
    }
    aside {
      border-right: 1px solid var(--line);
      background: #fbfcfa;
      overflow: auto;
    }
    section {
      padding: 18px;
      overflow: auto;
    }
    button, select {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      padding: 8px 10px;
      border-radius: 6px;
      font: inherit;
    }
    button { cursor: pointer; }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }
    .stream {
      width: 100%;
      display: grid;
      gap: 4px;
      text-align: left;
      padding: 12px 14px;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
    }
    .stream:hover, .stream.active { background: #eef7f3; }
    .stream strong { font-size: 13px; overflow-wrap: anywhere; }
    .stream span { font-size: 12px; color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(130px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      min-height: 78px;
    }
    .metric span { color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 8px; font-size: 22px; }
    .metric small { display: block; margin-top: 8px; color: var(--muted); font-size: 11px; line-height: 1.4; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .panel h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
      line-height: 1.45;
      color: #26322f;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      padding: 8px 6px;
      border-bottom: 1px solid var(--line);
      text-align: left;
    }
    th { color: var(--muted); font-weight: 600; }
    td.number { text-align: right; font-variant-numeric: tabular-nums; }
    .empty {
      padding: 20px;
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); max-height: 38vh; }
      .grid { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
    }
  </style>
</head>
<body>
  <header>
    <h1>RTMS Realtime Cache</h1>
    <div class="toolbar">
      <span id="status">loading</span>
      <button type="button" id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <aside id="streams"></aside>
    <section>
      <div class="grid">
        <div class="metric"><span>Active streams</span><strong id="active">0</strong></div>
        <div class="metric"><span>Audio MiB</span><strong id="audio">0</strong></div>
        <div class="metric"><span>Video MiB</span><strong id="video">0</strong></div>
        <div class="metric"><span>Events</span><strong id="events">0</strong></div>
        <div class="metric"><span>Webhook latency</span><strong id="webhookLatency">-</strong><small id="webhookLatencyRange">low - / high -</small></div>
        <div class="metric"><span>Signaling RTT</span><strong id="signalingLatency">-</strong><small id="signalingLatencyRange">low - / high -</small></div>
      </div>
      <div class="panel"><h2>Webhook Summary</h2><div id="webhooks"></div></div>
      <div class="panel"><h2>Latency Summary</h2><div id="latency"></div></div>
      <div class="panel"><h2>Selected Stream</h2><pre id="detail">{}</pre></div>
    </section>
  </main>
  <script>
    let selected = null;
    async function refresh() {
      const status = document.getElementById('status');
      status.textContent = 'refreshing';
      const [response, webhookResponse] = await Promise.all([
        fetch('/streams'),
        fetch('/webhooks/stats')
      ]);
      const data = await response.json();
      const webhookStats = webhookResponse.ok ? await webhookResponse.json() : null;
      const streams = data.streams || [];
      if (!selected && streams[0]) selected = streams[0].streamId;
      renderStreams(streams);
      renderTotals(streams);
      renderWebhookStats(webhookStats);
      await renderDetail();
      status.textContent = new Date().toLocaleTimeString();
    }
    function renderStreams(streams) {
      const root = document.getElementById('streams');
      if (!streams.length) {
        root.innerHTML = '<div class="empty">No active streams</div>';
        return;
      }
      root.innerHTML = streams.map((stream) => {
        const state = stream.state || {};
        const cls = stream.streamId === selected ? 'stream active' : 'stream';
        return '<button class="' + cls + '" data-id="' + stream.streamId + '"><strong>' + stream.streamId + '</strong><span>' + (state.regionCode || 'unknown') + ' · ' + (state.state || 'unknown') + '</span></button>';
      }).join('');
      root.querySelectorAll('button').forEach((button) => {
        button.addEventListener('click', () => {
          selected = button.dataset.id;
          refresh();
        });
      });
    }
    function renderTotals(streams) {
      let audio = 0, video = 0, events = 0;
      for (const stream of streams) {
        audio += Number(stream.metrics?.audio_bytes_total || 0);
        video += Number(stream.metrics?.video_bytes_total || 0);
        events += (stream.events || []).length;
      }
      const latency = aggregateLatency(streams);
      document.getElementById('active').textContent = streams.filter(isActiveStream).length;
      document.getElementById('audio').textContent = formatMiB(audio);
      document.getElementById('video').textContent = formatMiB(video);
      document.getElementById('events').textContent = events.toLocaleString();
      renderLatencyCard('webhook_ingress_latency_ms', latency, 'webhookLatency', 'webhookLatencyRange');
      renderLatencyCard('signaling_ping_rtt_ms', latency, 'signalingLatency', 'signalingLatencyRange');
      renderLatencyTable(latency);
    }
    function aggregateLatency(streams) {
      const stats = {};
      for (const stream of streams) {
        for (const [name, value] of Object.entries(stream.latency || {})) {
          if (!value || !Number.isFinite(Number(value.count))) continue;
          const target = stats[name] || { name, count: 0, sumMs: 0, minMs: Infinity, maxMs: 0 };
          target.count += Number(value.count || 0);
          target.sumMs += Number(value.sumMs || 0);
          target.minMs = Math.min(target.minMs, Number(value.minMs));
          target.maxMs = Math.max(target.maxMs, Number(value.maxMs));
          stats[name] = target;
        }
      }
      for (const value of Object.values(stats)) {
        value.avgMs = value.count > 0 ? value.sumMs / value.count : 0;
        if (!Number.isFinite(value.minMs)) value.minMs = 0;
      }
      return stats;
    }
    function renderLatencyCard(name, stats, valueId, rangeId) {
      const value = stats[name];
      const valueElement = document.getElementById(valueId);
      const rangeElement = document.getElementById(rangeId);
      if (!value || !value.count) {
        valueElement.textContent = '-';
        rangeElement.textContent = 'low - / high -';
        return;
      }
      valueElement.textContent = formatMs(value.avgMs);
      rangeElement.textContent = 'low ' + formatMs(value.minMs) + ' / high ' + formatMs(value.maxMs);
    }
    function renderLatencyTable(stats) {
      const root = document.getElementById('latency');
      const rows = Object.values(stats).sort((a, b) => a.name.localeCompare(b.name));
      if (!rows.length) {
        root.innerHTML = '<div class="empty">No latency samples yet</div>';
        return;
      }
      root.innerHTML = '<table><thead><tr><th>Metric</th><th class="number">Lowest</th><th class="number">Highest</th><th class="number">Average</th><th class="number">Samples</th></tr></thead><tbody>' +
        rows.map((row) => '<tr><td>' + row.name + '</td><td class="number">' + formatMs(row.minMs) + '</td><td class="number">' + formatMs(row.maxMs) + '</td><td class="number">' + formatMs(row.avgMs) + '</td><td class="number">' + row.count.toLocaleString() + '</td></tr>').join('') +
        '</tbody></table>';
    }
    function renderWebhookStats(stats) {
      const root = document.getElementById('webhooks');
      const windows = stats?.windows || [];
      if (!windows.length) {
        root.innerHTML = '<div class="empty">No webhook observations yet</div>';
        return;
      }
      root.innerHTML = '<table><thead><tr><th>Window</th><th class="number">Total</th><th class="number">Unverified</th><th class="number">Duplicate</th><th class="number">Accepted</th></tr></thead><tbody>' +
        windows.map((window) => {
          const counts = window.counts || {};
          return '<tr><td>' + (window.label || window.key) + '</td><td class="number">' + formatCount(counts.total) + '</td><td class="number">' + formatCount(counts.unverified) + '</td><td class="number">' + formatCount(counts.duplicate) + '</td><td class="number">' + formatCount(counts.accepted) + '</td></tr>';
        }).join('') +
        '</tbody></table>';
    }
    function formatMs(value) {
      const number = Number(value || 0);
      if (number >= 1000) return (number / 1000).toFixed(2) + 's';
      return Math.round(number).toLocaleString() + 'ms';
    }
    function formatMiB(value) {
      const mib = Number(value || 0) / 1024 / 1024;
      if (mib >= 100) return Math.round(mib).toLocaleString();
      if (mib >= 10) return mib.toFixed(1);
      return mib.toFixed(2);
    }
    function formatCount(value) {
      return Number(value || 0).toLocaleString();
    }
    function isActiveStream(stream) {
      const state = String(stream?.state?.state || '').toLowerCase();
      return !['stopping', 'stopped', 'stop_requested', 'ended', 'failed', 'completed', 'dry_run_completed'].includes(state);
    }
    async function renderDetail() {
      const detail = document.getElementById('detail');
      if (!selected) {
        detail.textContent = '{}';
        return;
      }
      const response = await fetch('/streams/' + encodeURIComponent(selected));
      detail.textContent = response.ok ? JSON.stringify(await response.json(), null, 2) : '{}';
    }
    document.getElementById('refresh').addEventListener('click', refresh);
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

async function shutdown() {
  await store.close?.();
  await logger.stop?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
