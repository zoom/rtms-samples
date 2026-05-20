import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { uploadArtifactFile } from '../shared/artifactClient.js';

const UPLOAD_EXTENSIONS = new Set(['.wav', '.mp4', '.vtt', '.srt', '.txt', '.md', '.json', '.jsonl']);

export class MediaArtifactRecorder {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.artifactStorageUrl = options.artifactStorageUrl || '';
    this.regionCode = options.regionCode || 'unknown';
    this.nodeId = options.nodeId || 'unknown';
    this.uploadTimeoutMs = Number(options.uploadTimeoutMs || 30000);
    this.uploadAttempts = Number(options.uploadAttempts || 3);
    this.finalizeDelayMs = Number(options.finalizeDelayMs || 2000);
    this.commonHelpersModule = options.commonHelpersModule || process.env.RTMS_COMMON_HELPERS_MODULE || '';
    this.helperManager = null;
    this.VideoGapFiller = null;
    this.streams = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (!this.enabled || this.initialized) return;
    const helperModule = await importCommonHelpers(this.commonHelpersModule);
    this.helperManager = helperModule.default || helperModule.HelperManager || helperModule;
    this.VideoGapFiller = helperModule.VideoGapFiller || this.helperManager?.gapfiller?.VideoGapFiller;
    this.initialized = true;
  }

  registerStream(streamId, metadata = {}) {
    if (!this.enabled || !streamId) return;
    const current = this.streams.get(streamId) || {};
    this.streams.set(streamId, {
      ...current,
      streamId,
      rtmsId: metadata.rtmsId || current.rtmsId || streamId,
      productType: metadata.productType || current.productType || 'unknown',
      startedAt: metadata.startedAt || current.startedAt || new Date().toISOString(),
      audioPackets: current.audioPackets || 0,
      videoPackets: current.videoPackets || 0,
      videoFiller: current.videoFiller || null
    });
  }

  recordAudio(event = {}) {
    if (!this.canRecordEvent(event)) return;
    this.registerStream(event.streamId, {
      rtmsId: event.meetingId || event.rtmsId,
      productType: event.productType
    });
    const state = this.streams.get(event.streamId);
    const rtmsId = event.meetingId || state.rtmsId || event.streamId;
    this.helperManager.audio.saveRawAudio(event.buffer, rtmsId, 'mixed', event.timestamp, event.streamId, true);
    state.rtmsId = rtmsId;
    state.productType = event.productType || state.productType;
    state.audioPackets += 1;
  }

  recordVideo(event = {}) {
    if (!this.canRecordEvent(event)) return;
    this.registerStream(event.streamId, {
      rtmsId: event.meetingId || event.rtmsId,
      productType: event.productType
    });
    const state = this.streams.get(event.streamId);
    const rtmsId = event.meetingId || state.rtmsId || event.streamId;
    state.rtmsId = rtmsId;
    state.productType = event.productType || state.productType;
    state.videoPackets += 1;

    if (!this.VideoGapFiller) {
      this.helperManager.video.saveRawVideo(event.buffer, 'mixed', event.timestamp, rtmsId, event.streamId, true);
      return;
    }

    if (!state.videoFiller) {
      state.videoFiller = new this.VideoGapFiller({ fps: Number(process.env.VIDEO_FPS || 25), gapThreshold: 320 });
      state.videoFiller.on('data', ({ buffer, timestamp }) => {
        this.helperManager.video.saveRawVideo(buffer, 'mixed', timestamp, rtmsId, event.streamId, true);
      });
      state.videoFiller.start();
    }

    state.videoFiller.push(event.buffer, event.timestamp);
  }

  async finalizeAndUpload(streamId, metadata = {}) {
    if (!this.enabled || !streamId) return [];
    await this.initialize();

    const state = this.streams.get(streamId) || {
      streamId,
      rtmsId: metadata.rtmsId || streamId,
      productType: metadata.productType || 'unknown'
    };
    state.rtmsId = metadata.rtmsId || state.rtmsId || streamId;
    state.productType = metadata.productType || state.productType || 'unknown';

    if (state.videoFiller) {
      state.videoFiller.stop();
      state.videoFiller = null;
    }

    this.helperManager.audio.closeAllAudioStreams?.();
    this.helperManager.video.closeAllVideoStreams?.();

    if (this.finalizeDelayMs > 0) {
      await delay(this.finalizeDelayMs);
    }

    await this.convertLocalMedia(state);

    const artifacts = this.artifactStorageUrl
      ? await this.uploadLocalArtifacts(state, metadata)
      : [];

    this.streams.delete(streamId);
    return artifacts;
  }

  async convertLocalMedia(state) {
    const folderPath = this.getRecordingFolder(state);
    if (!fs.existsSync(folderPath)) return;

    try {
      await this.helperManager.audiovideo.convertMeetingMedia(state.rtmsId, state.streamId);
    } catch (error) {
      console.warn(`[media-artifact-recorder] media conversion failed stream=${state.streamId}: ${error.message}`);
    }

    try {
      await this.helperManager.audiovideo.muxMixedAudioVideo(state.rtmsId, state.streamId);
    } catch (error) {
      console.warn(`[media-artifact-recorder] mixed mux failed stream=${state.streamId}: ${error.message}`);
    }
  }

  async uploadLocalArtifacts(state, metadata = {}) {
    const folderPath = this.getRecordingFolder(state);
    if (!fs.existsSync(folderPath)) return [];

    const files = fs.readdirSync(folderPath)
      .filter((fileName) => UPLOAD_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
      .sort(sortFinalMediaFirst);

    const uploads = [];
    for (const fileName of files) {
      const filePath = path.join(folderPath, fileName);
      if (!fs.statSync(filePath).isFile()) continue;

      const upload = await uploadArtifactFile(this.artifactStorageUrl, {
        streamId: state.streamId,
        rtmsId: state.rtmsId,
        regionCode: this.regionCode,
        productType: state.productType,
        artifactType: inferArtifactType(fileName),
        fileName,
        filePath,
        contentType: inferContentType(fileName),
        timeoutMs: this.uploadTimeoutMs,
        retryPolicy: {
          maxAttempts: this.uploadAttempts,
          baseDelayMs: 500,
          maxDelayMs: 3000
        },
        metadata: {
          nodeId: this.nodeId,
          source: 'rtms-manager-media-recorder',
          localPath: fileName,
          audioPackets: String(state.audioPackets || 0),
          videoPackets: String(state.videoPackets || 0),
          stoppedAt: metadata.stoppedAt || new Date().toISOString()
        }
      });
      uploads.push(upload.artifact);
    }

    return uploads;
  }

  getRecordingFolder(state) {
    const safeRtmsId = this.helperManager.filename.sanitize(state.rtmsId || state.streamId);
    const safeStreamId = this.helperManager.filename.sanitize(state.streamId);
    return path.join(process.cwd(), 'recordings', safeRtmsId, safeStreamId);
  }

  canRecordEvent(event = {}) {
    return this.enabled && this.initialized && event.streamId && Buffer.isBuffer(event.buffer);
  }
}

async function importCommonHelpers(configuredModule) {
  const candidates = [
    configuredModule,
    '/opt/library/javascript/commonHelpers/HelperManager.js',
    '/opt/rtms-common-helpers/HelperManager.js',
    path.resolve(process.cwd(), '../library/javascript/commonHelpers/HelperManager.js')
  ].filter(Boolean);

  const errors = [];
  for (const candidate of candidates) {
    try {
      const specifier = candidate.startsWith('file:')
        ? candidate
        : pathToFileURL(candidate).href;
      return await import(specifier);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }

  throw new Error(`Unable to load RTMS common helpers. Tried: ${errors.join('; ')}`);
}

function inferArtifactType(fileName = '') {
  const lower = fileName.toLowerCase();
  if (lower === 'mixed_final.mp4') return 'media_final';
  if (lower.endsWith('.wav')) return 'audio_final';
  if (lower.endsWith('.mp4')) return 'video_final';
  if (lower.endsWith('.vtt') || lower.endsWith('.srt') || lower.endsWith('.jsonl')) return 'transcript_final';
  if (lower.endsWith('.md')) return 'summary_final';
  return 'artifact';
}

function inferContentType(fileName = '') {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.vtt')) return 'text/vtt';
  if (lower.endsWith('.srt')) return 'application/x-subrip';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.jsonl')) return 'application/jsonl';
  return 'application/octet-stream';
}

function sortFinalMediaFirst(a, b) {
  const score = (name) => {
    if (name === 'mixed_final.mp4') return 0;
    if (name === 'mixed_audio.wav') return 1;
    if (name === 'mixed_video.mp4') return 2;
    return 10;
  };
  return score(a) - score(b) || a.localeCompare(b);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
