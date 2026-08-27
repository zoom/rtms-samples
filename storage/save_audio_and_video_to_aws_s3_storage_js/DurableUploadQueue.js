import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function safeRelativeDirectory(value) {
  const normalized = path.normalize(String(value || ''));
  if (!normalized || normalized === '.' || path.isAbsolute(normalized) || normalized.startsWith(`..${path.sep}`) || normalized === '..') {
    throw new Error('Queue job has an invalid recording directory');
  }
  return normalized;
}

export class DurableUploadQueue {
  constructor({
    queueDir,
    recordingsDir,
    processor,
    concurrency = 1,
    maxAttempts = 5,
    retryBaseMs = 5_000,
    retryMaxMs = 5 * 60_000,
    deleteLocalAfterUpload = true,
    completedMediaRetentionMs = 24 * 60 * 60 * 1000,
    failedMediaRetentionMs = 7 * 24 * 60 * 60 * 1000,
    jobRetentionMs = 30 * 24 * 60 * 60 * 1000,
    cleanupIntervalMs = 60 * 60 * 1000,
    now = () => Date.now(),
    logger = console
  }) {
    this.queueDir = path.resolve(queueDir);
    this.recordingsDir = path.resolve(recordingsDir);
    this.processor = processor;
    this.concurrency = concurrency;
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.deleteLocalAfterUpload = deleteLocalAfterUpload;
    this.completedMediaRetentionMs = completedMediaRetentionMs;
    this.failedMediaRetentionMs = failedMediaRetentionMs;
    this.jobRetentionMs = jobRetentionMs;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.now = now;
    this.logger = logger;
    this.jobs = new Map();
    this.inFlight = new Set();
    this.running = false;
    this.accepting = false;
    this.drainScheduled = false;
    this.wakeTimer = null;
    this.cleanupTimer = null;
  }

  async start() {
    await fs.mkdir(this.queueDir, { recursive: true });
    const entries = await fs.readdir(this.queueDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const job = JSON.parse(await fs.readFile(path.join(this.queueDir, entry.name), 'utf8'));
        job.relativeDirectory = safeRelativeDirectory(job.relativeDirectory);
        if (job.status === 'processing') {
          job.status = 'pending';
          job.nextAttemptAt = this.now();
          await this.persist(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        this.logger.warn(`[UploadQueue] Ignored invalid queue record ${entry.name}`);
      }
    }
    this.running = true;
    this.accepting = true;
    await this.cleanup();
    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup().catch((error) => this.logger.error('[UploadQueue] Cleanup failed:', error.message));
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
    this.scheduleDrain();
  }

  async enqueue(relativeDirectory) {
    if (!this.accepting) throw new Error('Upload queue is not accepting jobs');
    const normalized = safeRelativeDirectory(relativeDirectory);
    const id = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
    const existing = this.jobs.get(id);
    if (existing) return existing;
    const now = this.now();
    const job = {
      id,
      relativeDirectory: normalized,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      lastErrorCode: null
    };
    await this.persist(job);
    this.jobs.set(id, job);
    this.logger.log(`[UploadQueue] Queued recording job ${id}`);
    this.scheduleDrain();
    return job;
  }

  async persist(job) {
    await writeAtomic(path.join(this.queueDir, `${job.id}.json`), job);
  }

  scheduleDrain() {
    if (!this.running || this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  drain() {
    if (!this.running) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const now = this.now();
    const ready = [...this.jobs.values()]
      .filter((job) => job.status === 'pending' && job.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt - b.createdAt);

    while (this.inFlight.size < this.concurrency && ready.length > 0) {
      const job = ready.shift();
      const promise = this.processJob(job).catch((error) => {
        this.logger.error(`[UploadQueue] Queue state failure for job ${job.id} (${error?.code || error?.name || 'queue_failure'})`);
      });
      this.inFlight.add(promise);
      void promise.finally(() => {
        this.inFlight.delete(promise);
        this.scheduleDrain();
      });
    }

    if (this.inFlight.size < this.concurrency) {
      const nextAttempt = [...this.jobs.values()]
        .filter((job) => job.status === 'pending')
        .reduce((minimum, job) => Math.min(minimum, job.nextAttemptAt), Infinity);
      if (Number.isFinite(nextAttempt)) {
        this.wakeTimer = setTimeout(() => this.scheduleDrain(), Math.max(1, nextAttempt - this.now()));
        this.wakeTimer.unref?.();
      }
    }
  }

  async processJob(job) {
    job.status = 'processing';
    job.attempts += 1;
    job.updatedAt = this.now();
    await this.persist(job);
    try {
      await this.processor(job);
      job.status = 'completed';
      job.completedAt = this.now();
      job.updatedAt = job.completedAt;
      job.lastErrorCode = null;
      await this.persist(job);
      this.logger.log(`[UploadQueue] Completed recording job ${job.id}`);
    } catch (error) {
      job.lastErrorCode = String(error?.code || error?.name || 'processing_failed').slice(0, 100);
      job.updatedAt = this.now();
      if (job.attempts >= this.maxAttempts) {
        job.status = 'failed';
        job.failedAt = job.updatedAt;
        this.logger.error(`[UploadQueue] Recording job ${job.id} failed after ${job.attempts} attempts (${job.lastErrorCode})`);
      } else {
        const retryDelay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (job.attempts - 1));
        job.status = 'pending';
        job.nextAttemptAt = this.now() + retryDelay;
        this.logger.warn(`[UploadQueue] Recording job ${job.id} will retry in ${retryDelay}ms (${job.lastErrorCode})`);
      }
      await this.persist(job);
      return;
    }
    try {
      await this.cleanupJobMedia(job);
    } catch (error) {
      this.logger.warn(`[UploadQueue] Local cleanup for job ${job.id} will be retried (${error?.code || error?.name || 'cleanup_failed'})`);
    }
  }

  recordingPath(job) {
    const folder = path.resolve(this.recordingsDir, job.relativeDirectory);
    if (folder !== this.recordingsDir && !folder.startsWith(`${this.recordingsDir}${path.sep}`)) {
      throw new Error('Queue job resolves outside the recordings directory');
    }
    return folder;
  }

  async cleanupJobMedia(job) {
    if (!this.deleteLocalAfterUpload || job.status !== 'completed') return;
    await fs.rm(this.recordingPath(job), { recursive: true, force: true });
    job.mediaCleanedAt = this.now();
    await this.persist(job);
  }

  async cleanup() {
    const now = this.now();
    for (const job of [...this.jobs.values()]) {
      const terminalAt = job.completedAt || job.failedAt;
      if (!terminalAt) continue;
      const mediaRetention = job.status === 'completed'
        ? this.completedMediaRetentionMs
        : this.failedMediaRetentionMs;
      if (!job.mediaCleanedAt && mediaRetention >= 0 && now - terminalAt >= mediaRetention) {
        await fs.rm(this.recordingPath(job), { recursive: true, force: true });
        job.mediaCleanedAt = now;
        await this.persist(job);
      }
      if (job.mediaCleanedAt && this.jobRetentionMs >= 0 && now - terminalAt >= this.jobRetentionMs) {
        await fs.rm(path.join(this.queueDir, `${job.id}.json`), { force: true });
        this.jobs.delete(job.id);
      }
    }
  }

  async waitForIdle({ timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 || [...this.jobs.values()].some((job) => job.status === 'pending' && job.nextAttemptAt <= this.now())) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for upload queue to become idle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async stop() {
    this.accepting = false;
    this.running = false;
    clearTimeout(this.wakeTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.inFlight]);
  }
}

export async function enqueueStaleRecordings({
  recordingsDir,
  queue,
  staleAfterMs,
  activeDirectories = new Set(),
  now = Date.now()
}) {
  const root = path.resolve(recordingsDir);
  if (!(await exists(root))) return 0;
  let enqueued = 0;
  const meetingEntries = await fs.readdir(root, { withFileTypes: true });
  for (const meetingEntry of meetingEntries) {
    if (!meetingEntry.isDirectory() || meetingEntry.name.startsWith('.')) continue;
    const meetingFolder = path.join(root, meetingEntry.name);
    const streamEntries = await fs.readdir(meetingFolder, { withFileTypes: true });
    for (const streamEntry of streamEntries) {
      if (!streamEntry.isDirectory()) continue;
      const relativeDirectory = path.join(meetingEntry.name, streamEntry.name);
      if (activeDirectories.has(relativeDirectory)) continue;
      const streamFolder = path.join(meetingFolder, streamEntry.name);
      const files = await fs.readdir(streamFolder, { withFileTypes: true });
      const mediaFiles = files.filter((entry) => entry.isFile() && /\.(raw|h264|wav|mp4)$/i.test(entry.name));
      if (mediaFiles.length === 0) continue;
      const stats = await Promise.all(mediaFiles.map((entry) => fs.stat(path.join(streamFolder, entry.name))));
      const newestWrite = Math.max(...stats.map((item) => item.mtimeMs));
      if (now - newestWrite < staleAfterMs) continue;
      await queue.enqueue(relativeDirectory);
      enqueued += 1;
    }
  }
  return enqueued;
}
