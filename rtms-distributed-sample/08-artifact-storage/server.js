import dotenv from 'dotenv';
import express from 'express';
import {
  createArtifactRecord,
  createArtifactStorageProvider
} from '../shared/artifactStorage.js';
import { postJson } from '../shared/http.js';

dotenv.config();

const app = express();
const port = Number(process.env.ARTIFACT_STORAGE_PORT || 4550);
const maxJsonSize = process.env.ARTIFACT_JSON_LIMIT || '100mb';
const metadataStoreUrl = process.env.ARTIFACT_METADATA_STORE_URL || '';
const storage = createArtifactStorageProvider();

app.put(
  '/streams/:streamId/artifacts/:artifactType/:fileName',
  express.raw({ type: '*/*', limit: process.env.ARTIFACT_RAW_LIMIT || '250mb' }),
  async (req, res) => {
    try {
      const record = createArtifactRecord({
        streamId: req.params.streamId,
        artifactType: req.params.artifactType,
        fileName: req.params.fileName,
        contentType: req.headers['content-type'] || 'application/octet-stream',
        regionCode: req.query.regionCode || req.query.region || process.env.SPOKE_REGION || 'unknown',
        productType: req.query.productType || req.query.zoomProduct || 'unknown',
        rtmsId: req.query.rtmsId || null,
        buffer: req.body,
        metadata: parseMetadataHeader(req.headers['x-rtms-artifact-metadata'])
      });
      const artifact = await storage.put(record);
      await writeMetadataIfConfigured(artifact);
      res.status(201).json({ artifact });
    } catch (error) {
      res.status(400).json({ error: 'artifact_upload_failed', reason: error.message });
    }
  }
);

app.use(express.json({ limit: maxJsonSize }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'artifact-storage',
    storage: storage.health(),
    metadataStoreUrl: metadataStoreUrl || null
  });
});

app.post('/artifacts', async (req, res) => {
  try {
    const record = createArtifactRecord(req.body || {});
    const artifact = await storage.put(record);
    await writeMetadataIfConfigured(artifact);
    res.status(201).json({ artifact });
  } catch (error) {
    res.status(400).json({ error: 'artifact_upload_failed', reason: error.message });
  }
});

async function writeMetadataIfConfigured(artifact) {
  if (!metadataStoreUrl) return;

  try {
    await postJson(
      `${metadataStoreUrl.replace(/\/+$/, '')}/streams/${encodeURIComponent(artifact.streamId)}/blobs`,
      {
        name: artifact.fileName,
        contentType: artifact.contentType,
        blobUri: artifact.blobUri,
        artifactId: artifact.artifactId,
        bytes: artifact.byteSize,
        metadata: {
          ...artifact.metadata,
          provider: artifact.provider,
          objectKey: artifact.objectKey,
          artifactType: artifact.artifactType,
          sha256: artifact.sha256,
          rtmsId: artifact.rtmsId,
          regionCode: artifact.regionCode,
          productType: artifact.productType,
          createdAt: artifact.createdAt
        }
      },
      {
        timeoutMs: 3000,
        retryPolicy: { maxAttempts: 2, maxDelayMs: 1000 }
      }
    );
  } catch (error) {
    console.warn(`[08-artifact-storage] metadata write failed stream=${artifact.streamId}: ${error.message}`);
  }
}

function parseMetadataHeader(value) {
  if (!value) return {};
  try {
    return JSON.parse(String(value));
  } catch (_error) {
    return {};
  }
}

app.listen(port, () => {
  console.log(`[08-artifact-storage] listening on http://127.0.0.1:${port} provider=${storage.health().provider}`);
});
