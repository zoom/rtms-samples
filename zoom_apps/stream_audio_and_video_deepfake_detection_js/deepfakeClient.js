import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_FETCH_TIMEOUT_MS = 15000;

function execFileJson(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout || 120000 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        parseError.stdout = stdout;
        parseError.stderr = stderr;
        reject(parseError);
      }
    });
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, label = 'Deepfake service') {
  const effectiveTimeout = Math.max(Number(timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS, 100);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  timer.unref?.();

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${label} request timed out after ${effectiveTimeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function canonicalizeLabel(label) {
  const raw = String(label || '').trim().toLowerCase();
  if (['real', 'realism', 'authentic', 'genuine', 'bonafide', 'bona_fide', 'bona fide', 'human'].includes(raw)) return 'real';
  if (['fake', 'deepfake', 'manipulated', 'synthetic', 'spoof', 'spoofed', 'cloned', 'ai'].includes(raw)) return 'fake';
  return raw;
}

export function normalizeScores(rawResult) {
  if (!rawResult) return {};

  if (rawResult.scores) {
    return Object.entries(rawResult.scores).reduce((scores, [label, score]) => {
      const canonical = canonicalizeLabel(label);
      if (canonical) scores[canonical] = Number(score || 0);
      return scores;
    }, {});
  }

  if (Array.isArray(rawResult)) {
    return rawResult.reduce((scores, item) => {
      const label = canonicalizeLabel(item.label);
      if (label) scores[label] = Number(item.score || 0);
      return scores;
    }, {});
  }

  if (Array.isArray(rawResult[0])) {
    return normalizeScores(rawResult[0]);
  }

  return rawResult;
}

export function buildDecision(scores, threshold) {
  const realScore = Number(scores.real ?? scores.Real ?? scores.REAL ?? 0);
  const fakeScore = Number(scores.fake ?? scores.Fake ?? scores.FAKE ?? 0);
  const label = realScore >= fakeScore ? 'real' : 'fake';
  const verified = realScore >= threshold && realScore >= fakeScore;
  const deepfake = fakeScore >= threshold && fakeScore > realScore;

  return {
    verified,
    deepfake,
    status: verified ? 'verified' : deepfake ? 'deepfake' : 'unverified',
    label,
    realScore,
    fakeScore
  };
}

const DEFAULT_SERVICE_BASE_URL = 'http://127.0.0.1:8012';
const DEFAULT_VIDEO_CLASSIFY_PATH = '/video/classify';
const DEFAULT_VIDEO_UPLOAD_PATH = '/video/upload';
const DEFAULT_VIDEO_HEALTH_PATH = '/video/health';
const DEFAULT_AUDIO_SERVICE_BASE_URL = 'https://your-deepfake-service.example.com';
const DEFAULT_AUDIO_CLASSIFY_PATH = '/audio/classify';
const DEFAULT_AUDIO_UPLOAD_PATH = '/audio/upload';
const DEFAULT_AUDIO_HEALTH_PATH = '/audio/health';

function normalizeServiceUrl(rawValue, defaultPath = DEFAULT_VIDEO_CLASSIFY_PATH) {
  const trimmed = String(rawValue || '').trim();
  const fallback = `${DEFAULT_SERVICE_BASE_URL}${defaultPath}`;
  if (!trimmed) return fallback;

  try {
    const url = new URL(trimmed);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = defaultPath;
    } else if (url.pathname === '/classify-video') {
      url.pathname = DEFAULT_VIDEO_CLASSIFY_PATH;
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

function deriveUploadUrl(classifyUrl) {
  try {
    const url = new URL(classifyUrl);
    url.pathname = url.pathname.startsWith('/audio/')
      ? DEFAULT_AUDIO_UPLOAD_PATH
      : DEFAULT_VIDEO_UPLOAD_PATH;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return `${DEFAULT_SERVICE_BASE_URL}${DEFAULT_VIDEO_UPLOAD_PATH}`;
  }
}

function getHealthUrl(serviceUrl) {
  const url = new URL(serviceUrl);
  if (url.pathname.startsWith('/video/')) {
    url.pathname = DEFAULT_VIDEO_HEALTH_PATH;
  } else if (url.pathname.startsWith('/audio/')) {
    url.pathname = DEFAULT_AUDIO_HEALTH_PATH;
  } else {
    url.pathname = '/health';
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function postBinaryService({ filePath, serviceUrl, apiKey, modelName, metadata, contentType, errorLabel, timeoutMs }) {
  if (!serviceUrl) {
    throw new Error(`${errorLabel} service URL is required for service mode`);
  }

  const mediaBuffer = await fs.readFile(filePath);
  const headers = {
    'Content-Type': contentType,
    'X-Clip-Name': path.basename(filePath),
    'X-Deepfake-Model': modelName
  };

  if (metadata && Object.keys(metadata).length > 0) {
    headers['X-Deepfake-Metadata'] = JSON.stringify(metadata);
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchWithTimeout(
    serviceUrl,
    {
      method: 'POST',
      headers,
      body: mediaBuffer
    },
    timeoutMs,
    errorLabel
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${errorLabel} service inference failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function postAudioPcmService({ filePath, serviceUrl, apiKey, metadata = {}, errorLabel, timeoutMs }) {
  if (!serviceUrl) {
    throw new Error(`${errorLabel} service URL is required for service mode`);
  }
  if (!apiKey) {
    throw new Error(`${errorLabel} service API key is required`);
  }

  const audioBuffer = await fs.readFile(filePath);
  const zoomUserId = metadata.zoomUserId ?? metadata.selectedParticipant?.userId ?? metadata.userId ?? '';
  const zoomUserName = metadata.zoomUserName ?? metadata.selectedParticipant?.userName ?? metadata.userName ?? '';
  const sampleRate = Number(metadata.sampleRate || 16000);
  const channels = Number(metadata.channels || 1);
  const audioMetadata = {
    streamId: metadata.streamId ?? null,
    meetingId: metadata.meetingId ?? null,
    windowStartMs: metadata.windowStartMs ?? null,
    windowEndMs: metadata.windowEndMs ?? null,
    durationSeconds: metadata.durationSeconds ?? null,
    sampleCount: metadata.sampleCount ?? null,
    audioStats: metadata.audioStats ?? null
  };

  const headers = {
    'Content-Type': 'audio/L16',
    'X-Audio-Format': 'pcm_s16le',
    'X-Audio-Sample-Rate': String(sampleRate),
    'X-Audio-Channels': String(channels),
    'X-Clip-Name': path.basename(filePath),
    'X-Zoom-User-Id': String(zoomUserId),
    'X-Zoom-User-Name': String(zoomUserName),
    'X-Audio-Metadata': JSON.stringify(audioMetadata),
    Authorization: `Bearer ${apiKey}`
  };

  const response = await fetchWithTimeout(
    serviceUrl,
    {
      method: 'POST',
      headers,
      body: audioBuffer
    },
    timeoutMs,
    errorLabel
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${errorLabel} service inference failed: ${response.status} ${body}`);
  }

  return response.json();
}

export class DeepfakeClient {
  constructor(options = {}) {
    const requestedMode = String(options.mode || 'service').toLowerCase();
    if (requestedMode === 'off' || requestedMode === 'local_cli') {
      this.mode = requestedMode;
    } else {
      this.mode = 'service';
    }
    this.modelName = options.modelName || 'Naman712/Deep-fake-detection';
    this.serviceUrl = normalizeServiceUrl(options.serviceUrl || `${DEFAULT_SERVICE_BASE_URL}${DEFAULT_VIDEO_CLASSIFY_PATH}`);
    this.uploadUrl = normalizeServiceUrl(options.uploadUrl || deriveUploadUrl(this.serviceUrl), DEFAULT_VIDEO_UPLOAD_PATH);
    this.apiKey = options.apiKey || '';
    this.pythonBin = options.pythonBin || 'python3';
    this.threshold = Number(options.threshold || 0.75);
    this.vendorName = options.vendorName || this.modelName;
    this.timeoutMs = Number(options.timeoutMs || process.env.DEEPFAKE_FETCH_TIMEOUT_MS || DEFAULT_FETCH_TIMEOUT_MS);
    this.scriptPath = options.scriptPath
      || process.env.DEEPFAKE_LOCAL_SCRIPT_PATH
      || path.join(__dirname, 'classify_clip.py');
  }

  async checkHealth() {
    if (this.mode === 'off') {
      return {
        ok: true,
        mode: this.mode,
        skipped: true,
        reason: 'Deepfake detection disabled'
      };
    }

    if (this.mode === 'service') {
      const healthUrl = getHealthUrl(this.serviceUrl);
      const headers = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetchWithTimeout(
        healthUrl,
        { headers },
        this.timeoutMs,
        'Video deepfake health check'
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Deepfake service health check failed: ${response.status} ${body}`);
      }

      const payload = await response.json();
      return {
        ok: Boolean(payload?.ok),
        mode: this.mode,
        ...payload
      };
    }

    return {
      ok: true,
      mode: this.mode,
      skipped: true,
      reason: `No startup health probe for mode ${this.mode}`
    };
  }

  async classifyVideo(videoPath, metadata = {}) {
    if (this.mode === 'off') {
      return {
        mode: 'off',
        skipped: true,
        reason: 'Deepfake detection disabled',
        timestamp: Date.now(),
        metadata
      };
    }

    let rawResult;
    if (this.mode === 'service') {
      rawResult = await this.classifyService(videoPath, metadata);
    } else if (this.mode === 'local_cli') {
      rawResult = await this.classifyLocal(videoPath);
    } else {
      throw new Error(`Unsupported DEEPFAKE_MODE: ${this.mode}`);
    }

    const scores = normalizeScores(rawResult);
    const decision = buildDecision(scores, this.threshold);

    return {
      mode: this.mode,
      vendorName: this.vendorName,
      modelName: this.modelName,
      threshold: this.threshold,
      scores,
      ...decision,
      rawResult,
      timestamp: Date.now(),
      metadata
    };
  }

  async classifyFrame(mediaPath, metadata = {}) {
    return this.classifyVideo(mediaPath, metadata);
  }

  async classifyLocal(videoPath) {
    return execFileJson(this.pythonBin, [
      this.scriptPath,
      '--video', videoPath,
      '--model', this.modelName
    ], { timeout: Math.max(this.timeoutMs, 30000) });
  }

  async classifyService(videoPath, metadata = {}) {
    return postBinaryService({
      filePath: videoPath,
      serviceUrl: this.serviceUrl,
      apiKey: this.apiKey,
      modelName: this.modelName,
      metadata,
      contentType: 'video/mp4',
      errorLabel: 'Video deepfake',
      timeoutMs: this.timeoutMs
    });
  }
}

export class AudioDeepfakeClient {
  constructor(options = {}) {
    const requestedMode = String(options.mode || 'off').toLowerCase();
    this.mode = requestedMode === 'service' ? 'service' : 'off';
    this.modelName = options.modelName || 'Audio Deepfake Detector';
    this.serviceUrl = normalizeServiceUrl(
      options.serviceUrl || `${DEFAULT_AUDIO_SERVICE_BASE_URL}${DEFAULT_AUDIO_CLASSIFY_PATH}`,
      DEFAULT_AUDIO_CLASSIFY_PATH
    );
    this.uploadUrl = normalizeServiceUrl(options.uploadUrl || deriveUploadUrl(this.serviceUrl), DEFAULT_AUDIO_UPLOAD_PATH);
    this.apiKey = options.apiKey || '';
    this.threshold = Number(options.threshold || 0.75);
    this.vendorName = options.vendorName || this.modelName;
    this.timeoutMs = Number(options.timeoutMs || process.env.DEEPFAKE_FETCH_TIMEOUT_MS || DEFAULT_FETCH_TIMEOUT_MS);
    this.healthcheckEnabled = options.healthcheckEnabled === true;
  }

  async checkHealth() {
    if (this.mode === 'off') {
      return {
        ok: true,
        mode: this.mode,
        skipped: true,
        reason: 'Audio deepfake detection disabled'
      };
    }

    if (!this.healthcheckEnabled) {
      return {
        ok: true,
        mode: this.mode,
        skipped: true,
        reason: 'Audio deepfake health check disabled (AUDIO_DEEPFAKE_HEALTHCHECK_ENABLED=false)'
      };
    }

    const healthUrl = getHealthUrl(this.serviceUrl);
    if (!this.apiKey) {
      throw new Error('Audio deepfake service API key is required');
    }
    const headers = {
      Authorization: `Bearer ${this.apiKey}`
    };

    const response = await fetchWithTimeout(
      healthUrl,
      { headers },
      this.timeoutMs,
      'Audio deepfake health check'
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Audio deepfake service health check failed: ${response.status} ${body}`);
    }

    const payload = await response.json();
    return {
      ok: Boolean(payload?.ok),
      mode: this.mode,
      ...payload
    };
  }

  async classifyAudio(audioPath, metadata = {}) {
    if (this.mode === 'off') {
      return {
        mode: 'off',
        skipped: true,
        reason: 'Audio deepfake detection disabled',
        timestamp: Date.now(),
        metadata
      };
    }

    const rawResult = await postAudioPcmService({
      filePath: audioPath,
      serviceUrl: this.serviceUrl,
      apiKey: this.apiKey,
      metadata,
      errorLabel: 'Audio deepfake',
      timeoutMs: this.timeoutMs
    });

    const scores = normalizeScores(rawResult);
    const decision = buildDecision(scores, this.threshold);

    return {
      mode: this.mode,
      vendorName: this.vendorName,
      modelName: this.modelName,
      threshold: this.threshold,
      scores,
      ...decision,
      audioInfo: rawResult?.audioInfo || null,
      serviceMetadata: rawResult?.metadata || null,
      rawResult,
      timestamp: Date.now(),
      metadata
    };
  }
}

export default DeepfakeClient;
