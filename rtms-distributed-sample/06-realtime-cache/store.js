export class MemoryRealtimeCacheStore {
  constructor(options = {}) {
    this.backend = 'memory';
    this.defaultTtlSeconds = Number(options.defaultTtlSeconds || 7200);
    this.streams = new Map();
    this.nodes = new Map();
  }

  async stats() {
    this.sweepExpired();
    return {
      streams: this.streams.size,
      nodes: this.nodes.size
    };
  }

  async listStreams() {
    this.sweepExpired();
    return Array.from(this.streams.values())
      .map((entry) => entry.value)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  async getStream(streamId) {
    this.sweepExpired();
    return this.streams.get(streamId)?.value || null;
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
    stream.events.push({
      ...event,
      at: event.at || new Date().toISOString()
    });
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

  async prometheusMetrics() {
    const streams = await this.listStreams();
    return renderPrometheusMetrics(streams, this.nodes.size);
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
  }

  async stats() {
    return {
      streams: await this.client.sCard(key('index', 'streams')),
      nodes: await this.client.sCard(key('index', 'nodes'))
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
    return raw ? JSON.parse(raw) : null;
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
    stream.events.push({
      ...event,
      at: event.at || new Date().toISOString()
    });
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

  async prometheusMetrics() {
    const streams = await this.listStreams();
    const nodeCount = await this.client.sCard(key('index', 'nodes'));
    return renderPrometheusMetrics(streams, nodeCount);
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
}

function renderPrometheusMetrics(streams, nodeCount) {
  const lines = [
    '# HELP rtms_realtime_active_streams Active streams in realtime cache.',
    '# TYPE rtms_realtime_active_streams gauge',
    `rtms_realtime_active_streams ${streams.length}`,
    '# HELP rtms_realtime_nodes Nodes with recent health snapshots.',
    '# TYPE rtms_realtime_nodes gauge',
    `rtms_realtime_nodes ${nodeCount}`,
    '# HELP rtms_realtime_active_streams_by_region Active streams by region.',
    '# TYPE rtms_realtime_active_streams_by_region gauge'
  ];
  const byRegion = new Map();
  const metricSums = new Map();

  for (const stream of streams) {
    const region = sanitizeLabelValue(stream.state?.regionCode || 'unknown');
    byRegion.set(region, Number(byRegion.get(region) || 0) + 1);

    for (const [name, value] of Object.entries(stream.metrics || {})) {
      if (!Number.isFinite(Number(value))) continue;
      const keyName = `${region}\n${sanitizeLabelValue(name)}`;
      metricSums.set(keyName, Number(metricSums.get(keyName) || 0) + Number(value));
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

  return `${lines.join('\n')}\n`;
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

function key(...parts) {
  return ['rtms', ...parts.map((part) => String(part).replace(/[^a-zA-Z0-9._:-]/g, '-'))].join(':');
}

function streamKey(streamId) {
  return key('stream', streamId);
}

function nodeKey(nodeId) {
  return key('node', nodeId, 'health');
}

function secondsToMs(seconds) {
  return Number(seconds || 0) * 1000;
}

function sanitizeLabelValue(value) {
  return String(value || 'unknown').replace(/["\\\n\r]/g, '_').slice(0, 120);
}
