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

function writeWavFile(filePath, pcmBuffer, { sampleRate, channels, bitsPerSample }) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  fs.writeFileSync(filePath, Buffer.concat([header, pcmBuffer]));
}

export class AudioWindowBuffer {
  constructor(options = {}) {
    this.outputDir = options.outputDir;
    this.sampleRate = Number(options.sampleRate || 16000);
    this.channels = Number(options.channels || 1);
    this.bitsPerSample = Number(options.bitsPerSample || 16);
    this.windowSeconds = Number(options.windowSeconds || 10);
    this.maxWindows = Number(options.maxWindows || 24);
    this.bytesPerSecond = this.sampleRate * this.channels * (this.bitsPerSample / 8);
    this.windowBytes = Math.max(Math.round(this.bytesPerSecond * this.windowSeconds), 1);
    this.sequence = 0;
    this.pending = Buffer.alloc(0);
    this.pendingWindowStartMs = null;
    cleanDir(this.outputDir);
  }

  reset() {
    this.sequence = 0;
    this.pending = Buffer.alloc(0);
    this.pendingWindowStartMs = null;
    cleanDir(this.outputDir);
  }

  writeAudio(buffer, metadata = {}) {
    if (!buffer?.length) return [];

    if (this.pending.length === 0) {
      this.pendingWindowStartMs = metadata.timestamp ?? Date.now();
    }

    this.pending = Buffer.concat([this.pending, buffer]);
    const windows = [];

    while (this.pending.length >= this.windowBytes) {
      const pcmWindow = this.pending.subarray(0, this.windowBytes);
      this.pending = this.pending.subarray(this.windowBytes);
      windows.push(this.writeWindow(pcmWindow, {
        ...metadata,
        windowStartMs: this.pendingWindowStartMs,
        windowEndMs: metadata.timestamp ?? Date.now()
      }));
      this.pendingWindowStartMs = this.pending.length > 0
        ? (metadata.timestamp ?? Date.now())
        : null;
    }

    return windows;
  }

  writeWindow(pcmWindow, metadata = {}) {
    ensureDir(this.outputDir);
    const fileName = `rtms-audio-window-${String(this.sequence + 1).padStart(4, '0')}.wav`;
    this.sequence += 1;
    const filePath = path.join(this.outputDir, fileName);

    writeWavFile(filePath, pcmWindow, {
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample
    });

    const stats = fs.statSync(filePath);
    const window = {
      fileName,
      filePath,
      size: stats.size,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample,
      durationSeconds: this.windowSeconds,
      sampleCount: pcmWindow.length / (this.bitsPerSample / 8) / this.channels,
      streamId: metadata.streamId ?? null,
      meetingId: metadata.meetingId ?? null,
      userId: metadata.userId ?? null,
      userName: metadata.userName ?? null,
      windowStartMs: metadata.windowStartMs ?? null,
      windowEndMs: metadata.windowEndMs ?? null
    };

    this.deleteOldWindows();
    return window;
  }

  deleteOldWindows() {
    const files = fs.readdirSync(this.outputDir)
      .filter((entry) => entry.endsWith('.wav'))
      .map((entry) => {
        const filePath = path.join(this.outputDir, entry);
        const stats = fs.statSync(filePath);
        return { filePath, mtimeMs: stats.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files.slice(this.maxWindows)) {
      fs.rmSync(file.filePath, { force: true });
    }
  }
}

export default AudioWindowBuffer;
