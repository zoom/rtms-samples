import { fireAndForget, getJson, postJson } from './http.js';

export async function postRealtimeStreamState(realtimeCacheUrl, streamId, state, options = {}) {
  if (!realtimeCacheUrl || !streamId) return null;
  return postJson(`${baseUrl(realtimeCacheUrl)}/streams/${encodeURIComponent(streamId)}/state`, state, {
    timeoutMs: options.timeoutMs || 1500,
    retryPolicy: options.retryPolicy || { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 }
  });
}

export async function postRealtimeSummary(realtimeCacheUrl, streamId, summary, options = {}) {
  if (!realtimeCacheUrl || !streamId) return null;
  return postJson(`${baseUrl(realtimeCacheUrl)}/streams/${encodeURIComponent(streamId)}/summary`, summary, {
    timeoutMs: options.timeoutMs || 1500,
    retryPolicy: options.retryPolicy || { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 }
  });
}

export async function postRealtimeMetrics(realtimeCacheUrl, streamId, metrics, options = {}) {
  if (!realtimeCacheUrl || !streamId) return null;
  return postJson(`${baseUrl(realtimeCacheUrl)}/streams/${encodeURIComponent(streamId)}/metrics`, { metrics }, {
    timeoutMs: options.timeoutMs || 1500,
    retryPolicy: options.retryPolicy || { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 }
  });
}

export async function postRealtimeLatencySample(realtimeCacheUrl, streamId, latency, options = {}) {
  if (!realtimeCacheUrl || !streamId) return null;
  return postJson(`${baseUrl(realtimeCacheUrl)}/streams/${encodeURIComponent(streamId)}/latency`, latency, {
    timeoutMs: options.timeoutMs || 1500,
    retryPolicy: options.retryPolicy || { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 }
  });
}

export async function postRealtimeEvent(realtimeCacheUrl, streamId, event, options = {}) {
  if (!realtimeCacheUrl || !streamId) return null;
  return postJson(`${baseUrl(realtimeCacheUrl)}/streams/${encodeURIComponent(streamId)}/events`, event, {
    timeoutMs: options.timeoutMs || 1500,
    retryPolicy: options.retryPolicy || { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 }
  });
}

export async function postWebhookObservation(realtimeCacheUrl, observation, options = {}) {
  if (!realtimeCacheUrl) return null;
  return postJson(`${baseUrl(realtimeCacheUrl)}/webhooks/observations`, observation || {}, {
    timeoutMs: options.timeoutMs || 1000,
    retryPolicy: options.retryPolicy || { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 250 }
  });
}

export async function getRealtimeStream(realtimeCacheUrl, streamId, options = {}) {
  if (!realtimeCacheUrl || !streamId) return null;
  return getJson(`${baseUrl(realtimeCacheUrl)}/streams/${encodeURIComponent(streamId)}`, {
    timeoutMs: options.timeoutMs || 1500,
    retryPolicy: options.retryPolicy || { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500 }
  });
}

export class RealtimeMetricsReporter {
  constructor(options = {}) {
    this.url = options.url || '';
    this.flushIntervalMs = Number(options.flushIntervalMs || 5000);
    this.buffer = new Map();
    this.timer = null;

    if (this.url && this.flushIntervalMs > 0) {
      this.timer = setInterval(() => {
        fireAndForget(this.flush(), 'realtime metrics flush');
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  recordMedia(streamId, mediaType, event = {}) {
    if (!this.url || !streamId || !mediaType) return;
    const key = String(streamId);
    const metrics = this.buffer.get(key) || {};
    increment(metrics, `${mediaType}_packets_total`, 1);
    increment(metrics, `${mediaType}_bytes_total`, event.buffer?.length || event.bytes || 0);
    metrics.last_media_type = mediaType;
    metrics.last_media_timestamp = event.timestamp || Date.now();
    metrics.last_user_id = event.userId || '';
    metrics.last_user_name = event.userName || '';
    this.buffer.set(key, metrics);
  }

  recordCounter(streamId, name, value = 1) {
    if (!this.url || !streamId || !name) return;
    const key = String(streamId);
    const metrics = this.buffer.get(key) || {};
    increment(metrics, name, value);
    this.buffer.set(key, metrics);
  }

  recordLatency(streamId, name, valueMs, options = {}) {
    if (!this.url || !streamId || !name || !Number.isFinite(Number(valueMs))) return;
    fireAndForget(postRealtimeLatencySample(this.url, streamId, {
      name,
      valueMs: Number(valueMs),
      source: options.source || 'regional-compute-job',
      regionCode: options.regionCode,
      nodeId: options.nodeId,
      at: options.at || new Date().toISOString(),
      labels: options.labels || undefined
    }), `realtime latency ${name}`);
  }

  async flush() {
    if (!this.url || this.buffer.size === 0) return;
    const entries = Array.from(this.buffer.entries());
    this.buffer.clear();

    await Promise.allSettled(entries.map(([streamId, metrics]) => (
      postRealtimeMetrics(this.url, streamId, metrics)
    )));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function increment(metrics, name, value) {
  metrics[name] = Number(metrics[name] || 0) + Number(value || 0);
}

function baseUrl(value) {
  return String(value).replace(/\/+$/, '');
}
