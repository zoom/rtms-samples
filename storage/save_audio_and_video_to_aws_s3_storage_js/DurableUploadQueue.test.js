import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableUploadQueue, enqueueStaleRecordings } from './DurableUploadQueue.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtms-queue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, queueDir: path.join(root, '.queue') };
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createQueue(options) {
  return new DurableUploadQueue({
    concurrency: 1,
    maxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 2,
    deleteLocalAfterUpload: false,
    completedMediaRetentionMs: -1,
    failedMediaRetentionMs: -1,
    jobRetentionMs: -1,
    cleanupIntervalMs: 0,
    logger: { log() {}, warn() {}, error() {} },
    ...options
  });
}

test('recovers a processing job after restart', async (t) => {
  const { root, queueDir } = await fixture(t);
  await fs.mkdir(queueDir, { recursive: true });
  const job = {
    id: 'job-recovery',
    relativeDirectory: path.join('meeting', 'stream'),
    status: 'processing',
    attempts: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    lastErrorCode: null
  };
  await fs.writeFile(path.join(queueDir, `${job.id}.json`), JSON.stringify(job));
  let processed = 0;
  const queue = createQueue({ queueDir, recordingsDir: root, processor: async () => { processed += 1; } });
  await queue.start();
  await waitFor(() => queue.jobs.get(job.id)?.status === 'completed');

  assert.equal(processed, 1);
  assert.equal(queue.jobs.get(job.id).attempts, 2);
  await queue.stop();
});

test('retries transient processing failures without losing the job', async (t) => {
  const { root, queueDir } = await fixture(t);
  let attempts = 0;
  const queue = createQueue({
    queueDir,
    recordingsDir: root,
    processor: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('temporary'), { code: 'temporary_failure' });
    }
  });
  await queue.start();
  const job = await queue.enqueue(path.join('meeting', 'stream'));
  await waitFor(() => queue.jobs.get(job.id)?.status === 'completed');

  assert.equal(attempts, 2);
  assert.equal(queue.jobs.get(job.id).lastErrorCode, null);
  await queue.stop();
});

test('queues stale orphan media but skips active directories', async (t) => {
  const { root } = await fixture(t);
  const staleDirectory = path.join('meeting', 'stale-stream');
  const activeDirectory = path.join('meeting', 'active-stream');
  for (const relativeDirectory of [staleDirectory, activeDirectory]) {
    const folder = path.join(root, relativeDirectory);
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, 'mixed_audio.raw');
    await fs.writeFile(file, 'audio');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
  }
  const enqueued = [];
  const count = await enqueueStaleRecordings({
    recordingsDir: root,
    queue: { enqueue: async (directory) => enqueued.push(directory) },
    staleAfterMs: 30_000,
    activeDirectories: new Set([activeDirectory])
  });

  assert.equal(count, 1);
  assert.deepEqual(enqueued, [staleDirectory]);
});
