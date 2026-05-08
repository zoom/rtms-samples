import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const START_CODE_4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);

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

function safeWrite(stream, buffer, label) {
  if (!stream || stream.destroyed || !stream.writable) return false;
  try {
    return stream.write(buffer);
  } catch (error) {
    console.warn(`[HLS] Failed to write ${label}: ${error.message}`);
    return false;
  }
}

function attachChildStreamErrorGuards(child, label, emit) {
  for (const stream of child.stdio || []) {
    if (!stream || typeof stream.on !== 'function') continue;
    stream.on('error', (error) => {
      if (error?.code === 'ECONNRESET' || error?.code === 'EPIPE') {
        emit('log', `[${label}] ignored stream error ${error.code}`);
        return;
      }
      emit('error', new Error(`${label} stream error: ${error.message}`));
    });
  }
}

function hasAnnexBStartCode(buffer) {
  if (!buffer || buffer.length < 4) return false;
  for (let i = 0; i <= buffer.length - 3; i += 1) {
    if (
      buffer[i] === 0x00 &&
      buffer[i + 1] === 0x00 &&
      (buffer[i + 2] === 0x01 || (buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01))
    ) {
      return true;
    }
  }
  return false;
}

function ensureAnnexB(buffer) {
  if (!buffer?.length) return null;
  return hasAnnexBStartCode(buffer) ? buffer : Buffer.concat([START_CODE_4, buffer]);
}

function splitNalUnits(buffer) {
  const nalUnits = [];
  if (!buffer?.length) return nalUnits;

  let start = -1;
  let nalStart = -1;

  for (let i = 0; i <= buffer.length - 3; i += 1) {
    let startCodeLength = 0;

    if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 && buffer[i + 2] === 0x01) {
      startCodeLength = 3;
    } else if (
      i <= buffer.length - 4 &&
      buffer[i] === 0x00 &&
      buffer[i + 1] === 0x00 &&
      buffer[i + 2] === 0x00 &&
      buffer[i + 3] === 0x01
    ) {
      startCodeLength = 4;
    }

    if (startCodeLength === 0) continue;

    if (start !== -1) {
      nalUnits.push(buffer.subarray(start, i));
    }

    start = i;
    nalStart = i + startCodeLength;
    i += startCodeLength - 1;
  }

  if (start !== -1 && nalStart !== -1 && nalStart < buffer.length) {
    nalUnits.push(buffer.subarray(start));
  }

  return nalUnits;
}

function getNalUnitType(nalUnit) {
  if (!nalUnit?.length) return null;
  let headerIndex = -1;

  for (let i = 0; i <= nalUnit.length - 3; i += 1) {
    if (nalUnit[i] === 0x00 && nalUnit[i + 1] === 0x00 && nalUnit[i + 2] === 0x01) {
      headerIndex = i + 3;
      break;
    }
    if (
      i <= nalUnit.length - 4 &&
      nalUnit[i] === 0x00 &&
      nalUnit[i + 1] === 0x00 &&
      nalUnit[i + 2] === 0x00 &&
      nalUnit[i + 3] === 0x01
    ) {
      headerIndex = i + 4;
      break;
    }
  }

  if (headerIndex === -1 || headerIndex >= nalUnit.length) return null;
  return nalUnit[headerIndex] & 0x1f;
}

export class HlsPipeline extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ffmpegPath = options.ffmpegPath || 'ffmpeg';
    this.hlsDir = options.hlsDir;
    this.clipDir = options.clipDir;
    this.threadQueueSize = Number(options.threadQueueSize || 1024);
    this.videoFps = Number(options.videoFps || 25);
    this.frameFps = Number(options.frameFps || 0.33);
    this.hlsSegmentSeconds = Number(options.hlsSegmentSeconds || 2);
    this.clipSegmentSeconds = Number(options.clipSegmentSeconds || 4);
    this.hlsListSize = Number(options.hlsListSize || 6);
    this.clipStableAgeMs = Number(options.clipStableAgeMs || Math.max(this.clipSegmentSeconds * 1000 + 1000, 5000));
    this.clipMinBytes = Number(options.clipMinBytes || 4096);
    this.enabled = options.enabled !== false;
    this.vendorName = options.vendorName || 'Deepfake Detector';

    this.hlsProcess = null;
    this.clipProcess = null;
    this.started = false;
    this.readyAnnounced = false;
    this.readyTimer = null;
    this.isStopping = false;
    this.playlistPath = path.join(this.hlsDir, 'stream.m3u8');
    this.segmentPattern = path.join(this.hlsDir, 'segment_%03d.ts');
    this.clipPattern = path.join(this.clipDir, 'clip_%03d.mp4');
    this.latestSps = null;
    this.latestPps = null;
    this.videoPrimed = false;
    this.waitingForDecoderConfigLogged = false;
  }

  start() {
    if (!this.enabled || this.started) return;

    this.isStopping = false;
    cleanDir(this.hlsDir);
    cleanDir(this.clipDir);

    this.hlsProcess = this.startHlsProcess();
    this.clipProcess = this.startClipProcess();
    this.started = true;
    this.readyAnnounced = false;
    this.waitForOutputs();
  }

  waitForOutputs() {
    if (this.readyTimer) return;

    this.readyTimer = setInterval(() => {
      if (!this.started) {
        clearInterval(this.readyTimer);
        this.readyTimer = null;
        return;
      }

      try {
        const playlistStats = fs.statSync(this.playlistPath);
        const hasSegment = fs.readdirSync(this.hlsDir).some((entry) => entry.endsWith('.ts'));
        if (playlistStats.isFile() && playlistStats.size > 0 && hasSegment && !this.readyAnnounced) {
          this.readyAnnounced = true;
          clearInterval(this.readyTimer);
          this.readyTimer = null;
          this.emit('started', {
            playlistUrl: '/hls/stream.m3u8'
          });
        }
      } catch {
        // Keep polling until ffmpeg has produced the initial playlist.
      }
    }, 250);
  }

  startHlsProcess() {
    const queueSize = String(Math.max(this.threadQueueSize || 1024, 64));
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '50M',
      '-analyzeduration', '50M',
      '-thread_queue_size', queueSize,
      '-framerate', String(this.videoFps),
      '-f', 'h264',
      '-i', 'pipe:3',
      '-thread_queue_size', queueSize,
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
      '-i', 'pipe:4',
      '-filter_complex',
      '[1:a]aresample=44100[aout];[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[vout]',
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-g', String(this.videoFps * 2),
      '-keyint_min', String(this.videoFps * 2),
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-f', 'hls',
      '-hls_time', String(this.hlsSegmentSeconds),
      '-hls_list_size', String(this.hlsListSize),
      '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
      '-hls_segment_filename', this.segmentPattern,
      this.playlistPath
    ];

    const child = spawn(this.ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
    });

    attachChildStreamErrorGuards(child, 'ffmpeg:hls', this.emit.bind(this));

    child.stderr.on('data', (chunk) => {
      this.emit('log', `[ffmpeg:hls] ${chunk.toString().trim()}`);
    });

    child.on('error', (error) => {
      this.emit('error', new Error(`HLS ffmpeg failed: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      this.emit('log', `[ffmpeg:hls] exited code=${code} signal=${signal}`);
      this.handleChildExit('hls', code, signal);
    });

    return child;
  }

  startClipProcess() {
    const fps = Math.max(this.frameFps || 0.33, 0.1);
    const gop = Math.max(Math.round(fps * this.clipSegmentSeconds), 1);
    const queueSize = String(Math.max(this.threadQueueSize || 1024, 64));
    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-fflags', 'nobuffer',
      '-probesize', '50M',
      '-analyzeduration', '50M',
      '-thread_queue_size', queueSize,
      '-framerate', String(this.videoFps),
      '-f', 'h264',
      '-i', 'pipe:3',
      '-vf', `fps=${fps}`,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-g', String(gop),
      '-keyint_min', String(gop),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${this.clipSegmentSeconds})`,
      '-f', 'segment',
      '-segment_time', String(this.clipSegmentSeconds),
      '-segment_time_delta', '0.05',
      '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+faststart',
      '-reset_timestamps', '1',
      this.clipPattern
    ];

    const child = spawn(this.ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe']
    });

    attachChildStreamErrorGuards(child, 'ffmpeg:clips', this.emit.bind(this));

    child.stderr.on('data', (chunk) => {
      this.emit('log', `[ffmpeg:clips] ${chunk.toString().trim()}`);
    });

    child.on('error', (error) => {
      this.emit('error', new Error(`Clip ffmpeg failed: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      this.emit('log', `[ffmpeg:clips] exited code=${code} signal=${signal}`);
      this.handleChildExit('clips', code, signal);
    });

    return child;
  }

  handleChildExit(kind, code, signal) {
    if (kind === 'hls') {
      this.hlsProcess = null;
    } else if (kind === 'clips') {
      this.clipProcess = null;
    }

    if (this.isStopping) return;

    const cleanExit = code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL';
    if (cleanExit) return;

    if (this.readyTimer) {
      clearInterval(this.readyTimer);
      this.readyTimer = null;
    }

    this.started = false;
    this.readyAnnounced = false;
    this.videoPrimed = false;
    this.waitingForDecoderConfigLogged = false;
    this.emit('reset', { kind, code, signal });
    this.emit('log', `[HLS] Reset ${kind} pipeline after unexpected ffmpeg exit; waiting for next SPS/PPS/IDR keyframe`);
  }

  inspectVideo(buffer) {
    const normalized = ensureAnnexB(buffer);
    if (!normalized?.length) {
      return { normalized: null, ready: false, shouldPrime: false };
    }

    const nalUnits = splitNalUnits(normalized);
    let packetSps = null;
    let packetPps = null;
    let hasIdr = false;

    for (const nalUnit of nalUnits) {
      const nalType = getNalUnitType(nalUnit);
      if (nalType === 7) packetSps = nalUnit;
      if (nalType === 8) packetPps = nalUnit;
      if (nalType === 5) hasIdr = true;
    }

    if (packetSps) this.latestSps = packetSps;
    if (packetPps) this.latestPps = packetPps;

    const hasDecoderConfig = Boolean(this.latestSps && this.latestPps);
    const shouldPrime = !this.videoPrimed && hasDecoderConfig && hasIdr;

    return {
      normalized,
      ready: this.videoPrimed || shouldPrime,
      shouldPrime
    };
  }

  writeVideo(buffer) {
    if (!this.enabled || !buffer?.length) return;

    const analysis = this.inspectVideo(buffer);
    if (!analysis.normalized) return;

    if (!analysis.ready) {
      if (!this.waitingForDecoderConfigLogged) {
        this.waitingForDecoderConfigLogged = true;
        this.emit('log', '[HLS] Waiting for SPS/PPS/IDR before starting ffmpeg video pipelines');
      }
      return;
    }

    if (analysis.shouldPrime) {
      this.start();
      this.videoPrimed = true;
      this.waitingForDecoderConfigLogged = false;

      const primeParts = [];
      if (this.latestSps) primeParts.push(this.latestSps);
      if (this.latestPps) primeParts.push(this.latestPps);
      primeParts.push(analysis.normalized);
      const primedBuffer = Buffer.concat(primeParts);

      safeWrite(this.hlsProcess?.stdio?.[3], primedBuffer, 'video to HLS');
      safeWrite(this.clipProcess?.stdio?.[3], primedBuffer, 'video to clip segmenter');
      return;
    }

    if (!this.started) {
      this.start();
    }

    safeWrite(this.hlsProcess?.stdio?.[3], analysis.normalized, 'video to HLS');
    safeWrite(this.clipProcess?.stdio?.[3], analysis.normalized, 'video to clip segmenter');
  }

  writeAudio(buffer) {
    if (!this.enabled || !buffer?.length) return;
    if (!this.started) return;
    safeWrite(this.hlsProcess?.stdio?.[4], buffer, 'audio to HLS');
  }

  getLatestClip() {
    try {
      const files = fs.readdirSync(this.clipDir)
        .filter((entry) => entry.endsWith('.mp4'))
        .map((entry) => {
          const clipPath = path.join(this.clipDir, entry);
          const stats = fs.statSync(clipPath);
          return { path: clipPath, mtimeMs: stats.mtimeMs, size: stats.size };
        })
        .filter((entry) => entry.size >= this.clipMinBytes)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      if (files.length === 0) return null;

      const stableAgeMs = this.clipStableAgeMs;
      const now = Date.now();

      for (const file of files) {
        if (now - file.mtimeMs >= stableAgeMs) {
          return file;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  hasLatestClip() {
    return Boolean(this.getLatestClip());
  }

  stop() {
    this.isStopping = true;
    if (this.readyTimer) {
      clearInterval(this.readyTimer);
      this.readyTimer = null;
    }
    for (const child of [this.hlsProcess, this.clipProcess]) {
      if (!child || child.killed) continue;
      for (const stream of child.stdio || []) {
        if (stream && typeof stream.end === 'function') {
          try {
            stream.end();
          } catch {
            // Ignore shutdown races.
          }
        }
      }
      child.kill('SIGTERM');
    }

    this.hlsProcess = null;
    this.clipProcess = null;
    this.started = false;
    this.readyAnnounced = false;
    this.latestSps = null;
    this.latestPps = null;
    this.videoPrimed = false;
    this.waitingForDecoderConfigLogged = false;
  }
}

export default HlsPipeline;
