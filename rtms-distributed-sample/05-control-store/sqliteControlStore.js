import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

export class SQLiteControlStore {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || '.data/control-store');
    const requestedDbPath = options.dbPath || path.join(this.rootDir, 'control.sqlite');
    this.dbPath = requestedDbPath === ':memory:' ? ':memory:' : path.resolve(requestedDbPath);
    this.docsDir = path.join(this.rootDir, 'markdown');
    this.blobsDir = path.join(this.rootDir, 'blobs');

    fs.mkdirSync(this.docsDir, { recursive: true });
    fs.mkdirSync(this.blobsDir, { recursive: true });
    if (this.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.prepareSchema();
    this.prepareStatements();
  }

  health() {
    return {
      dbPath: this.dbPath,
      dataDir: this.rootDir,
      journalMode: this.db.pragma('journal_mode', { simple: true })
    };
  }

  listStreams() {
    return this.listStreamsStmt.all().map(rowToStream);
  }

  getStream(streamId) {
    return rowToStream(this.getStreamStmt.get(streamId));
  }

  listStreamDocuments(streamId) {
    return this.getStream(streamId)?.documents || [];
  }

  listStreamBlobs(streamId) {
    return this.getStream(streamId)?.blobs || [];
  }

  findDocument(documentId) {
    for (const stream of this.listStreams()) {
      const document = (stream.documents || []).find((item) => item.documentId === documentId);
      if (document) return { streamId: stream.streamId, document };
    }
    return null;
  }

  findBlob(artifactId) {
    for (const stream of this.listStreams()) {
      const blob = (stream.blobs || []).find((item) => item.artifactId === artifactId);
      if (blob) return { streamId: stream.streamId, blob };
    }
    return null;
  }

  upsertRoute(streamId, route) {
    const existing = this.getStream(streamId) || {};
    const now = new Date().toISOString();
    const stream = {
      ...existing,
      streamId,
      regionCode: route.regionCode || existing.regionCode || 'UNKNOWN',
      spokeGroup: route.spokeGroup || existing.spokeGroup || null,
      selectedRegionCode: route.selectedRegionCode || existing.selectedRegionCode || route.regionCode || null,
      productType: route.productType || existing.productType || 'unknown',
      rtmsId: route.rtmsId || existing.rtmsId || null,
      routeUpdatedAt: now,
      updatedAt: now,
      createdAt: existing.createdAt || now,
      startEnvelope: route.envelope || existing.startEnvelope || null,
      webhook: route.webhook || existing.webhook || null,
      events: existing.events || [],
      documents: existing.documents || [],
      blobs: existing.blobs || [],
      state: existing.state || 'routed'
    };
    return this.saveStream(stream);
  }

  claimStream(streamId, claim) {
    return this.transaction(() => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const existing = this.getStream(streamId) || {
        streamId,
        events: [],
        documents: [],
        blobs: [],
        createdAt: now
      };
      const activeLease = existing.ownerNodeId && existing.leaseExpiresAtMs && existing.leaseExpiresAtMs > nowMs;
      const sameOwner = existing.ownerNodeId === claim.nodeId;
      const stopped = existing.state === 'stopped' || existing.state === 'stop_requested';

      if (activeLease && !sameOwner && !stopped) {
        return { claimed: false, stream: existing };
      }

      const leaseVersion = sameOwner ? existing.leaseVersion : (existing.leaseVersion || 0) + 1;
      const stream = {
        ...existing,
        streamId,
        regionCode: claim.regionCode || existing.regionCode || 'UNKNOWN',
        ownerNodeId: claim.nodeId,
        leaseVersion,
        leaseExpiresAtMs: nowMs + Number(claim.ttlMs || 45000),
        leaseExpiresAt: new Date(nowMs + Number(claim.ttlMs || 45000)).toISOString(),
        state: 'claimed',
        claimedAt: now,
        updatedAt: now,
        startEnvelope: claim.envelope || existing.startEnvelope || null
      };

      return { claimed: true, stream: this.saveStream(stream) };
    })();
  }

  renewLease(streamId, renewal) {
    return this.transaction(() => {
      const stream = this.getStream(streamId);
      if (!stream || stream.ownerNodeId !== renewal.nodeId || stream.leaseVersion !== renewal.leaseVersion) {
        return { renewed: false, stream };
      }

      const nowMs = Date.now();
      stream.leaseExpiresAtMs = nowMs + Number(renewal.ttlMs || 45000);
      stream.leaseExpiresAt = new Date(stream.leaseExpiresAtMs).toISOString();
      stream.updatedAt = new Date(nowMs).toISOString();
      return { renewed: true, stream: this.saveStream(stream) };
    })();
  }

  releaseStream(streamId, release) {
    return this.transaction(() => {
      const stream = this.getStream(streamId);
      if (!stream) return null;

      if (!release.force && stream.ownerNodeId && stream.ownerNodeId !== release.nodeId) {
        return stream;
      }

      stream.state = release.state || 'stopped';
      stream.releasedAt = new Date().toISOString();
      stream.updatedAt = stream.releasedAt;
      delete stream.leaseExpiresAtMs;
      delete stream.leaseExpiresAt;
      return this.saveStream(stream);
    })();
  }

  updateState(streamId, patch) {
    const existing = this.getStream(streamId) || {
      streamId,
      events: [],
      documents: [],
      blobs: [],
      createdAt: new Date().toISOString()
    };
    const now = new Date().toISOString();
    const stream = {
      ...existing,
      ...patch,
      streamId,
      updatedAt: now
    };
    return this.saveStream(stream);
  }

  appendEvent(streamId, event) {
    return this.transaction(() => {
      const stream = this.updateState(streamId, {});
      stream.events = stream.events || [];
      stream.events.push({
        ...event,
        recordedAt: new Date().toISOString()
      });
      if (stream.events.length > 200) stream.events = stream.events.slice(-200);
      return this.saveStream(stream);
    })();
  }

  writeMarkdown(streamId, document) {
    return this.transaction(() => {
      const safeName = safeFileName(document.name || `${Date.now()}.md`);
      const dir = path.join(this.docsDir, safeFileName(streamId));
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, safeName.endsWith('.md') ? safeName : `${safeName}.md`);
      fs.writeFileSync(filePath, document.markdown || '', 'utf8');

      const stream = this.updateState(streamId, {});
      stream.documents = stream.documents || [];
      const documentId = createId('doc');
      stream.documents.push({
        documentId,
        name: path.basename(filePath),
        path: filePath,
        blobUri: `local://markdown/${safeFileName(streamId)}/${path.basename(filePath)}`,
        metadata: document.metadata || {},
        createdAt: new Date().toISOString()
      });
      return this.saveStream(stream);
    })();
  }

  writeBlob(streamId, blob) {
    return this.transaction(() => {
      const safeName = safeFileName(blob.name || `${Date.now()}.bin`);
      const externalBlobUri = blob.blobUri && !blob.contentBase64 && blob.content === undefined;
      let filePath = null;
      let dataLength = Number(blob.bytes || blob.byteSize || 0);

      if (!externalBlobUri) {
        const dir = path.join(this.blobsDir, safeFileName(streamId));
        fs.mkdirSync(dir, { recursive: true });
        filePath = path.join(dir, safeName);
        const data = blob.contentBase64
          ? Buffer.from(blob.contentBase64, 'base64')
          : Buffer.from(blob.content || '', 'utf8');
        fs.writeFileSync(filePath, data);
        dataLength = data.length;
      }

      const stream = this.updateState(streamId, {});
      stream.blobs = stream.blobs || [];
      const artifactId = blob.artifactId || createId('artifact');
      stream.blobs.push({
        artifactId,
        name: filePath ? path.basename(filePath) : safeName,
        path: filePath,
        blobUri: blob.blobUri || `local://blobs/${safeFileName(streamId)}/${path.basename(filePath)}`,
        contentType: blob.contentType || 'application/octet-stream',
        bytes: dataLength,
        metadata: blob.metadata || {},
        createdAt: new Date().toISOString()
      });
      return this.saveStream(stream);
    })();
  }

  saveStream(stream) {
    const now = new Date().toISOString();
    const record = {
      ...stream,
      createdAt: stream.createdAt || now,
      updatedAt: stream.updatedAt || now
    };
    this.upsertStreamStmt.run({
      streamId: record.streamId,
      regionCode: record.regionCode || null,
      spokeGroup: record.spokeGroup || null,
      productType: record.productType || null,
      rtmsId: record.rtmsId || null,
      state: record.state || null,
      ownerNodeId: record.ownerNodeId || null,
      leaseVersion: record.leaseVersion || 0,
      leaseExpiresAtMs: record.leaseExpiresAtMs || null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      streamJson: JSON.stringify(record)
    });
    return record;
  }

  transaction(fn) {
    return this.db.transaction(fn);
  }

  prepareSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        stream_id TEXT PRIMARY KEY,
        region_code TEXT,
        spoke_group TEXT,
        product_type TEXT,
        rtms_id TEXT,
        state TEXT,
        owner_node_id TEXT,
        lease_version INTEGER NOT NULL DEFAULT 0,
        lease_expires_at_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        stream_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS streams_rtms_id_idx
        ON streams (rtms_id);

      CREATE INDEX IF NOT EXISTS streams_region_state_idx
        ON streams (region_code, state, updated_at DESC);

      CREATE INDEX IF NOT EXISTS streams_owner_idx
        ON streams (owner_node_id);

      CREATE INDEX IF NOT EXISTS streams_updated_at_idx
        ON streams (updated_at DESC);
    `);
  }

  prepareStatements() {
    this.listStreamsStmt = this.db.prepare(`
      SELECT stream_json
      FROM streams
      ORDER BY updated_at DESC
    `);

    this.getStreamStmt = this.db.prepare(`
      SELECT stream_json
      FROM streams
      WHERE stream_id = ?
    `);

    this.upsertStreamStmt = this.db.prepare(`
      INSERT INTO streams (
        stream_id,
        region_code,
        spoke_group,
        product_type,
        rtms_id,
        state,
        owner_node_id,
        lease_version,
        lease_expires_at_ms,
        created_at,
        updated_at,
        stream_json
      ) VALUES (
        @streamId,
        @regionCode,
        @spokeGroup,
        @productType,
        @rtmsId,
        @state,
        @ownerNodeId,
        @leaseVersion,
        @leaseExpiresAtMs,
        @createdAt,
        @updatedAt,
        @streamJson
      )
      ON CONFLICT(stream_id) DO UPDATE SET
        region_code = excluded.region_code,
        spoke_group = excluded.spoke_group,
        product_type = excluded.product_type,
        rtms_id = excluded.rtms_id,
        state = excluded.state,
        owner_node_id = excluded.owner_node_id,
        lease_version = excluded.lease_version,
        lease_expires_at_ms = excluded.lease_expires_at_ms,
        updated_at = excluded.updated_at,
        stream_json = excluded.stream_json
    `);
  }
}

function rowToStream(row) {
  if (!row) return null;
  try {
    return JSON.parse(row.stream_json);
  } catch {
    return null;
  }
}

function safeFileName(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomUUID()}`;
}
