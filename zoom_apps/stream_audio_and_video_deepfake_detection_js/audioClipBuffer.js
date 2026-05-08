import fs from 'fs';
import path from 'path';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath, keepFiles = new Set(['.gitkeep'])) {
  ensureDir(dirPath);
  for (const entry of fs.readdirSync(dirPath)) {
    if (keepFiles.has(entry)) continue;
    fs.rmSync(path.join(dirPath, entry), { recursive: true, force: true });
  }
}

function safeToken(value, fallback = 'unknown') {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || fallback;
}

function calculatePcmStats(pcmBuffer, { bitsPerSample, channels, sampleRate }) {
  if (!pcmBuffer?.length || bitsPerSample !== 16) {
    return null;
  }

  const sampleCount = Math.floor(pcmBuffer.length / 2 / channels);
  if (sampleCount <= 0) {
    return null;
  }

  let sumSquares = 0;
  let sumAbs = 0;
  let zeroCount = 0;
  let clippedCount = 0;
  let min = 32767;
  let max = -32768;
  const totalSamples = Math.floor(pcmBuffer.length / 2);

  for (let i = 0; i < totalSamples; i += 1) {
    const sample = pcmBuffer.readInt16LE(i * 2);
    const absSample = Math.abs(sample);
    if (sample === 0) zeroCount += 1;
    if (absSample >= 32760) clippedCount += 1;
    if (sample < min) min = sample;
    if (sample > max) max = sample;
    sumAbs += absSample;
    sumSquares += sample * sample;
  }

  const rms = Math.sqrt(sumSquares / totalSamples);
  const rmsDbfs = rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity;

  return {
    sampleRate,
    sampleCount,
    min,
    max,
    meanAbs: sumAbs / totalSamples,
    rms,
    rmsDbfs,
    zeroRatio: zeroCount / totalSamples,
    clippedRatio: clippedCount / totalSamples
  };
}

export class AudioClipBuffer {
  constructor(options = {}) {
    this.clipDir = options.clipDir;
    this.sampleRate = Number(options.sampleRate || 16000);
    this.channels = Number(options.channels || 1);
    this.bitsPerSample = Number(options.bitsPerSample || 16);
    this.clipSeconds = Number(options.clipSeconds || 4);
    this.maxClips = Number(options.maxClips || 24);
    this.bytesPerSecond = this.sampleRate * this.channels * (this.bitsPerSample / 8);
    this.clipBytes = Math.max(Math.round(this.bytesPerSecond * this.clipSeconds), 1);
    this.sequence = 0;
    this.pending = Buffer.alloc(0);
    this.pendingWindowStartMs = null;
    this.latestClip = null;
    this.lastMetadata = null;
    cleanDir(this.clipDir);
  }

  reset() {
    this.sequence = 0;
    this.pending = Buffer.alloc(0);
    this.pendingWindowStartMs = null;
    this.latestClip = null;
    this.lastMetadata = null;
    cleanDir(this.clipDir);
  }

  writeAudio(buffer, metadata = {}) {
    if (!buffer?.length) return null;

    this.lastMetadata = metadata;
    if (this.pending.length === 0) {
      this.pendingWindowStartMs = metadata.timestamp ?? Date.now();
    }
    this.pending = Buffer.concat([this.pending, buffer]);

    let latestWritten = null;
    while (this.pending.length >= this.clipBytes) {
      const pcmClip = this.pending.subarray(0, this.clipBytes);
      this.pending = this.pending.subarray(this.clipBytes);
      latestWritten = this.writeClip(pcmClip, {
        ...metadata,
        windowStartMs: this.pendingWindowStartMs,
        windowEndMs: metadata.timestamp ?? Date.now()
      });
      this.pendingWindowStartMs = this.pending.length > 0
        ? (metadata.timestamp ?? Date.now())
        : null;
    }

    return latestWritten;
  }

  writeClip(pcmClip, metadata = {}) {
    ensureDir(this.clipDir);
    const clipName = `rtms-user-${safeToken(metadata.userId)}-${String(this.sequence + 1).padStart(4, '0')}.pcm`;
    this.sequence += 1;
    const clipPath = path.join(this.clipDir, clipName);

    fs.writeFileSync(clipPath, pcmClip);

    const stats = fs.statSync(clipPath);
    const audioStats = calculatePcmStats(pcmClip, {
      bitsPerSample: this.bitsPerSample,
      channels: this.channels,
      sampleRate: this.sampleRate
    });
    this.latestClip = {
      path: clipPath,
      name: clipName,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      durationSeconds: this.clipSeconds,
      sampleCount: pcmClip.length / (this.bitsPerSample / 8) / this.channels,
      sampleRate: this.sampleRate,
      channels: this.channels,
      audioStats,
      format: 'pcm_s16le',
      userId: metadata.userId ?? null,
      userName: metadata.userName ?? null,
      streamId: metadata.streamId ?? null,
      windowStartMs: metadata.windowStartMs ?? null,
      windowEndMs: metadata.windowEndMs ?? null
    };

    this.deleteOldClips();
    return this.latestClip;
  }

  deleteOldClips() {
    const files = fs.readdirSync(this.clipDir)
      .filter((entry) => entry.endsWith('.pcm'))
      .map((entry) => {
        const clipPath = path.join(this.clipDir, entry);
        const stats = fs.statSync(clipPath);
        return { path: clipPath, mtimeMs: stats.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files.slice(this.maxClips)) {
      fs.rmSync(file.path, { force: true });
    }
  }

  getLatestClip() {
    if (!this.latestClip) return null;
    if (!fs.existsSync(this.latestClip.path)) return null;
    const stats = fs.statSync(this.latestClip.path);
    return {
      ...this.latestClip,
      size: stats.size,
      mtimeMs: stats.mtimeMs
    };
  }

  hasLatestClip() {
    return Boolean(this.getLatestClip());
  }
}

export default AudioClipBuffer;
