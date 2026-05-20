import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export class SqliteRoutingStore {
  constructor(dbPath, options = {}) {
    this.dbPath = resolveDbPath(dbPath || options.dbPath || '.data/rtms-routing.sqlite');
    ensureDbDir(this.dbPath);
    this.db = new Database(this.dbPath);
    configureDatabase(this.db, options);
    this.prepareSchema();
    this.prepareStatements();
  }

  health() {
    return {
      dbPath: this.dbPath,
      journalMode: this.db.pragma('journal_mode', { simple: true })
    };
  }

  acceptWebhookIdempotency(record = {}) {
    const idempotencyKey = record.idempotencyKey || record.key;
    const ttlMs = Number(record.ttlMs || 0);
    if (!idempotencyKey || ttlMs <= 0) {
      return { accepted: true, duplicate: false, disabled: true };
    }

    const nowMs = Date.now();
    const expiresAtMs = nowMs + ttlMs;
    this.cleanupExpiredWebhookIdempotency(nowMs);

    const result = this.insertIdempotency.run({
      idempotencyKey,
      event: record.event || 'unknown',
      streamId: record.streamId || null,
      rtmsId: record.rtmsId || null,
      acceptedAt: new Date(nowMs).toISOString(),
      acceptedAtMs: nowMs,
      expiresAtMs
    });

    return {
      accepted: result.changes === 1,
      duplicate: result.changes === 0
    };
  }

  forgetWebhookIdempotency(idempotencyKey) {
    if (!idempotencyKey) return;
    this.deleteIdempotency.run(idempotencyKey);
  }

  cleanupExpiredWebhookIdempotency(nowMs = Date.now()) {
    return this.deleteExpiredIdempotency.run(nowMs).changes;
  }

  countWebhookIdempotency() {
    this.cleanupExpiredWebhookIdempotency();
    return this.countIdempotency.get().count;
  }

  upsertStreamRoute(streamId, route = {}) {
    if (!streamId) throw new Error('streamId is required');

    const now = new Date().toISOString();
    const existing = this.getStreamRoute(streamId);
    const routeRecord = {
      streamId,
      regionCode: route.regionCode || existing?.regionCode || 'UNKNOWN',
      spokeGroup: route.spokeGroup || existing?.spokeGroup || 'us',
      productType: route.productType || existing?.productType || 'unknown',
      rtmsId: route.rtmsId || existing?.rtmsId || null,
      envelope: route.envelope || existing?.envelope || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    this.upsertRoute.run({
      streamId,
      regionCode: routeRecord.regionCode,
      spokeGroup: routeRecord.spokeGroup,
      productType: routeRecord.productType,
      rtmsId: routeRecord.rtmsId,
      envelopeJson: stringifyJson(routeRecord.envelope),
      createdAt: routeRecord.createdAt,
      updatedAt: routeRecord.updatedAt
    });

    return routeRecord;
  }

  getStreamRoute(streamId) {
    if (!streamId) return null;
    const row = this.getRoute.get(streamId);
    if (!row) return null;

    return {
      streamId: row.stream_id,
      regionCode: row.region_code,
      spokeGroup: row.spoke_group,
      productType: row.product_type,
      rtmsId: row.rtms_id,
      envelope: parseJson(row.envelope_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  writeStreamState(streamId, state = {}) {
    if (!streamId) throw new Error('streamId is required');
    const now = new Date().toISOString();
    this.upsertState.run({
      streamId,
      stateJson: stringifyJson(state),
      updatedAt: now
    });
    return { streamId, ...state, updatedAt: now };
  }

  appendStreamEvent(streamId, event = {}) {
    if (!streamId) throw new Error('streamId is required');
    const now = new Date().toISOString();
    this.insertEvent.run({
      streamId,
      eventType: event.type || event.event || 'event',
      eventJson: stringifyJson(event),
      createdAt: now
    });
    return { streamId, event: { ...event, recordedAt: now } };
  }

  close() {
    this.db.close();
  }

  prepareSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_idempotency (
        idempotency_key TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        stream_id TEXT,
        rtms_id TEXT,
        accepted_at TEXT NOT NULL,
        accepted_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS webhook_idempotency_expires_at_idx
        ON webhook_idempotency (expires_at_ms);

      CREATE TABLE IF NOT EXISTS stream_routes (
        stream_id TEXT PRIMARY KEY,
        region_code TEXT,
        spoke_group TEXT NOT NULL,
        product_type TEXT,
        rtms_id TEXT,
        envelope_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS stream_routes_rtms_id_idx
        ON stream_routes (rtms_id);

      CREATE INDEX IF NOT EXISTS stream_routes_spoke_group_idx
        ON stream_routes (spoke_group, updated_at DESC);

      CREATE TABLE IF NOT EXISTS stream_states (
        stream_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stream_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS stream_events_stream_id_idx
        ON stream_events (stream_id, created_at DESC);
    `);
  }

  prepareStatements() {
    this.insertIdempotency = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_idempotency (
        idempotency_key,
        event,
        stream_id,
        rtms_id,
        accepted_at,
        accepted_at_ms,
        expires_at_ms
      ) VALUES (
        @idempotencyKey,
        @event,
        @streamId,
        @rtmsId,
        @acceptedAt,
        @acceptedAtMs,
        @expiresAtMs
      )
    `);

    this.deleteExpiredIdempotency = this.db.prepare(`
      DELETE FROM webhook_idempotency
      WHERE expires_at_ms <= ?
    `);

    this.deleteIdempotency = this.db.prepare(`
      DELETE FROM webhook_idempotency
      WHERE idempotency_key = ?
    `);

    this.countIdempotency = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM webhook_idempotency
    `);

    this.getRoute = this.db.prepare(`
      SELECT *
      FROM stream_routes
      WHERE stream_id = ?
    `);

    this.upsertRoute = this.db.prepare(`
      INSERT INTO stream_routes (
        stream_id,
        region_code,
        spoke_group,
        product_type,
        rtms_id,
        envelope_json,
        created_at,
        updated_at
      ) VALUES (
        @streamId,
        @regionCode,
        @spokeGroup,
        @productType,
        @rtmsId,
        @envelopeJson,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(stream_id) DO UPDATE SET
        region_code = excluded.region_code,
        spoke_group = excluded.spoke_group,
        product_type = excluded.product_type,
        rtms_id = excluded.rtms_id,
        envelope_json = excluded.envelope_json,
        updated_at = excluded.updated_at
    `);

    this.upsertState = this.db.prepare(`
      INSERT INTO stream_states (
        stream_id,
        state_json,
        updated_at
      ) VALUES (
        @streamId,
        @stateJson,
        @updatedAt
      )
      ON CONFLICT(stream_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);

    this.insertEvent = this.db.prepare(`
      INSERT INTO stream_events (
        stream_id,
        event_type,
        event_json,
        created_at
      ) VALUES (
        @streamId,
        @eventType,
        @eventJson,
        @createdAt
      )
    `);
  }
}

export function resolveDbPath(dbPath) {
  if (dbPath === ':memory:') return dbPath;
  return path.resolve(dbPath || '.data/rtms.sqlite');
}

function ensureDbDir(dbPath) {
  if (dbPath === ':memory:') return;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

function configureDatabase(db, options = {}) {
  db.pragma(`busy_timeout = ${Number(options.busyTimeoutMs || 5000)}`);
  db.pragma('foreign_keys = ON');
  if (options.wal !== false) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
}

function stringifyJson(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
