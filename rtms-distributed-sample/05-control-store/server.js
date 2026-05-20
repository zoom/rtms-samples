import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { SQLiteControlStore } from './sqliteControlStore.js';

dotenv.config();

const app = express();
const port = Number(process.env.CENTRAL_PORT || 4100);
const storeRole = process.env.STORE_ROLE || 'central';
const regionCode = process.env.STORE_REGION || process.env.SPOKE_REGION || null;
const dataDir = process.env.CONTROL_DATA_DIR || process.env.CENTRAL_DATA_DIR || `.data/${storeRole}${regionCode ? `-${regionCode}` : ''}`;
const dbPath = process.env.CONTROL_SQLITE_DB_PATH || path.join(dataDir, 'control.sqlite');
const store = new SQLiteControlStore({ rootDir: dataDir, dbPath });

app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'control-store', storeRole, regionCode, sqlite: store.health() });
});

app.get('/streams', (_req, res) => {
  res.json({ streams: store.listStreams() });
});

app.get('/streams/:streamId', (req, res) => {
  const stream = store.getStream(req.params.streamId);
  if (!stream) return res.status(404).json({ error: 'stream_not_found' });
  return res.json(stream);
});

app.get('/streams/:streamId/documents', (req, res) => {
  res.json({ documents: store.listStreamDocuments(req.params.streamId) });
});

app.get('/streams/:streamId/blobs', (req, res) => {
  res.json({ blobs: store.listStreamBlobs(req.params.streamId) });
});

app.get('/documents/:documentId', (req, res) => {
  const result = store.findDocument(req.params.documentId);
  if (!result) return res.status(404).json({ error: 'document_not_found' });
  return res.json(result);
});

app.get('/artifacts/:artifactId', (req, res) => {
  const result = store.findBlob(req.params.artifactId);
  if (!result) return res.status(404).json({ error: 'artifact_not_found' });
  return res.json(result);
});

app.put('/streams/:streamId/route', (req, res) => {
  const stream = store.upsertRoute(req.params.streamId, req.body || {});
  res.json(stream);
});

app.post('/streams/:streamId/claim', (req, res) => {
  const result = store.claimStream(req.params.streamId, req.body || {});
  res.status(result.claimed ? 200 : 409).json(result);
});

app.post('/streams/:streamId/lease-renew', (req, res) => {
  const result = store.renewLease(req.params.streamId, req.body || {});
  res.status(result.renewed ? 200 : 409).json(result);
});

app.post('/streams/:streamId/release', (req, res) => {
  const stream = store.releaseStream(req.params.streamId, req.body || {});
  if (!stream) return res.status(404).json({ error: 'stream_not_found' });
  return res.json(stream);
});

app.post('/streams/:streamId/state', (req, res) => {
  const stream = store.updateState(req.params.streamId, req.body || {});
  res.json(stream);
});

app.post('/streams/:streamId/events', (req, res) => {
  const stream = store.appendEvent(req.params.streamId, req.body || {});
  res.json(stream);
});

app.post('/streams/:streamId/documents', (req, res) => {
  const stream = store.writeMarkdown(req.params.streamId, req.body || {});
  res.json(stream);
});

app.post('/streams/:streamId/blobs', (req, res) => {
  const stream = store.writeBlob(req.params.streamId, req.body || {});
  res.json(stream);
});

app.listen(port, () => {
  console.log(`[05-control-store] ${storeRole} store listening on http://127.0.0.1:${port}`);
});
