import fetch from 'node-fetch';

const LOG_LEVELS = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

export function createRtmsObservabilityLogger(options = {}) {
  return new RtmsObservabilityLogger(options);
}

class RtmsObservabilityLogger {
  constructor(options = {}) {
    this.level = normalizeLevel(options.level || process.env.RTMS_LOG_LEVEL || 'info');
    this.consoleEnabled = options.console !== false;
    this.lokiUrl = options.lokiUrl || process.env.LOKI_PUSH_URL || '';
    this.labels = sanitizeLabels({
      service: options.service || 'rtms-compute-job',
      region: options.regionCode || process.env.SPOKE_REGION || 'unknown',
      node: options.nodeId || process.env.SPOKE_NODE_ID || 'unknown',
      ...options.labels
    });
    this.buffer = [];
    this.flushIntervalMs = Number(options.flushIntervalMs || process.env.LOKI_FLUSH_INTERVAL_MS || 2000);
    this.maxBufferSize = Number(options.maxBufferSize || 100);
    this.timer = null;

    if (this.lokiUrl) {
      this.timer = setInterval(() => {
        this.flush().catch((error) => {
          if (this.consoleEnabled) {
            console.warn(`[rtms-observability-logger] Loki flush failed: ${error.message}`);
          }
        });
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  debug(...args) {
    this.write('debug', args);
  }

  info(...args) {
    this.write('info', args);
  }

  log(...args) {
    this.info(...args);
  }

  warn(...args) {
    this.write('warn', args);
  }

  error(...args) {
    this.write('error', args);
  }

  write(level, args) {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date();
    const message = formatMessage(args);
    const entry = {
      ts: timestamp.toISOString(),
      level,
      ...this.labels,
      message
    };

    if (this.consoleEnabled) {
      const line = JSON.stringify(entry);
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }

    if (this.lokiUrl) {
      this.buffer.push([String(BigInt(timestamp.getTime()) * 1000000n), JSON.stringify(entry)]);
      if (this.buffer.length >= this.maxBufferSize) {
        this.flush().catch((error) => {
          if (this.consoleEnabled) {
            console.warn(`[rtms-observability-logger] Loki flush failed: ${error.message}`);
          }
        });
      }
    }
  }

  shouldLog(level) {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.level];
  }

  async flush() {
    if (!this.lokiUrl || this.buffer.length === 0) return;
    const values = this.buffer.splice(0, this.buffer.length);
    const response = await fetch(this.lokiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streams: [
          {
            stream: {
              ...this.labels,
              job: 'rtms-compute'
            },
            values
          }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Loki returned ${response.status}: ${text}`);
    }
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

function normalizeLevel(value) {
  const level = String(value || 'info').toLowerCase();
  return Object.hasOwn(LOG_LEVELS, level) ? level : 'info';
}

function formatMessage(args) {
  return args.map((value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'object' && value !== null) {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }).join(' ');
}

function sanitizeLabels(labels) {
  const result = {};
  for (const [key, value] of Object.entries(labels || {})) {
    if (value === undefined || value === null || value === '') continue;
    result[sanitizeLabelName(key)] = sanitizeLabelValue(value);
  }
  return result;
}

function sanitizeLabelName(value) {
  return String(value).replace(/[^a-zA-Z0-9_]/g, '_');
}

function sanitizeLabelValue(value) {
  return String(value).replace(/[\n\r\t]/g, ' ').slice(0, 200);
}
