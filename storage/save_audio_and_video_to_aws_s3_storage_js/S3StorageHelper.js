import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import dotenv from 'dotenv';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)), quiet: true });

const CONTENT_TYPES = new Map([
  ['.wav', 'audio/wav'],
  ['.mp4', 'video/mp4'],
  ['.vtt', 'text/vtt'],
  ['.srt', 'application/x-subrip'],
  ['.txt', 'text/plain']
]);

function readNumber(name, fallback, { integer = false, minimum = 0 } = {}) {
  const configured = process.env[name];
  const value = configured === undefined || configured === '' ? fallback : Number(configured);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} has an invalid value`);
  }
  return value;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function encryptionParameters(config) {
  const supported = new Set(['AES256', 'aws:kms', 'aws:kms:dsse']);
  if (!supported.has(config.encryption)) throw new Error('S3_SERVER_SIDE_ENCRYPTION is invalid');
  const kms = config.encryption.startsWith('aws:kms');
  return {
    ServerSideEncryption: config.encryption,
    ...(kms && config.kmsKeyId ? { SSEKMSKeyId: config.kmsKeyId } : {}),
    ...(kms ? { BucketKeyEnabled: config.bucketKeyEnabled } : {})
  };
}

export function createS3Storage({
  recordingsDir = path.resolve('recordings'),
  bucket = process.env.S3_BUCKET,
  prefix = process.env.S3_PREFIX || 'rtms',
  region = process.env.AWS_REGION,
  encryption = process.env.S3_SERVER_SIDE_ENCRYPTION || 'AES256',
  kmsKeyId = process.env.S3_KMS_KEY_ID || '',
  bucketKeyEnabled = readBoolean('S3_BUCKET_KEY_ENABLED', true),
  partSizeBytes = readNumber('S3_MULTIPART_PART_SIZE_MB', 16, { minimum: 5 }) * 1024 * 1024,
  queueSize = readNumber('S3_MULTIPART_CONCURRENCY', 4, { integer: true, minimum: 1 }),
  maxAttempts = readNumber('AWS_MAX_ATTEMPTS', 3, { integer: true, minimum: 1 }),
  client,
  uploadFactory = (options) => new Upload(options),
  logger = console
} = {}) {
  if (!bucket) throw new Error('S3_BUCKET is required');
  const root = path.resolve(recordingsDir);
  const s3 = client || new S3Client({
    ...(region ? { region } : {}),
    maxAttempts
  });
  const encryptionConfig = { encryption, kmsKeyId, bucketKeyEnabled };
  encryptionParameters(encryptionConfig);

  async function uploadDirectory(relativeDirectory) {
    const folder = path.resolve(root, relativeDirectory);
    if (folder !== root && !folder.startsWith(`${root}${path.sep}`)) {
      throw new Error('Upload job contains an invalid source directory');
    }
    const entries = await fsPromises.readdir(folder, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && CONTENT_TYPES.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
    if (files.length === 0) throw new Error('No finalized recording files are available for upload');

    for (const fileName of files) {
      const filePath = path.join(folder, fileName);
      const stats = await fsPromises.stat(filePath);
      const key = [prefix.replace(/^\/+|\/+$/g, ''), relativeDirectory.split(path.sep).join('/'), fileName]
        .filter(Boolean)
        .join('/');
      const upload = uploadFactory({
        client: s3,
        queueSize,
        partSize: partSizeBytes,
        leavePartsOnError: false,
        params: {
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(filePath),
          ContentLength: stats.size,
          ContentType: CONTENT_TYPES.get(path.extname(fileName).toLowerCase()),
          ...encryptionParameters(encryptionConfig)
        }
      });
      try {
        await upload.done();
        logger.log(`[S3] Uploaded ${fileName} (${stats.size} bytes)`);
      } catch (error) {
        const sanitized = new Error(`S3 upload failed for ${fileName}`);
        sanitized.code = error?.name || error?.Code || 's3_upload_failed';
        sanitized.requestId = error?.$metadata?.requestId;
        throw sanitized;
      }
    }
    return { uploadedFiles: files.length };
  }

  return { uploadDirectory, client: s3 };
}
