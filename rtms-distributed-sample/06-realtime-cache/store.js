import { randomUUID } from 'crypto';

export class MemoryRealtimeCacheStore {
  constructor(options = {}) {
    this.backend = 'memory';
    this.defaultTtlSeconds = Number(options.defaultTtlSeconds || 7200);
    this.webhookStatsRetentionSeconds = Number(options.webhookStatsRetentionSeconds || 25 * 60 * 60);
    this.streams = new Map();
    this.nodes = new Map();
    this.webhookObservations = [];
  }

  async stats() {
    this.sweepExpired();
    return {
      streams: this.streams.size,
      nodes: this.nodes.size,
      webhookObservations: this.webhookObservations.length
    };
  }

  async listStreams() {
    this.sweepExpired();
    return Array.from(this.streams.values())
      .map((entry) => withDerivedLatency(entry.value))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  async getStream(streamId) {
    this.sweepExpired();
    const stream = this.streams.get(streamId)?.value || null;
    return withDerivedLatency(stream);
  }

  async upsertState(streamId, state, ttlSeconds) {
    const stream = this.getOrCreateStream(streamId, ttlSeconds);
    stream.state = {
      ...(stream.state || {}),
      ...state
    };
    stream.updatedAt = new Date().toISOString();
    this.touchStream(streamId, ttlSeconds);
    return stream;
  }

  async putSummary(streamId, summary, ttlSeconds) {
    const stream = this.getOrCreateStream(streamId, ttlSeconds);
    stream.summary = {
      ...(stream.summary || {}),
      ...summary,
      updatedAt: summary.updatedAt || new Date().toISOString()
    };
    stream.updatedAt = new Date().toISOString();
    this.touchStream(streamId, ttlSeconds);
    return stream;
  }

  async putMetrics(streamId, metrics, ttlSeconds) {
    const stream = this.getOrCreateStream(streamId, ttlSeconds);
    stream.metrics = mergeMetrics(stream.metrics || {}, metrics || {});
    stream.updatedAt = new Date().toISOString();
    this.touchStream(streamId, ttlSeconds);
    return stream;
  }

  async putLatencySample(streamId, sample, ttlSeconds) {
    const stream = this.getOrCreateStream(streamId, ttlSeconds);
    stream.latency = mergeLatencySample(stream.latency || {}, sample || {});
    stream.updatedAt = new Date().toISOString();
    this.touchStream(streamId, ttlSeconds);
    return stream;
  }

  async putParticipants(streamId, participants, ttlSeconds) {
    const stream = this.getOrCreateStream(streamId, ttlSeconds);
    stream.participants = participants;
    stream.updatedAt = new Date().toISOString();
    this.touchStream(streamId, ttlSeconds);
    return stream;
  }

  async appendEvent(streamId, event, options = {}) {
    const stream = this.getOrCreateStream(streamId, options.ttlSeconds);
    stream.events = stream.events || [];
    const eventWithTimestamp = {
      ...event,
      at: event.at || new Date().toISOString()
    };
    stream.events.push(eventWithTimestamp);
    stream.latency = mergeLatencyFromEvent(stream.latency || {}, eventWithTimestamp);
    const maxEvents = Number(options.maxEvents || 100);
    if (stream.events.length > maxEvents) {
      stream.events.splice(0, stream.events.length - maxEvents);
    }
    stream.updatedAt = new Date().toISOString();
    this.touchStream(streamId, options.ttlSeconds);
    return stream;
  }

  async putNodeHealth(nodeId, health, ttlSeconds) {
    const node = {
      nodeId,
      ...health,
      updatedAt: new Date().toISOString()
    };
    this.nodes.set(nodeId, {
      expiresAt: Date.now() + secondsToMs(ttlSeconds || this.defaultTtlSeconds),
      value: node
    });
    return node;
  }

  async recordWebhookObservation(observation) {
    const normalized = normalizeWebhookObservation(observation);
    this.webhookObservations.push(normalized);
    this.sweepExpiredWebhookObservations();
    return this.webhookStats();
  }

  async webhookStats() {
    this.sweepExpiredWebhookObservations();
    return buildWebhookStats((category, cutoffMs, nowMs) => (
      this.webhookObservations.filter((observation) => (
        observation.category === category &&
        observation.timestampMs >= cutoffMs &&
        observation.timestampMs <= nowMs
      )).length
    ));
  }

  async prometheusMetrics() {
    const streams = await this.listStreams();
    const webhookStats = await this.webhookStats();
    return renderPrometheusMetrics(streams, this.nodes.size, webhookStats);
  }

  async close() {}

  getOrCreateStream(streamId, ttlSeconds) {
    const existing = this.streams.get(streamId)?.value;
    if (existing) return existing;

    const stream = {
      streamId,
      state: {},
      summary: null,
      metrics: {},
      latency: {},
      participants: null,
      events: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.streams.set(streamId, {
      expiresAt: Date.now() + secondsToMs(ttlSeconds || this.defaultTtlSeconds),
      value: stream
    });
    return stream;
  }

  touchStream(streamId, ttlSeconds) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    entry.expiresAt = Date.now() + secondsToMs(ttlSeconds || this.defaultTtlSeconds);
  }

  sweepExpired() {
    const now = Date.now();
    for (const [streamId, entry] of this.streams.entries()) {
      if (entry.expiresAt <= now) this.streams.delete(streamId);
    }
    for (const [nodeId, entry] of this.nodes.entries()) {
      if (entry.expiresAt <= now) this.nodes.delete(nodeId);
    }
    this.sweepExpiredWebhookObservations();
  }

  sweepExpiredWebhookObservations() {
    const cutoffMs = Date.now() - secondsToMs(this.webhookStatsRetentionSeconds);
    this.webhookObservations = this.webhookObservations.filter((observation) => observation.timestampMs >= cutoffMs);
  }
}

export class RedisRealtimeCacheStore {
  static async create(options = {}) {
    const { createClient } = await import('redis');
    const client = createClient({
      url: options.url,
      password: options.password
    });
    client.on('error', (error) => {
      console.warn(`[06-realtime-cache] redis error: ${error.message}`);
    });
    await client.connect();
    return new RedisRealtimeCacheStore({ ...options, client });
  }

  constructor(options = {}) {
    this.backend = 'redis';
    this.client = options.client;
    this.defaultTtlSeconds = Number(options.defaultTtlSeconds || 7200);
    this.webhookStatsRetentionSeconds = Number(options.webhookStatsRetentionSeconds || 25 * 60 * 60);
  }

  async stats() {
    return {
      streams: await this.client.sCard(key('index', 'streams')),
      nodes: await this.client.sCard(key('index', 'nodes')),
      webhookObservations: Number(await this.client.sendCommand(['ZCARD', webhookObservationKey('all')]))
    };
  }

  async listStreams() {
    const streamIds = await this.client.sMembers(key('index', 'streams'));
    const streams = [];
    for (const streamId of streamIds) {
      const stream = await this.getStream(streamId);
      if (stream) streams.push(stream);
      else await this.client.sRem(key('index', 'streams'), streamId);
    }
    return streams.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  async getStream(streamId) {
    const raw = await this.client.get(streamKey(streamId));
    return raw ? withDerivedLatency(JSON.parse(raw)) : null;
  }

  async upsertState(streamId, state, ttlSeconds) {
    const stream = await this.getOrCreateStream(streamId);
    stream.state = {
      ...(stream.state || {}),
      ...state
    };
    stream.updatedAt = new Date().toISOString();
    await this.saveStream(stream, ttlSeconds);
    return stream;
  }

  async putSummary(streamId, summary, ttlSeconds) {
    const stream = await this.getOrCreateStream(streamId);
    stream.summary = {
      ...(stream.summary || {}),
      ...summary,
      updatedAt: summary.updatedAt || new Date().toISOString()
    };
    stream.updatedAt = new Date().toISOString();
    await this.saveStream(stream, ttlSeconds);
    return stream;
  }

  async putMetrics(streamId, metrics, ttlSeconds) {
    const stream = await this.getOrCreateStream(streamId);
    stream.metrics = mergeMetrics(stream.metrics || {}, metrics || {});
    stream.updatedAt = new Date().toISOString();
    await this.saveStream(stream, ttlSeconds);
    return stream;
  }

  async putLatencySample(streamId, sample, ttlSeconds) {
    const stream = await this.getOrCreateStream(streamId);
    stream.latency = mergeLatencySample(stream.latency || {}, sample || {});
    stream.updatedAt = new Date().toISOString();
    await this.saveStream(stream, ttlSeconds);
    return stream;
  }

  async putParticipants(streamId, participants, ttlSeconds) {
    const stream = await this.getOrCreateStream(streamId);
    stream.participants = participants;
    stream.updatedAt = new Date().toISOString();
    await this.saveStream(stream, ttlSeconds);
    return stream;
  }

  async appendEvent(streamId, event, options = {}) {
    const stream = await this.getOrCreateStream(streamId);
    stream.events = stream.events || [];
    const eventWithTimestamp = {
      ...event,
      at: event.at || new Date().toISOString()
    };
    stream.events.push(eventWithTimestamp);
    stream.latency = mergeLatencyFromEvent(stream.latency || {}, eventWithTimestamp);
    const maxEvents = Number(options.maxEvents || 100);
    if (stream.events.length > maxEvents) {
      stream.events.splice(0, stream.events.length - maxEvents);
    }
    stream.updatedAt = new Date().toISOString();
    await this.saveStream(stream, options.ttlSeconds);
    return stream;
  }

  async putNodeHealth(nodeId, health, ttlSeconds) {
    const node = {
      nodeId,
      ...health,
      updatedAt: new Date().toISOString()
    };
    await this.client.sAdd(key('index', 'nodes'), nodeId);
    await this.client.set(nodeKey(nodeId), JSON.stringify(node), {
      EX: Number(ttlSeconds || this.defaultTtlSeconds)
    });
    return node;
  }

  async recordWebhookObservation(observation) {
    const normalized = normalizeWebhookObservation(observation);
    const member = `${normalized.timestampMs}:${randomUUID()}`;
    await this.client.sendCommand(['ZADD', webhookObservationKey(normalized.category), String(normalized.timestampMs), member]);
    if (normalized.category !== 'total') {
      await this.client.sendCommand(['ZADD', webhookObservationKey('all'), String(normalized.timestampMs), `${member}:all`]);
    }
    await this.cleanupWebhookObservations();
    return this.webhookStats();
  }

  async webhookStats() {
    await this.cleanupWebhookObservations();
    return buildWebhookStats(async (category, cutoffMs, nowMs) => (
      Number(await this.client.sendCommand(['ZCOUNT', webhookObservationKey(category), String(cutoffMs), String(nowMs)]))
    ));
  }

  async prometheusMetrics() {
    const streams = await this.listStreams();
    const nodeCount = await this.client.sCard(key('index', 'nodes'));
    const webhookStats = await this.webhookStats();
    return renderPrometheusMetrics(streams, nodeCount, webhookStats);
  }

  async close() {
    await this.client.quit();
  }

  async getOrCreateStream(streamId) {
    const existing = await this.getStream(streamId);
    if (existing) return existing;
    return {
      streamId,
      state: {},
      summary: null,
      metrics: {},
      latency: {},
      participants: null,
      events: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async saveStream(stream, ttlSeconds) {
    const ttl = Number(ttlSeconds || this.defaultTtlSeconds);
    await this.client.sAdd(key('index', 'streams'), stream.streamId);
    if (stream.state?.regionCode) {
      await this.client.sAdd(key('index', 'regions'), stream.state.regionCode);
      await this.client.sAdd(key('region', stream.state.regionCode, 'streams'), stream.streamId);
    }
    await this.client.set(streamKey(stream.streamId), JSON.stringify(stream), { EX: ttl });
  }

  async cleanupWebhookObservations() {
    const cutoffMs = Date.now() - secondsToMs(this.webhookStatsRetentionSeconds);
    await Promise.all(WEBHOOK_OBSERVATION_CATEGORIES.map((category) => (
      this.client.sendCommand(['ZREMRANGEBYSCORE', webhookObservationKey(category), '-inf', String(cutoffMs)])
    )));
  }
}

const WEBHOOK_STATS_WINDOWS = [
  { key: '1m', label: 'Past minute', seconds: 60 },
  { key: '60m', label: 'Past 60 minutes', seconds: 60 * 60 },
  { key: '24h', label: 'Past 24 hours', seconds: 24 * 60 * 60 }
];
const WEBHOOK_STATS_CATEGORIES = ['total', 'accepted', 'unverified', 'duplicate', 'concurrency_limited'];
const WEBHOOK_OBSERVATION_CATEGORIES = [...WEBHOOK_STATS_CATEGORIES, 'all'];

function renderPrometheusMetrics(streams, nodeCount, webhookStats = emptyWebhookStats()) {
  const activeStreams = streams.filter(isActiveStream);
  const lines = [
    '# HELP rtms_realtime_active_streams Active streams in realtime cache.',
    '# TYPE rtms_realtime_active_streams gauge',
    `rtms_realtime_active_streams ${activeStreams.length}`,
    '# HELP rtms_realtime_nodes Nodes with recent health snapshots.',
    '# TYPE rtms_realtime_nodes gauge',
    `rtms_realtime_nodes ${nodeCount}`,
    '# HELP rtms_realtime_active_streams_by_region Active streams by region.',
    '# TYPE rtms_realtime_active_streams_by_region gauge'
  ];
  const byRegion = new Map();
  const metricSums = new Map();
  const latencyByRegion = new Map();

  for (const stream of streams) {
    const region = sanitizeLabelValue(stream.state?.regionCode || firstLatencyRegion(stream.latency) || 'unknown');
    if (isActiveStream(stream)) {
      byRegion.set(region, Number(byRegion.get(region) || 0) + 1);
    }

    for (const [name, value] of Object.entries(stream.metrics || {})) {
      if (!Number.isFinite(Number(value))) continue;
      const keyName = `${region}\n${sanitizeLabelValue(name)}`;
      metricSums.set(keyName, Number(metricSums.get(keyName) || 0) + Number(value));
    }

    for (const [name, value] of Object.entries(stream.latency || {})) {
      const stat = normalizeLatencyStat(value);
      if (!stat) continue;
      const keyName = `${region}\n${sanitizeLabelValue(name)}`;
      latencyByRegion.set(keyName, mergeLatencyStat(latencyByRegion.get(keyName), stat));
    }
  }

  for (const [region, count] of byRegion.entries()) {
    lines.push(`rtms_realtime_active_streams_by_region{region="${region}"} ${count}`);
  }

  lines.push('# HELP rtms_realtime_metric_sum Numeric realtime metric sum by region and name.');
  lines.push('# TYPE rtms_realtime_metric_sum gauge');
  for (const [compoundKey, value] of metricSums.entries()) {
    const [region, name] = compoundKey.split('\n');
    lines.push(`rtms_realtime_metric_sum{region="${region}",metric="${name}"} ${value}`);
  }

  lines.push('# HELP rtms_realtime_latency_min_ms Lowest latency sample in milliseconds.');
  lines.push('# TYPE rtms_realtime_latency_min_ms gauge');
  for (const [compoundKey, stat] of latencyByRegion.entries()) {
    const [region, name] = compoundKey.split('\n');
    lines.push(`rtms_realtime_latency_min_ms{region="${region}",metric="${name}"} ${stat.minMs}`);
  }

  lines.push('# HELP rtms_realtime_latency_max_ms Highest latency sample in milliseconds.');
  lines.push('# TYPE rtms_realtime_latency_max_ms gauge');
  for (const [compoundKey, stat] of latencyByRegion.entries()) {
    const [region, name] = compoundKey.split('\n');
    lines.push(`rtms_realtime_latency_max_ms{region="${region}",metric="${name}"} ${stat.maxMs}`);
  }

  lines.push('# HELP rtms_realtime_latency_avg_ms Average latency sample in milliseconds.');
  lines.push('# TYPE rtms_realtime_latency_avg_ms gauge');
  for (const [compoundKey, stat] of latencyByRegion.entries()) {
    const [region, name] = compoundKey.split('\n');
    lines.push(`rtms_realtime_latency_avg_ms{region="${region}",metric="${name}"} ${stat.avgMs}`);
  }

  lines.push('# HELP rtms_realtime_latency_samples_total Latency sample count.');
  lines.push('# TYPE rtms_realtime_latency_samples_total counter');
  for (const [compoundKey, stat] of latencyByRegion.entries()) {
    const [region, name] = compoundKey.split('\n');
    lines.push(`rtms_realtime_latency_samples_total{region="${region}",metric="${name}"} ${stat.count}`);
  }

  lines.push('# HELP rtms_webhook_observations_window Rolling webhook observation count by category and window.');
  lines.push('# TYPE rtms_webhook_observations_window gauge');
  for (const window of webhookStats.windows || []) {
    for (const [category, value] of Object.entries(window.counts || {})) {
      lines.push(`rtms_webhook_observations_window{window="${sanitizeLabelValue(window.key)}",category="${sanitizeLabelValue(category)}"} ${Number(value || 0)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function buildWebhookStats(countFn) {
  const nowMs = Date.now();
  const windows = [];

  for (const window of WEBHOOK_STATS_WINDOWS) {
    const cutoffMs = nowMs - secondsToMs(window.seconds);
    const counts = {
      accepted: Number(await countFn('accepted', cutoffMs, nowMs)) || 0,
      unverified: Number(await countFn('unverified', cutoffMs, nowMs)) || 0,
      duplicate: Number(await countFn('duplicate', cutoffMs, nowMs)) || 0,
      concurrency_limited: Number(await countFn('concurrency_limited', cutoffMs, nowMs)) || 0
    };
    const explicitTotal = Number(await countFn('total', cutoffMs, nowMs)) || 0;
    const allTotal = Number(await countFn('all', cutoffMs, nowMs)) || 0;
    counts.total = explicitTotal || allTotal || counts.accepted + counts.unverified + counts.duplicate;
    windows.push({
      ...window,
      cutoffAt: new Date(cutoffMs).toISOString(),
      counts
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windows
  };
}

function emptyWebhookStats() {
  return {
    generatedAt: new Date().toISOString(),
    windows: WEBHOOK_STATS_WINDOWS.map((window) => ({
      ...window,
      cutoffAt: new Date(Date.now() - secondsToMs(window.seconds)).toISOString(),
      counts: Object.fromEntries(WEBHOOK_STATS_CATEGORIES.map((category) => [category, 0]))
    }))
  };
}

function normalizeWebhookObservation(observation = {}) {
  const rawCategory = String(observation.category || observation.status || observation.type || 'total').toLowerCase();
  const category = WEBHOOK_STATS_CATEGORIES.includes(rawCategory) ? rawCategory : 'total';
  const timestampMs = parseTimestampMs(observation.at || observation.receivedAt || observation.timestampMs) || Date.now();

  return {
    category,
    timestampMs,
    event: sanitizeSmallValue(observation.event || 'unknown'),
    eventType: sanitizeSmallValue(observation.eventType || ''),
    reason: sanitizeSmallValue(observation.reason || ''),
    source: sanitizeSmallValue(observation.source || ''),
    regionCode: sanitizeSmallValue(observation.regionCode || ''),
    streamId: sanitizeSmallValue(observation.streamId || '')
  };
}

function parseTimestampMs(value) {
  if (Number.isFinite(Number(value))) {
    const number = Number(value);
    return number > 0 ? number : null;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeSmallValue(value) {
  return String(value || '').replace(/[\n\r]/g, ' ').slice(0, 200);
}

function mergeMetrics(current, incoming) {
  const merged = { ...current };
  for (const [name, value] of Object.entries(incoming || {})) {
    if (Number.isFinite(Number(value)) && Number.isFinite(Number(merged[name]))) {
      merged[name] = Number(merged[name]) + Number(value);
    } else {
      merged[name] = value;
    }
  }
  return merged;
}

function mergeLatencySample(current, incoming) {
  const name = normalizeMetricName(incoming.name || incoming.metric || incoming.key || 'latency_ms');
  const valueMs = Number(incoming.valueMs ?? incoming.latencyMs ?? incoming.rttMs ?? incoming.value ?? incoming.ms);
  if (!Number.isFinite(valueMs) || valueMs < 0) return { ...current };

  const existing = normalizeLatencyStat(current[name]) || {
    name,
    unit: 'ms',
    count: 0,
    sumMs: 0,
    minMs: valueMs,
    maxMs: valueMs,
    avgMs: valueMs,
    lastMs: valueMs
  };
  const count = Number(existing.count || 0) + 1;
  const sumMs = Number(existing.sumMs || 0) + valueMs;
  const minMs = Math.min(Number(existing.minMs), valueMs);
  const maxMs = Math.max(Number(existing.maxMs), valueMs);

  return {
    ...current,
    [name]: {
      ...existing,
      name,
      unit: 'ms',
      count,
      sumMs,
      minMs,
      maxMs,
      avgMs: sumMs / count,
      lastMs: valueMs,
      source: incoming.source || existing.source || '',
      regionCode: incoming.regionCode || existing.regionCode || '',
      nodeId: incoming.nodeId || existing.nodeId || '',
      at: incoming.at || new Date().toISOString(),
      labels: {
        ...(existing.labels || {}),
        ...(incoming.labels || {})
      }
    }
  };
}

function isActiveStream(stream) {
  const state = String(stream?.state?.state || '').toLowerCase();
  if (!state) return true;
  return !new Set([
    'stopping',
    'stopped',
    'stop_requested',
    'ended',
    'failed',
    'completed',
    'dry_run_completed'
  ]).has(state);
}

function mergeLatencyFromEvent(current, event) {
  const samples = latencySamplesFromEvent(event);
  if (!samples.length) return current;

  let merged = { ...current };
  for (const sample of samples) {
    merged = mergeLatencySample(merged, sample);
  }
  return merged;
}

function withDerivedLatency(stream) {
  if (!stream) return null;
  const derived = deriveLatencyFromEvents(stream.events || []);
  if (!Object.keys(derived).length) return stream;

  const latency = { ...(stream.latency || {}) };
  for (const [name, value] of Object.entries(derived)) {
    if (!normalizeLatencyStat(latency[name])) {
      latency[name] = value;
    }
  }
  return {
    ...stream,
    latency
  };
}

function deriveLatencyFromEvents(events) {
  let latency = {};
  for (const event of events || []) {
    latency = mergeLatencyFromEvent(latency, event);
  }
  return latency;
}

function latencySamplesFromEvent(event = {}) {
  const samples = [];

  const webhookLatencyMs = Number(event.webhookIngressLatencyMs);
  if (Number.isFinite(webhookLatencyMs) && webhookLatencyMs >= 0) {
    samples.push({
      name: 'webhook_ingress_latency_ms',
      valueMs: webhookLatencyMs,
      source: 'centralized-webhook-hub',
      regionCode: event.regionCode,
      nodeId: event.nodeId,
      at: event.at,
      labels: {
        event: event.event,
        eventType: event.eventType,
        productType: event.productType
      }
    });
  }

  const rttMs = Number(event.rttMs);
  if (event.type === 'signaling_ping_rtt' && Number.isFinite(rttMs) && rttMs >= 0) {
    samples.push({
      name: 'signaling_ping_rtt_ms',
      valueMs: rttMs,
      source: 'rtmsmanager.signaling',
      regionCode: event.regionCode,
      nodeId: event.nodeId,
      at: event.at,
      labels: {
        signalingHost: event.signalingHost
      }
    });
  }

  return samples;
}

function normalizeLatencyStat(value) {
  if (!value || typeof value !== 'object') return null;
  const count = Number(value.count || 0);
  const sumMs = Number(value.sumMs || 0);
  const minMs = Number(value.minMs);
  const maxMs = Number(value.maxMs);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(sumMs) || !Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    return null;
  }

  return {
    ...value,
    count,
    sumMs,
    minMs,
    maxMs,
    avgMs: Number.isFinite(Number(value.avgMs)) ? Number(value.avgMs) : sumMs / count,
    lastMs: Number.isFinite(Number(value.lastMs)) ? Number(value.lastMs) : null
  };
}

function mergeLatencyStat(current, incoming) {
  if (!current) return { ...incoming };
  const count = Number(current.count || 0) + Number(incoming.count || 0);
  const sumMs = Number(current.sumMs || 0) + Number(incoming.sumMs || 0);
  return {
    count,
    sumMs,
    minMs: Math.min(Number(current.minMs), Number(incoming.minMs)),
    maxMs: Math.max(Number(current.maxMs), Number(incoming.maxMs)),
    avgMs: count > 0 ? sumMs / count : 0
  };
}

function firstLatencyRegion(latency) {
  for (const value of Object.values(latency || {})) {
    if (value?.regionCode) return value.regionCode;
  }
  return null;
}

function normalizeMetricName(value) {
  return String(value || 'latency_ms').replace(/[^a-zA-Z0-9_:.-]/g, '_').slice(0, 120);
}

function key(...parts) {
  return ['rtms', ...parts.map((part) => String(part).replace(/[^a-zA-Z0-9._:-]/g, '-'))].join(':');
}

function streamKey(streamId) {
  return key('stream', streamId);
}

function nodeKey(nodeId) {
  return key('node', nodeId, 'health');
}

function webhookObservationKey(category) {
  return key('webhook', 'observations', category);
}

function secondsToMs(seconds) {
  return Number(seconds || 0) * 1000;
}

function sanitizeLabelValue(value) {
  return String(value || 'unknown').replace(/["\\\n\r]/g, '_').slice(0, 120);
}
