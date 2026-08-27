import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createS3Storage } from './S3StorageHelper.js';

test('streams files through encrypted multipart upload configuration', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtms-s3-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const relativeDirectory = path.join('meeting', 'stream');
  const folder = path.join(root, relativeDirectory);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'mixed_final.mp4'), Buffer.alloc(1024, 1));
  const uploads = [];
  const storage = createS3Storage({
    recordingsDir: root,
    bucket: 'test-bucket',
    prefix: 'archive',
    encryption: 'aws:kms',
    kmsKeyId: 'test-key',
    bucketKeyEnabled: true,
    partSizeBytes: 5 * 1024 * 1024,
    queueSize: 2,
    client: {},
    logger: { log() {} },
    uploadFactory: (options) => ({
      done: async () => {
        const chunks = [];
        for await (const chunk of options.params.Body) chunks.push(chunk);
        uploads.push({ options, bytes: Buffer.concat(chunks).length });
      }
    })
  });

  await storage.uploadDirectory(relativeDirectory);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].bytes, 1024);
  assert.equal(Buffer.isBuffer(uploads[0].options.params.Body), false);
  assert.equal(uploads[0].options.partSize, 5 * 1024 * 1024);
  assert.equal(uploads[0].options.queueSize, 2);
  assert.equal(uploads[0].options.params.ServerSideEncryption, 'aws:kms');
  assert.equal(uploads[0].options.params.SSEKMSKeyId, 'test-key');
  assert.equal(uploads[0].options.params.BucketKeyEnabled, true);
});
