import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export function buildArtifactKey(options = {}) {
  const createdAt = options.createdAt ? new Date(options.createdAt) : new Date();
  const date = createdAt.toISOString().slice(0, 10);
  const hourUtc = createdAt.toISOString().slice(11, 13);
  const streamId = requireValue(options.streamId, 'streamId');
  const fileName = sanitizeFileName(options.fileName || defaultFileName(options.artifactType, options.contentType));
  const region = sanitizePathValue(options.regionCode || options.region || 'unknown');
  const productType = sanitizePathValue(options.productType || options.zoomProduct || 'unknown');
  const artifactType = sanitizePathValue(options.artifactType || 'artifact');
  const shard = crypto.createHash('sha256').update(String(streamId)).digest('hex').slice(0, 2);

  return [
    'rtms',
    'v1',
    `date=${date}`,
    `hour_utc=${hourUtc}`,
    `region=${region}`,
    `zoom_product=${productType}`,
    `artifact_type=${artifactType}`,
    `shard=${shard}`,
    `stream_id=${sanitizePathValue(streamId)}`,
    fileName
  ].join('/');
}

export function createArtifactRecord(options = {}) {
  const body = normalizeArtifactBody(options);
  const key = options.key || buildArtifactKey({
    streamId: body.streamId,
    regionCode: body.regionCode,
    productType: body.productType,
    artifactType: body.artifactType,
    fileName: body.fileName,
    contentType: body.contentType,
    createdAt: body.createdAt
  });
  const buffer = body.buffer;
  const now = new Date().toISOString();

  return {
    artifactId: body.artifactId || createId('artifact'),
    streamId: body.streamId,
    rtmsId: body.rtmsId || null,
    regionCode: body.regionCode || null,
    productType: body.productType || 'unknown',
    artifactType: body.artifactType || 'artifact',
    fileName: body.fileName,
    contentType: body.contentType,
    byteSize: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    objectKey: key,
    metadata: body.metadata || {},
    createdAt: body.createdAt || now,
    buffer
  };
}

export function createArtifactStorageProvider(env = process.env) {
  const provider = String(env.ARTIFACT_STORAGE_PROVIDER || 'local').trim().toLowerCase();
  if (provider === 'local' || provider === 'filesystem' || provider === 'fs') {
    return new LocalArtifactStorage({
      rootDir: env.ARTIFACT_LOCAL_ROOT || '.data/artifacts'
    });
  }

  if (provider === 's3' || provider === 'aws' || provider === 'minio') {
    return new S3ArtifactStorage({
      bucket: env.ARTIFACT_BUCKET,
      region: env.AWS_REGION || env.ARTIFACT_S3_REGION || 'us-east-1',
      endpoint: env.ARTIFACT_S3_ENDPOINT || undefined,
      forcePathStyle: parseBoolean(env.ARTIFACT_S3_FORCE_PATH_STYLE, Boolean(env.ARTIFACT_S3_ENDPOINT)),
      createBucket: parseBoolean(env.ARTIFACT_S3_CREATE_BUCKET, provider === 'minio')
    });
  }

  if (provider === 'azure' || provider === 'azblob' || provider === 'azure-blob') {
    return new AzureBlobArtifactStorage({
      container: env.ARTIFACT_BUCKET || env.AZURE_STORAGE_CONTAINER,
      connectionString: env.ARTIFACT_AZURE_CONNECTION_STRING || env.AZURE_STORAGE_CONNECTION_STRING
    });
  }

  if (provider === 'gcs' || provider === 'google' || provider === 'google-cloud-storage') {
    return new GcsArtifactStorage({
      bucket: env.ARTIFACT_BUCKET || env.GOOGLE_CLOUD_STORAGE_BUCKET
    });
  }

  throw new Error(`Unsupported ARTIFACT_STORAGE_PROVIDER: ${provider}`);
}

export class LocalArtifactStorage {
  constructor(options = {}) {
    this.provider = 'local';
    this.rootDir = path.resolve(options.rootDir || '.data/artifacts');
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  health() {
    return {
      provider: this.provider,
      rootDir: this.rootDir
    };
  }

  async put(record) {
    const filePath = path.join(this.rootDir, record.objectKey);
    assertInsideRoot(this.rootDir, filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, record.buffer);

    return {
      ...stripBuffer(record),
      provider: this.provider,
      blobUri: `local://artifacts/${record.objectKey}`
    };
  }
}

export class S3ArtifactStorage {
  constructor(options = {}) {
    this.provider = options.endpoint ? 's3-compatible' : 's3';
    this.bucket = requireValue(options.bucket, 'ARTIFACT_BUCKET');
    this.region = options.region || 'us-east-1';
    this.endpoint = options.endpoint;
    this.forcePathStyle = options.forcePathStyle;
    this.createBucket = Boolean(options.createBucket);
    this.bucketReadyPromise = null;
  }

  health() {
    return {
      provider: this.provider,
      bucket: this.bucket,
      region: this.region,
      endpoint: this.endpoint || null,
      forcePathStyle: this.forcePathStyle,
      createBucket: this.createBucket
    };
  }

  async put(record) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await this.getReadyClient();
    const result = await client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: record.objectKey,
      Body: record.buffer,
      ContentType: record.contentType,
      Metadata: normalizeObjectMetadata(record)
    }));

    return {
      ...stripBuffer(record),
      provider: this.provider,
      bucket: this.bucket,
      blobUri: `s3://${this.bucket}/${record.objectKey}`,
      etag: result.ETag || null
    };
  }

  async getReadyClient() {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: this.region,
      endpoint: this.endpoint,
      forcePathStyle: this.forcePathStyle
    });

    if (!this.createBucket) return client;

    if (!this.bucketReadyPromise) {
      this.bucketReadyPromise = ensureS3Bucket(client, this.bucket, this.region);
    }
    await this.bucketReadyPromise;
    return client;
  }
}

async function ensureS3Bucket(client, bucket, region) {
  const { CreateBucketCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3');

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (error) {
    if (!isMissingBucketError(error)) {
      throw error;
    }
  }

  const input = { Bucket: bucket };
  if (region && region !== 'us-east-1') {
    input.CreateBucketConfiguration = { LocationConstraint: region };
  }

  try {
    await client.send(new CreateBucketCommand(input));
  } catch (error) {
    if (!isBucketAlreadyOwnedError(error)) {
      throw error;
    }
  }
}

function isMissingBucketError(error) {
  const status = error?.$metadata?.httpStatusCode;
  return status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchBucket';
}

function isBucketAlreadyOwnedError(error) {
  return ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error?.name);
}

export class AzureBlobArtifactStorage {
  constructor(options = {}) {
    this.provider = 'azure-blob';
    this.container = requireValue(options.container, 'ARTIFACT_BUCKET or AZURE_STORAGE_CONTAINER');
    this.connectionString = requireValue(options.connectionString, 'ARTIFACT_AZURE_CONNECTION_STRING or AZURE_STORAGE_CONNECTION_STRING');
  }

  health() {
    return {
      provider: this.provider,
      container: this.container
    };
  }

  async put(record) {
    const { BlobServiceClient } = await import('@azure/storage-blob');
    const blobServiceClient = BlobServiceClient.fromConnectionString(this.connectionString);
    const containerClient = blobServiceClient.getContainerClient(this.container);
    await containerClient.createIfNotExists();
    const blobClient = containerClient.getBlockBlobClient(record.objectKey);
    const result = await blobClient.uploadData(record.buffer, {
      blobHTTPHeaders: {
        blobContentType: record.contentType
      },
      metadata: normalizeObjectMetadata(record)
    });

    return {
      ...stripBuffer(record),
      provider: this.provider,
      bucket: this.container,
      blobUri: `az://${this.container}/${record.objectKey}`,
      etag: result.etag || null
    };
  }
}

export class GcsArtifactStorage {
  constructor(options = {}) {
    this.provider = 'gcs';
    this.bucket = requireValue(options.bucket, 'ARTIFACT_BUCKET or GOOGLE_CLOUD_STORAGE_BUCKET');
  }

  health() {
    return {
      provider: this.provider,
      bucket: this.bucket
    };
  }

  async put(record) {
    const { Storage } = await import('@google-cloud/storage');
    const storage = new Storage();
    const file = storage.bucket(this.bucket).file(record.objectKey);
    await file.save(record.buffer, {
      resumable: false,
      contentType: record.contentType,
      metadata: {
        metadata: normalizeObjectMetadata(record)
      }
    });

    return {
      ...stripBuffer(record),
      provider: this.provider,
      bucket: this.bucket,
      blobUri: `gs://${this.bucket}/${record.objectKey}`
    };
  }
}

function normalizeArtifactBody(options = {}) {
  const streamId = requireValue(options.streamId, 'streamId');
  const contentType = options.contentType || inferContentType(options.fileName);
  const fileName = sanitizeFileName(options.fileName || defaultFileName(options.artifactType, contentType));
  const buffer = getArtifactBuffer(options);

  return {
    ...options,
    streamId,
    fileName,
    contentType,
    artifactType: options.artifactType || inferArtifactType(fileName, contentType),
    buffer
  };
}

function getArtifactBuffer(options = {}) {
  if (options.contentBase64) return Buffer.from(options.contentBase64, 'base64');
  if (options.content !== undefined) return Buffer.from(String(options.content), 'utf8');
  if (options.buffer) return Buffer.from(options.buffer);
  throw new Error('Artifact upload requires contentBase64, content, or buffer');
}

function normalizeObjectMetadata(record) {
  return {
    artifact_id: String(record.artifactId),
    stream_id: String(record.streamId),
    artifact_type: String(record.artifactType),
    product_type: String(record.productType || 'unknown'),
    region_code: String(record.regionCode || 'unknown'),
    sha256: String(record.sha256)
  };
}

function stripBuffer(record) {
  const { buffer: _buffer, ...rest } = record;
  return rest;
}

function defaultFileName(artifactType = 'artifact', contentType = 'application/octet-stream') {
  const type = sanitizeFileName(artifactType || 'artifact');
  if (contentType === 'text/markdown') return `${type}.md`;
  if (contentType === 'application/json') return `${type}.json`;
  if (contentType === 'application/jsonl') return `${type}.jsonl`;
  if (contentType === 'audio/wav') return `${type}.wav`;
  if (contentType === 'video/mp4') return `${type}.mp4`;
  return `${type}.bin`;
}

function inferContentType(fileName = '') {
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.jsonl')) return 'application/jsonl';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

function inferArtifactType(fileName, contentType) {
  if (contentType === 'text/markdown') return 'summary_final';
  if (contentType === 'application/jsonl') return 'transcript_final';
  if (contentType === 'audio/wav') return 'audio_final';
  if (contentType === 'video/mp4') return 'video_final';
  return sanitizePathValue(path.parse(fileName).name || 'artifact');
}

function sanitizePathValue(value) {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function sanitizeFileName(value) {
  const sanitized = String(value || 'artifact.bin')
    .replace(/[/\\]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'artifact.bin';
}

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function assertInsideRoot(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Artifact path escaped local root');
  }
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomUUID()}`;
}
