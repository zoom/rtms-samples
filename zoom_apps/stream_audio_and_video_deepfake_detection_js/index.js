import express from 'express';
import { closeHttpServer, installGracefulShutdown } from '../../library/javascript/commonHelpers/gracefulShutdown.js';
import http from 'http';
import crypto from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { RTMSManager } from '../../library/javascript/rtmsManager/RTMSManager.js';
import WebhookManager from '../../library/javascript/webhookManager/WebhookManager.js';
import { HlsPipeline } from './hlsPipeline.js';
import { AudioClipBuffer } from './audioClipBuffer.js';
import { AudioDeepfakeClient, DeepfakeClient } from './deepfakeClient.js';
import {
  SessionManager,
  createSocketAuthorizer,
  decryptZoomAppContext,
  mintWsAuthToken
} from './sessionManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const MEDIA_TYPE_FLAGS = Object.freeze({
  audio: RTMSManager.MEDIA.AUDIO,
  video: RTMSManager.MEDIA.VIDEO,
  screenshare: RTMSManager.MEDIA.SHARESCREEN,
  transcript: RTMSManager.MEDIA.TRANSCRIPT,
  chat: RTMSManager.MEDIA.CHAT,
});

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function normalizeMode(value, fallback) {
  return String(value || fallback).trim().toLowerCase();
}

function normalizeDeepfakeMode(value) {
  const mode = normalizeMode(value, 'service');
  return ['off', 'local_cli'].includes(mode) ? mode : 'service';
}

function normalizeAudioDeepfakeMode(value) {
  const mode = normalizeMode(value, 'off');
  return mode === 'service' ? 'service' : 'off';
}

function isProtectedRequestPath(requestPath = '') {
  const normalizedPath = String(requestPath || '').split('?')[0].toLowerCase();
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.'))) {
    return true;
  }

  const blockedNames = new Set([
    '.env',
    '.env.example',
    '.git',
    '.gitignore',
    '.npmrc',
    'package-lock.json',
    'package.json',
    'pyvenv.cfg',
    'ecosystem.config.js',
    'tmp_clips',
    'tmp_hls'
  ]);

  return segments.some((segment) => blockedNames.has(segment));
}

function getDeepfakeFrameFps() {
  const configuredFps = Number(process.env.DEEPFAKE_FRAME_FPS);
  if (Number.isFinite(configuredFps) && configuredFps > 0) {
    return configuredFps;
  }
  return 5;
}

function getDeepfakeClipSeconds() {
  return Math.max(envNumber('DEEPFAKE_CLIP_SECONDS', 2), 1);
}

function getAudioDeepfakeClipSeconds() {
  return Math.max(envNumber('AUDIO_DEEPFAKE_CLIP_SECONDS', 4), 1);
}

function getMediaTypesFromEnv() {
  const names = String(process.env.RTMS_MEDIA_TYPES || 'audio,video')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error('RTMS_MEDIA_TYPES must contain unique media names');
  }
  return names.reduce((flags, name) => {
    const flag = MEDIA_TYPE_FLAGS[name];
    if (!flag) throw new Error(`Unsupported RTMS media type: ${name}`);
    return flags | flag;
  }, 0);
}

function validateRequiredEnv(names) {
  const missing = names.filter((name) => !process.env[name] || String(process.env[name]).trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function validateServiceApiKey({ mode, apiKey, envName, serviceName }) {
  if (mode === 'service' && (!apiKey || String(apiKey).trim() === '')) {
    throw new Error(`${serviceName} service mode requires ${envName}.`);
  }
}

function includesMedia(mediaTypes, mediaType) {
  return Boolean(mediaTypes & mediaType);
}

function validateRuntimeConfig({ mediaTypes, videoMode, audioMode, hlsEnabled }) {
  if (!includesMedia(mediaTypes, RTMSManager.MEDIA.VIDEO)) {
    throw new Error('This sample requires video media. Add video to RTMS_MEDIA_TYPES.');
  }

  if (videoMode !== 'individual' && videoMode !== 'single_individual') {
    throw new Error('This sample is designed for RTMS individual video. Set VIDEO_STREAM_MODE=individual.');
  }

  if (hlsEnabled && !includesMedia(mediaTypes, RTMSManager.MEDIA.AUDIO)) {
    throw new Error('HLS preview currently muxes video with RTMS audio. Add audio to RTMS_MEDIA_TYPES or set ENABLE_HLS_PREVIEW=false.');
  }

  if (audioMode !== 'multi' && audioMode !== 'multiple') {
    throw new Error('This sample requires individual RTMS audio. Set AUDIO_STREAM_MODE=multi.');
  }
}

function getAudioDataOptFromEnv() {
  const audioMode = normalizeMode(process.env.AUDIO_STREAM_MODE, 'multi');
  switch (audioMode) {
    case 'multi':
    case 'multiple':
      return MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MULTI_STREAMS;
    default:
      throw new Error(`Unsupported AUDIO_STREAM_MODE: ${process.env.AUDIO_STREAM_MODE}`);
  }
}

function getVideoDataOptFromEnv() {
  const videoMode = normalizeMode(process.env.VIDEO_STREAM_MODE, 'individual');
  switch (videoMode) {
    case 'individual':
    case 'single_individual':
      return MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_INDIVIDUAL_STREAM;
    case 'active':
    case 'speaker':
    case 'active_speaker':
    case 'single_active':
      return MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM;
    default:
      throw new Error(`Unsupported VIDEO_STREAM_MODE: ${process.env.VIDEO_STREAM_MODE}`);
  }
}

function getVideoResolutionFromEnv() {
  const resolution = normalizeMode(process.env.VIDEO_RESOLUTION, 'hd');
  switch (resolution) {
    case 'sd':
      return MEDIA_PARAMS.MEDIA_RESOLUTION_SD;
    case 'hd':
      return MEDIA_PARAMS.MEDIA_RESOLUTION_HD;
    case 'fhd':
      return MEDIA_PARAMS.MEDIA_RESOLUTION_FHD;
    case 'qhd':
      return MEDIA_PARAMS.MEDIA_RESOLUTION_QHD;
    default:
      throw new Error(`Unsupported VIDEO_RESOLUTION: ${process.env.VIDEO_RESOLUTION}`);
  }
}

function normalizeParticipant(participant = {}) {
  return {
    userId: participant.userId ?? participant.user_id ?? null,
    userName: participant.userName ?? participant.user_name ?? null
  };
}

function participantKey(userId) {
  return String(userId);
}

function normalizeRtmsUserId(userId) {
  if (typeof userId === 'number' && Number.isInteger(userId)) {
    return userId;
  }

  const raw = String(userId ?? '').trim();
  if (raw === '') return raw;

  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }

  return raw;
}

const appConfig = {
  port: envNumber('PORT', 5050),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  frontendWssAuthToken: process.env.FRONTEND_WSS_AUTH_TOKEN || '',
  allowPreRtmsRegistration: envBoolean('ALLOW_PRE_RTMS_REGISTRATION', false)
};

validateRequiredEnv(['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_SECRET_TOKEN']);

const wsSigningSecret = process.env.ZOOM_CLIENT_SECRET || process.env.ZOOM_SECRET_TOKEN || crypto.randomBytes(32).toString('hex');

const mediaTypes = getMediaTypesFromEnv();
const videoMode = normalizeMode(process.env.VIDEO_STREAM_MODE, 'individual');
const audioMode = normalizeMode(process.env.AUDIO_STREAM_MODE, 'multi');
const hlsEnabled = process.env.ENABLE_HLS_PREVIEW !== 'false';
const deepfakeFrameFps = getDeepfakeFrameFps();
const deepfakeClipSeconds = getDeepfakeClipSeconds();
const deepfakeMaxClips = Math.max(envNumber('DEEPFAKE_MAX_CLIPS', 12), 2);
const deepfakeFetchTimeoutMs = Math.max(envNumber('DEEPFAKE_FETCH_TIMEOUT_MS', 15000), 1000);
const deepfakeModelName = process.env.DEEPFAKE_MODEL_NAME || 'Naman712/Deep-fake-detection';
const deepfakeVendorName = process.env.DEEPFAKE_VENDOR_NAME || deepfakeModelName;
const deepfakeMode = normalizeDeepfakeMode(process.env.DEEPFAKE_MODE);
const deepfakeServiceUrl = process.env.DEEPFAKE_SERVICE_URL || 'http://127.0.0.1:8012/video/classify';
const deepfakeUploadUrl = process.env.DEEPFAKE_UPLOAD_URL || process.env.DEEPFAKE_VIDEO_UPLOAD_URL || '';
const deepfakeApiKey = process.env.DEEPFAKE_API_KEY || '';
const audioDeepfakeClipSeconds = getAudioDeepfakeClipSeconds();
const audioDeepfakeMode = normalizeAudioDeepfakeMode(process.env.AUDIO_DEEPFAKE_MODE);
const audioDeepfakeModelName = process.env.AUDIO_DEEPFAKE_MODEL_NAME || 'MelodyMachine/Deepfake-audio-detection-V2';
const audioDeepfakeVendorName = process.env.AUDIO_DEEPFAKE_VENDOR_NAME || audioDeepfakeModelName;
const audioDeepfakeServiceUrl = process.env.AUDIO_DEEPFAKE_SERVICE_URL || 'https://your-deepfake-service.example.com/audio/classify';
const audioDeepfakeUploadUrl = process.env.AUDIO_DEEPFAKE_UPLOAD_URL || '';
const audioDeepfakeApiKey = (process.env.AUDIO_DEEPFAKE_API_KEY || '').trim() || deepfakeApiKey;
const audioDeepfakeHealthcheckEnabled = envBoolean('AUDIO_DEEPFAKE_HEALTHCHECK_ENABLED', false);
const audioDeepfakeMinRmsDbfs = envNumber('AUDIO_DEEPFAKE_MIN_RMS_DBFS', -65);

validateRuntimeConfig({
  mediaTypes,
  videoMode,
  audioMode,
  hlsEnabled
});
validateServiceApiKey({
  mode: deepfakeMode,
  apiKey: deepfakeApiKey,
  envName: 'DEEPFAKE_API_KEY',
  serviceName: 'Video deepfake'
});
validateServiceApiKey({
  mode: audioDeepfakeMode,
  apiKey: audioDeepfakeApiKey,
  envName: 'AUDIO_DEEPFAKE_API_KEY or DEEPFAKE_API_KEY',
  serviceName: 'Audio deepfake'
});

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: process.env.LOG_LEVEL !== 'off'
  },
  mediaTypes,
  credentials: {
    meeting: {
      clientId: process.env.ZOOM_CLIENT_ID,
      clientSecret: process.env.ZOOM_CLIENT_SECRET,
      secretToken: process.env.ZOOM_SECRET_TOKEN
    }
  },
  mediaParams: {
    audio: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_AUDIO,
      sampleRate: MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
      channel: MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
      dataOpt: getAudioDataOptFromEnv(),
      sendRate: envNumber('AUDIO_SEND_RATE', 100)
    },
    video: {
      contentType: MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RAW_VIDEO,
      codec: MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
      dataOpt: getVideoDataOptFromEnv(),
      resolution: getVideoResolutionFromEnv(),
      fps: envNumber('VIDEO_FPS', 25)
    }
  }
};

const runtimeConfigSummary = {
  videoFps: rtmsConfig.mediaParams.video.fps,
  inferenceFps: deepfakeFrameFps,
  clipSeconds: deepfakeClipSeconds,
  audioMode,
  audioClipSeconds: audioDeepfakeClipSeconds,
  modelName: deepfakeModelName,
  vendorName: deepfakeVendorName,
  audioModelName: audioDeepfakeModelName,
  audioVendorName: audioDeepfakeVendorName
};

const tmpHlsRoot = path.join(__dirname, 'tmp_hls');
const tmpClipsRoot = path.join(__dirname, 'tmp_clips');
fs.mkdirSync(tmpHlsRoot, { recursive: true });
fs.mkdirSync(tmpClipsRoot, { recursive: true });

const deepfakeClient = new DeepfakeClient({
  mode: deepfakeMode,
  modelName: deepfakeModelName,
  serviceUrl: deepfakeServiceUrl,
  uploadUrl: deepfakeUploadUrl,
  apiKey: deepfakeApiKey,
  pythonBin: process.env.PYTHON_BIN || 'python3',
  threshold: envNumber('DEEPFAKE_REAL_THRESHOLD', 0.75),
  vendorName: deepfakeVendorName,
  timeoutMs: deepfakeFetchTimeoutMs
});

const audioDeepfakeClient = new AudioDeepfakeClient({
  mode: audioDeepfakeMode,
  modelName: audioDeepfakeModelName,
  serviceUrl: audioDeepfakeServiceUrl,
  uploadUrl: audioDeepfakeUploadUrl,
  apiKey: audioDeepfakeApiKey,
  threshold: envNumber('AUDIO_DEEPFAKE_REAL_THRESHOLD', 0.75),
  vendorName: audioDeepfakeVendorName,
  timeoutMs: deepfakeFetchTimeoutMs,
  healthcheckEnabled: audioDeepfakeHealthcheckEnabled
});

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

function logToRoom(meetingId, message, data = undefined) {
  if (data === undefined) {
    console.log(message);
    if (meetingId) io.to(String(meetingId)).emit('backend_log', { message, timestamp: Date.now() });
    return;
  }
  console.log(message, data);
  if (meetingId) io.to(String(meetingId)).emit('backend_log', { message, data, timestamp: Date.now() });
}

function broadcastState(session) {
  if (!session) return;
  io.to(session.meetingId).emit('state', session.snapshot(runtimeConfigSummary));
}

const sessionManager = new SessionManager({
  hlsRootDir: tmpHlsRoot,
  clipsRootDir: tmpClipsRoot,
  videoVendorName: deepfakeVendorName,
  audioVendorName: audioDeepfakeVendorName,
  createHlsPipeline: ({ hlsDir, clipDir, playlistUrl, session }) => {
    const pipeline = new HlsPipeline({
      enabled: hlsEnabled,
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
      threadQueueSize: envNumber('FFMPEG_THREAD_QUEUE_SIZE', 1024),
      hlsDir,
      clipDir,
      playlistUrl,
      videoFps: rtmsConfig.mediaParams.video.fps,
      frameFps: deepfakeFrameFps,
      clipSegmentSeconds: deepfakeClipSeconds,
      clipStableAgeMs: envNumber('DEEPFAKE_CLIP_STABLE_AGE_MS', Math.max(deepfakeClipSeconds * 750, 1000)),
      clipMinBytes: envNumber('DEEPFAKE_MIN_CLIP_BYTES', 4096),
      maxClips: deepfakeMaxClips,
      hlsSegmentSeconds: envNumber('HLS_SEGMENT_SECONDS', 2),
      hlsListSize: envNumber('HLS_LIST_SIZE', 6),
      vendorName: deepfakeVendorName
    });

    pipeline.on('started', (payload) => {
      session.hlsReady = true;
      io.to(session.meetingId).emit('hls_ready', payload);
      broadcastState(session);
    });
    pipeline.on('reset', (payload) => {
      session.hlsReady = false;
      io.to(session.meetingId).emit('hls_reset', payload);
      broadcastState(session);
    });
    pipeline.on('log', (message) => logToRoom(session.meetingId, message));
    pipeline.on('error', (error) => {
      session.hlsReady = false;
      logToRoom(session.meetingId, '[DeepfakeDemo] HLS pipeline error', error.message);
      broadcastState(session);
    });

    return pipeline;
  },
  createAudioClipBuffer: ({ clipDir }) => new AudioClipBuffer({
    clipDir,
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    clipSeconds: audioDeepfakeClipSeconds,
    maxClips: envNumber('AUDIO_DEEPFAKE_MAX_CLIPS', 24)
  })
});

function enrichParticipant(session, participant = {}) {
  const normalized = normalizeParticipant(participant);
  if (normalized.userId == null) return normalized;
  if (normalized.userName) return normalized;
  const existing = session.participants.get(participantKey(normalized.userId));
  return {
    ...normalized,
    userName: existing?.userName ?? null
  };
}

function getSelectedParticipant(session) {
  if (!session?.selectedVideoUser) return null;
  const key = participantKey(session.selectedVideoUser.userId);
  const found = session.videoOnParticipants.get(key) || session.participants.get(key) || session.selectedVideoUser;
  return enrichParticipant(session, found);
}

function selectVideoUser(session, userId, source = 'frontend') {
  if (!session?.activeStreamId) throw new Error('No active RTMS stream is available yet.');
  if (userId == null || String(userId).trim() === '') throw new Error('userId is required.');

  const normalizedUserId = normalizeRtmsUserId(userId);
  const participantMap = session.videoOnParticipants.size > 0 ? session.videoOnParticipants : session.participants;
  const participant = enrichParticipant(
    session,
    participantMap.get(participantKey(normalizedUserId)) || { userId: normalizedUserId, userName: null }
  );
  const allowManualUserId = envBoolean('ALLOW_MANUAL_RTMS_USER_ID', false);

  if (!allowManualUserId && !session.videoOnParticipants.has(participantKey(normalizedUserId))) {
    throw new Error(`RTMS user ${normalizedUserId} is not in the current video-on participant list. Set ALLOW_MANUAL_RTMS_USER_ID=true to override for testing.`);
  }

  // Advance generation and wipe prior participant's clips/HLS before subscribing to new participant.
  session.bumpSelectionGeneration();
  session.hlsPipeline.stop({ clean: true, emitReset: true, reason: 'participant_switched' });
  session.hlsReady = false;
  session.resetDeepfakeState('unverified');
  session.resetAudioDeepfakeState('unverified');

  RTMSManager.subscribeToIndividualVideo(session.activeStreamId, normalizedUserId, true);
  session.selectedVideoUser = participant;
  session.recordParticipantVerification(normalizedUserId, 'video', 'unverified', null, participant);
  session.recordParticipantVerification(normalizedUserId, 'audio', 'unverified', null, participant);

  logToRoom(session.meetingId, '[DeepfakeDemo] Subscribed to individual video user', {
    streamId: session.activeStreamId,
    userId: normalizedUserId,
    source,
    selectionGeneration: session.selectionGeneration,
    participant
  });
  broadcastState(session);
}

function startDeepfakeDetection(session, source = 'frontend') {
  if (!session?.activeStreamId) throw new Error('No active RTMS stream is available yet.');
  const selected = getSelectedParticipant(session);
  if (!selected) {
    throw new Error('Load an individual video first before starting deepfake detection.');
  }
  if (!session.hlsPipeline.started) {
    throw new Error('The HLS/video pipeline is not ready yet. Wait for video packets after loading the individual stream.');
  }

  session.deepfakeDetectionEnabled = true;
  session.deepfakeStatus = 'running';
  session.lastDeepfakeResult = null;
  session.lastInferenceClipKey = null;
  session.recordParticipantVerification(selected.userId, 'video', 'running', null, selected);
  logToRoom(session.meetingId, '[DeepfakeDemo] Video deepfake verification started', {
    streamId: session.activeStreamId,
    source,
    selectedParticipant: selected
  });
  broadcastState(session);
}

function stopDeepfakeDetection(session, source = 'frontend') {
  if (!session) throw new Error('No active meeting session.');
  session.deepfakeDetectionEnabled = false;
  session.deepfakeStatus = session.lastDeepfakeResult ? session.deepfakeStatus : 'unverified';
  session.lastInferenceClipKey = null;
  const selected = getSelectedParticipant(session);
  if (selected && !session.lastDeepfakeResult) {
    session.recordParticipantVerification(selected.userId, 'video', 'unverified', null, selected);
  }
  logToRoom(session.meetingId, '[DeepfakeDemo] Video deepfake verification stopped', {
    streamId: session.activeStreamId,
    source
  });
  broadcastState(session);
}

function startAudioDeepfakeDetection(session, source = 'frontend') {
  if (!session?.activeStreamId) throw new Error('No active RTMS stream is available yet.');
  const selected = getSelectedParticipant(session);
  if (!selected) {
    throw new Error('Load an individual video participant first so audio packets can be filtered to the same RTMS user.');
  }
  if (audioDeepfakeClient.mode !== 'service') {
    throw new Error('Audio verification is disabled. Set AUDIO_DEEPFAKE_MODE=service and configure AUDIO_DEEPFAKE_SERVICE_URL.');
  }

  session.audioClipBuffer.reset();
  session.audioDeepfakeDetectionEnabled = true;
  session.audioDeepfakeStatus = 'running';
  session.lastAudioDeepfakeResult = null;
  session.lastAudioInferenceClipKey = null;
  session.recordParticipantVerification(selected.userId, 'audio', 'running', null, selected);
  logToRoom(session.meetingId, '[DeepfakeDemo] Audio deepfake verification started', {
    streamId: session.activeStreamId,
    source,
    selectedParticipant: selected,
    audioServiceUrl: audioDeepfakeClient.serviceUrl,
    clipSeconds: audioDeepfakeClipSeconds
  });
  broadcastState(session);
}

function stopAudioDeepfakeDetection(session, source = 'frontend') {
  if (!session) throw new Error('No active meeting session.');
  session.audioDeepfakeDetectionEnabled = false;
  session.audioDeepfakeStatus = session.lastAudioDeepfakeResult ? session.audioDeepfakeStatus : 'unverified';
  session.lastAudioInferenceClipKey = null;
  session.audioClipBuffer.reset();
  const selected = getSelectedParticipant(session);
  if (selected && !session.lastAudioDeepfakeResult) {
    session.recordParticipantVerification(selected.userId, 'audio', 'unverified', null, selected);
  }
  logToRoom(session.meetingId, '[DeepfakeDemo] Audio deepfake verification stopped', {
    streamId: session.activeStreamId,
    source
  });
  broadcastState(session);
}

async function checkDeepfakeBackendHealth(reason = 'startup', meetingId = null) {
  if (deepfakeClient.mode !== 'service') return null;
  try {
    const health = await deepfakeClient.checkHealth();
    logToRoom(meetingId, '[DeepfakeDemo] Deepfake service is reachable', {
      reason,
      url: deepfakeClient.serviceUrl,
      device: health?.device ?? null,
      model: health?.model ?? null
    });
    return health;
  } catch (error) {
    logToRoom(meetingId, '[DeepfakeDemo] Deepfake service health check failed', {
      reason,
      url: deepfakeClient.serviceUrl,
      message: error.message
    });
    throw error;
  }
}

async function checkAudioDeepfakeBackendHealth(reason = 'start_audio_deepfake_detection', meetingId = null) {
  if (audioDeepfakeClient.mode !== 'service') return null;
  if (!audioDeepfakeHealthcheckEnabled) {
    return { ok: true, skipped: true, reason: 'AUDIO_DEEPFAKE_HEALTHCHECK_ENABLED=false' };
  }
  try {
    const health = await audioDeepfakeClient.checkHealth();
    logToRoom(meetingId, '[DeepfakeDemo] Audio deepfake service is reachable', {
      reason,
      url: audioDeepfakeClient.serviceUrl,
      device: health?.device ?? null,
      model: health?.model ?? null
    });
    return health;
  } catch (error) {
    logToRoom(meetingId, '[DeepfakeDemo] Audio deepfake service health check failed', {
      reason,
      url: audioDeepfakeClient.serviceUrl,
      message: error.message
    });
    throw error;
  }
}

console.log('[DeepfakeDemo] App Configuration:', {
  port: appConfig.port,
  webhookPath: appConfig.webhookPath,
  publicBaseUrl: appConfig.publicBaseUrl || null
});
console.log('[DeepfakeDemo] RTMS Configuration:', RTMSManager.redactSecrets(rtmsConfig));
console.log('[DeepfakeDemo] Media modes:', {
  audioMode,
  videoMode,
  hlsEnabled,
  deepfakeMode,
  deepfakeServiceUrl: deepfakeClient.mode === 'service' ? deepfakeClient.serviceUrl : null,
  deepfakeFrameFps,
  deepfakeClipSeconds,
  deepfakeFetchTimeoutMs,
  audioDeepfakeMode,
  audioDeepfakeServiceUrl: audioDeepfakeClient.mode === 'service' ? audioDeepfakeClient.serviceUrl : null,
  audioDeepfakeHealthcheckEnabled,
  audioDeepfakeClipSeconds,
  audioDeepfakeMinRmsDbfs
});

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://appssdk.zoom.us",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss: https://appssdk.zoom.us",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'self' https://appssdk.zoom.us"
].join('; ');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use((req, res, next) => {
  if (isProtectedRequestPath(req.path)) {
    res.status(404).end();
    return;
  }
  next();
});
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); }
}));
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  }
}));
app.get('/vendor/hls.min.js', (req, res) => {
  const hlsPath = path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
  if (!fs.existsSync(hlsPath)) {
    res.status(404).send('hls.js is not installed. Run npm install in this sample folder.');
    return;
  }
  res.type('application/javascript');
  res.sendFile(hlsPath);
});

// Serve HLS only from isolated per-meeting paths (no global CORS: *, no public /clips route).
app.get('/hls/:meetingKey/:filename', (req, res) => {
  const { meetingKey, filename } = req.params;
  if (!/^[a-f0-9]{16}$/.test(meetingKey) || !/^[a-zA-Z0-9_.-]+$/.test(filename)) {
    res.status(400).end();
    return;
  }
  const session = sessionManager.getSessionByMeetingKey(meetingKey);
  if (!session) {
    res.status(404).end();
    return;
  }
  const targetPath = path.resolve(session.hlsDir, filename);
  if (!targetPath.startsWith(path.resolve(session.hlsDir) + path.sep) || !fs.existsSync(targetPath)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(targetPath);
});

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const contextHeader = req.headers['x-zoom-app-context'];
  const zoomContext = decryptZoomAppContext(contextHeader, process.env.ZOOM_CLIENT_SECRET);
  const wsAuthToken = zoomContext ? mintWsAuthToken(zoomContext, wsSigningSecret) : '';

  res.render('index', {
    config: {
      publicBaseUrl: appConfig.publicBaseUrl,
      vendorName: deepfakeVendorName,
      videoFps: rtmsConfig.mediaParams.video.fps,
      frameFps: deepfakeFrameFps,
      clipSeconds: deepfakeClipSeconds,
      audioClipSeconds: audioDeepfakeClipSeconds,
      audioModelName: audioDeepfakeModelName,
      audioVendorName: audioDeepfakeVendorName,
      wsAuthToken,
      assetVersion: Date.now()
    }
  });
});

app.get('/health', (req, res) => {
  const activeSessions = sessionManager.allSessions().map((s) => ({
    meetingKey: s.meetingKey,
    rtmsStatus: s.rtmsStatus,
    hlsReady: s.hlsReady
  }));
  res.json({
    ok: true,
    activeSessionCount: activeSessions.length,
    sessions: activeSessions
  });
});

const webhookManager = new WebhookManager({
  config: {
    webhookPath: appConfig.webhookPath,
    zoomSecretToken: rtmsConfig.credentials.meeting.secretToken
  },
  app
});

webhookManager.on('event', (event, payload) => {
  if (!event?.startsWith('meeting.rtms_')) return;

  if (event === 'meeting.rtms_started') {
    const meetingId = payload?.meeting_uuid;
    const streamId = payload?.rtms_stream_id;
    if (meetingId && streamId) {
      const session = sessionManager.bindStream(streamId, meetingId);
      session.bumpSelectionGeneration();
      session.hlsPipeline.stop({ clean: true, emitReset: true, reason: 'rtms_started' });
      session.activeStreamId = streamId;
      session.rtmsStatus = 'starting';
      session.hlsReady = false;
      session.selectedVideoUser = null;
      session.participants.clear();
      session.videoOnParticipants.clear();
      session.activeSpeaker = null;
      session.participantVerification.clear();
      session.resetDeepfakeState('unverified');
      session.resetAudioDeepfakeState('unverified');
      logToRoom(session.meetingId, '[DeepfakeDemo] Webhook event received', { event, streamId });
      broadcastState(session);
    }
  }

  if (event === 'meeting.rtms_stopped') {
    const streamId = payload?.rtms_stream_id;
    const session = sessionManager.getSessionByStreamId(streamId)
      || (payload?.meeting_uuid ? sessionManager.getSessionByMeetingId(payload.meeting_uuid) : null);

    if (session) {
      if (streamId && session.activeStreamId && streamId !== session.activeStreamId) {
        logToRoom(session.meetingId, '[DeepfakeDemo] Ignoring stale stop webhook for inactive stream', {
          activeStreamId: session.activeStreamId,
          stoppedStreamId: streamId,
          stopReason: payload?.stop_reason ?? null
        });
        RTMSManager.handleEvent(event, payload);
        return;
      }

      session.bumpSelectionGeneration();
      session.rtmsStatus = 'stopped';
      session.hlsPipeline.stop({ clean: true, emitReset: true, reason: 'rtms_stopped' });
      session.hlsReady = false;
      session.selectedVideoUser = null;
      session.activeSpeaker = null;
      session.participantVerification.clear();
      session.resetDeepfakeState('stopped');
      session.resetAudioDeepfakeState('stopped');
      sessionManager.unbindStream(streamId);
      session.activeStreamId = null;
      logToRoom(session.meetingId, '[DeepfakeDemo] RTMS stopped', { streamId, stopReason: payload?.stop_reason ?? null });
      broadcastState(session);
    }
  }

  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

await RTMSManager.init(rtmsConfig);

RTMSManager.instance.on('error', (error) => {
  console.error('[DeepfakeDemo] RTMS error', error.toString ? error.toString() : error);
});

RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, streamId, meetingId }) => {
  const session = sessionManager.getSessionByStreamId(streamId)
    || (meetingId ? sessionManager.getSessionByMeetingId(meetingId) : null);
  if (!session || session.activeStreamId !== streamId) return;

  const selectedParticipant = getSelectedParticipant(session);
  const selectedAudio = Boolean(
    selectedParticipant?.userId != null
    && userId != null
    && String(selectedParticipant.userId) === String(userId)
  );

  if (selectedAudio) {
    session.hlsPipeline.writeAudio(buffer);
    session.audioClipBuffer.writeAudio(buffer, {
      streamId,
      userId,
      userName: userName ?? selectedParticipant.userName ?? null,
      timestamp: timestamp ?? Date.now()
    });
  }
});

RTMSManager.on('video', ({ buffer, streamId, meetingId }) => {
  const session = sessionManager.getSessionByStreamId(streamId)
    || (meetingId ? sessionManager.getSessionByMeetingId(meetingId) : null);
  if (!session || session.activeStreamId !== streamId) return;
  if (!session.selectedVideoUser) return;
  session.hlsPipeline.writeVideo(buffer);
});

RTMSManager.on('event', (eventData) => {
  const streamId = eventData.streamId;
  const session = sessionManager.getSessionByStreamId(streamId)
    || (eventData.meetingId ? sessionManager.getSessionByMeetingId(eventData.meetingId) : null);
  if (!session) return;

  const participants = eventData.data?.participants || [];
  const { EVENT_CODES } = RTMSManager;

  if (eventData.eventCode === EVENT_CODES.ACTIVE_SPEAKER_CHANGE) {
    const activeSpeaker = normalizeParticipant(eventData.data);
    session.activeSpeaker = activeSpeaker;
    io.to(session.meetingId).emit('active_speaker', { streamId, activeSpeaker });
  }

  if (eventData.eventCode === EVENT_CODES.PARTICIPANT_JOIN) {
    for (const raw of participants) {
      const p = normalizeParticipant(raw);
      if (p.userId != null) session.participants.set(participantKey(p.userId), p);
    }
  }

  if (eventData.eventCode === EVENT_CODES.PARTICIPANT_LEAVE) {
    for (const raw of participants) {
      const p = normalizeParticipant(raw);
      if (p.userId != null) session.participants.delete(participantKey(p.userId));
    }
  }

  broadcastState(session);
});

function handleVideoOnParticipantsChanged({ availableParticipants, streamId, meetingId }) {
  const session = sessionManager.getSessionByStreamId(streamId)
    || (meetingId ? sessionManager.getSessionByMeetingId(meetingId) : null);
  if (!session) return;

  session.videoOnParticipants.clear();
  for (const raw of availableParticipants || []) {
    const p = enrichParticipant(session, raw);
    if (p.userId != null) session.videoOnParticipants.set(participantKey(p.userId), p);
  }
  io.to(session.meetingId).emit('video_on_participants_changed', { streamId, availableParticipants });
  broadcastState(session);
}

RTMSManager.on('participant_video_on', handleVideoOnParticipantsChanged);
RTMSManager.on('participant_video_off', handleVideoOnParticipantsChanged);
RTMSManager.on('video_on_participants_changed', handleVideoOnParticipantsChanged);

RTMSManager.on('video_subscription_response', (message) => {
  const session = sessionManager.getSessionByStreamId(message.streamId)
    || (message.meetingId ? sessionManager.getSessionByMeetingId(message.meetingId) : null);
  if (!session) return;
  logToRoom(session.meetingId, '[DeepfakeDemo] Video subscription response', {
    streamId: message.streamId,
    userId: message.userId,
    success: message.success,
    statusCode: message.statusCode,
    reason: message.reason,
    currentVideoSubscriptionUserId: message.currentVideoSubscriptionUserId
  });
  io.to(session.meetingId).emit('video_subscription_response', message);
  broadcastState(session);
});

RTMSManager.on('stream_state_changed', (message) => {
  const session = sessionManager.getSessionByStreamId(message.streamId)
    || (message.meetingId ? sessionManager.getSessionByMeetingId(message.meetingId) : null);
  if (!session) return;
  if (message.state === 1) session.rtmsStatus = 'running';
  if (message.state === 3 || message.state === 4) session.rtmsStatus = 'stopped';
  io.to(session.meetingId).emit('stream_state_changed', message);
  broadcastState(session);
});

async function runVideoInferenceForSession(session) {
  if (!session.deepfakeDetectionEnabled || session.inferenceInFlight || !session.hlsPipeline.hasLatestClip()) {
    return;
  }

  const latestClip = session.hlsPipeline.getLatestClip();
  if (!latestClip) return;

  const clipKey = `${latestClip.path}:${latestClip.mtimeMs}`;
  if (clipKey === session.lastInferenceClipKey) return;
  session.lastInferenceClipKey = clipKey;

  const selectedParticipant = getSelectedParticipant(session);
  if (!selectedParticipant || !session.activeStreamId) return;

  const job = {
    streamId: session.activeStreamId,
    userId: selectedParticipant.userId,
    selectionGeneration: session.selectionGeneration
  };

  session.inferenceInFlight = true;
  const inferenceStartedAt = Date.now();

  try {
    const result = await deepfakeClient.classifyVideo(latestClip.path, {
      streamId: job.streamId,
      meetingId: session.meetingId,
      selectedParticipant,
      clipPath: latestClip.path,
      clipMtimeMs: latestClip.mtimeMs
    });

    if (!session.isJobCurrent(job) || !session.deepfakeDetectionEnabled) {
      logToRoom(session.meetingId, '[DeepfakeDemo] Discarded stale video inference result after participant switch/stop', job);
      return;
    }

    const inferenceCompletedAt = Date.now();
    result.clip = {
      name: path.basename(latestClip.path),
      size: latestClip.size,
      mtimeMs: latestClip.mtimeMs
    };
    result.processingMs = inferenceCompletedAt - inferenceStartedAt;
    result.completedAt = inferenceCompletedAt;
    result.clipAgeMs = Math.max(0, inferenceStartedAt - latestClip.mtimeMs);

    session.lastDeepfakeResult = result;
    session.deepfakeStatus = result.status || (result.verified === true ? 'verified' : 'unverified');
    session.recordParticipantVerification(selectedParticipant.userId, 'video', session.deepfakeStatus, result, selectedParticipant);
    io.to(session.meetingId).emit('deepfake_result', result);
    broadcastState(session);
  } catch (error) {
    if (!session.isJobCurrent(job)) return;
    session.deepfakeStatus = 'error';
    session.recordParticipantVerification(selectedParticipant.userId, 'video', 'error', null, selectedParticipant);
    io.to(session.meetingId).emit('deepfake_error', {
      message: error.message,
      timestamp: Date.now()
    });
    logToRoom(session.meetingId, '[DeepfakeDemo] Deepfake inference failed', error.message);
    broadcastState(session);
  } finally {
    session.inferenceInFlight = false;
  }
}

async function runAudioInferenceForSession(session) {
  if (!session.audioDeepfakeDetectionEnabled || session.audioInferenceInFlight || !session.audioClipBuffer.hasLatestClip()) {
    return;
  }

  const latestClip = session.audioClipBuffer.getLatestClip();
  if (!latestClip) return;

  const clipKey = `${latestClip.path}:${latestClip.mtimeMs}`;
  if (clipKey === session.lastAudioInferenceClipKey) return;
  session.lastAudioInferenceClipKey = clipKey;

  const selectedParticipant = getSelectedParticipant(session);
  if (
    !selectedParticipant
    || !session.activeStreamId
    || String(latestClip.userId ?? '') !== String(selectedParticipant.userId ?? '')
  ) {
    return;
  }

  const job = {
    streamId: session.activeStreamId,
    userId: selectedParticipant.userId,
    selectionGeneration: session.selectionGeneration
  };

  if (latestClip.audioStats?.rmsDbfs != null && latestClip.audioStats.rmsDbfs < audioDeepfakeMinRmsDbfs) {
    const skippedResult = {
      mode: audioDeepfakeClient.mode,
      vendorName: audioDeepfakeVendorName,
      modelName: audioDeepfakeModelName,
      skipped: true,
      status: 'unverified',
      verified: false,
      deepfake: false,
      reason: `Audio signal too low for reliable verification (${latestClip.audioStats.rmsDbfs.toFixed(2)} dBFS)`,
      realScore: null,
      fakeScore: null,
      scores: {},
      clip: {
        name: latestClip.name || path.basename(latestClip.path),
        size: latestClip.size,
        mtimeMs: latestClip.mtimeMs,
        durationSeconds: latestClip.durationSeconds,
        sampleCount: latestClip.sampleCount,
        sampleRate: latestClip.sampleRate,
        channels: latestClip.channels,
        format: latestClip.format,
        windowStartMs: latestClip.windowStartMs,
        windowEndMs: latestClip.windowEndMs
      },
      audioStats: latestClip.audioStats,
      timestamp: Date.now()
    };

    session.lastAudioDeepfakeResult = skippedResult;
    session.audioDeepfakeStatus = 'unverified';
    session.recordParticipantVerification(selectedParticipant.userId, 'audio', 'unverified', skippedResult, selectedParticipant);
    io.to(session.meetingId).emit('audio_deepfake_result', skippedResult);
    logToRoom(session.meetingId, '[DeepfakeDemo] Audio deepfake verification skipped low-signal clip', {
      clip: skippedResult.clip.name,
      selectedParticipant,
      minRmsDbfs: audioDeepfakeMinRmsDbfs,
      rmsDbfs: latestClip.audioStats.rmsDbfs
    });
    broadcastState(session);
    return;
  }

  session.audioInferenceInFlight = true;
  const inferenceStartedAt = Date.now();

  try {
    const result = await audioDeepfakeClient.classifyAudio(latestClip.path, {
      streamId: job.streamId,
      meetingId: session.meetingId,
      selectedParticipant,
      zoomUserId: selectedParticipant.userId,
      zoomUserName: selectedParticipant.userName || latestClip.userName || '',
      clipPath: latestClip.path,
      clipMtimeMs: latestClip.mtimeMs,
      sampleRate: latestClip.sampleRate,
      channels: latestClip.channels,
      durationSeconds: latestClip.durationSeconds,
      sampleCount: latestClip.sampleCount,
      windowStartMs: latestClip.windowStartMs,
      windowEndMs: latestClip.windowEndMs,
      audioStats: latestClip.audioStats
    });

    if (!session.isJobCurrent(job) || !session.audioDeepfakeDetectionEnabled) {
      logToRoom(session.meetingId, '[DeepfakeDemo] Discarded stale audio inference result after participant switch/stop', job);
      return;
    }

    const inferenceCompletedAt = Date.now();
    result.clip = {
      name: latestClip.name || path.basename(latestClip.path),
      size: latestClip.size,
      mtimeMs: latestClip.mtimeMs,
      durationSeconds: latestClip.durationSeconds,
      sampleCount: latestClip.sampleCount,
      sampleRate: latestClip.sampleRate,
      channels: latestClip.channels,
      format: latestClip.format,
      audioStats: latestClip.audioStats,
      windowStartMs: latestClip.windowStartMs,
      windowEndMs: latestClip.windowEndMs
    };
    result.audioStats = latestClip.audioStats;
    result.processingMs = inferenceCompletedAt - inferenceStartedAt;
    result.completedAt = inferenceCompletedAt;
    result.clipAgeMs = Math.max(0, inferenceStartedAt - latestClip.mtimeMs);

    session.lastAudioDeepfakeResult = result;
    session.audioDeepfakeStatus = result.status || (result.verified === true ? 'verified' : 'unverified');
    session.recordParticipantVerification(selectedParticipant.userId, 'audio', session.audioDeepfakeStatus, result, selectedParticipant);
    io.to(session.meetingId).emit('audio_deepfake_result', result);
    logToRoom(session.meetingId, '[DeepfakeDemo] Audio deepfake verification result', {
      clip: result.clip.name,
      status: session.audioDeepfakeStatus,
      realScore: result.realScore,
      fakeScore: result.fakeScore,
      processingMs: result.processingMs
    });
    broadcastState(session);
  } catch (error) {
    if (!session.isJobCurrent(job)) return;
    session.audioDeepfakeDetectionEnabled = false;
    session.audioDeepfakeStatus = 'error';
    session.lastAudioDeepfakeResult = null;
    session.recordParticipantVerification(selectedParticipant.userId, 'audio', 'error', null, selectedParticipant);
    io.to(session.meetingId).emit('audio_deepfake_error', {
      message: error.message,
      timestamp: Date.now()
    });
    logToRoom(session.meetingId, '[DeepfakeDemo] Audio deepfake inference failed', error.message);
    broadcastState(session);
  } finally {
    session.audioInferenceInFlight = false;
  }
}

const inferenceTimer = setInterval(() => {
  for (const session of sessionManager.allSessions()) {
    void runVideoInferenceForSession(session);
    void runAudioInferenceForSession(session);
  }
}, 1000);
inferenceTimer.unref?.();

const authorizeSocket = createSocketAuthorizer({
  getActiveConnections: () => RTMSManager.getActiveConnections(),
  staticAuthToken: appConfig.frontendWssAuthToken,
  signingSecret: wsSigningSecret,
  allowPreRtmsRegistration: appConfig.allowPreRtmsRegistration
});

function requireSession(socket, callback) {
  const meetingId = socket.data?.meetingId;
  if (!meetingId) {
    callback?.({ ok: false, error: 'Socket is not registered for a meeting.' });
    return null;
  }
  return sessionManager.getOrCreateSession(meetingId);
}

io.on('connection', (socket) => {
  console.log('[DeepfakeDemo] Zoom App socket connected', { socketId: socket.id });

  socket.on('register', ({ meetingUUID, userID, token } = {}, callback) => {
    const auth = authorizeSocket({ meetingUUID, userID, token });
    if (!auth.authorized) {
      callback?.({ ok: false, error: 'Registration unauthorized. Open inside a Zoom meeting or start RTMS first.' });
      return;
    }

    if (socket.data?.meetingId && socket.data.meetingId !== auth.meetingUUID) {
      socket.leave(socket.data.meetingId);
    }

    socket.data.meetingId = auth.meetingUUID;
    socket.data.userId = auth.userID;
    socket.join(auth.meetingUUID);

    const session = sessionManager.getOrCreateSession(auth.meetingUUID);
    logToRoom(session.meetingId, '[DeepfakeDemo] Zoom App client registered', {
      socketId: socket.id,
      reason: auth.reason
    });
    socket.emit('state', session.snapshot(runtimeConfigSummary));
    callback?.({ ok: true, meetingId: session.meetingId, reason: auth.reason });
  });

  socket.on('zoom_participants', ({ participants = [] } = {}) => {
    const session = requireSession(socket);
    if (!session) return;
    session.zoomParticipants.clear();
    for (const participant of participants) {
      const uuid = participant.participantUUID || participant.participantUuid || participant.id;
      if (!uuid) continue;
      session.zoomParticipants.set(String(uuid), participant);
    }
    broadcastState(session);
  });

  socket.on('select_video_user', ({ userId } = {}, callback) => {
    const session = requireSession(socket, callback);
    if (!session) return;
    try {
      selectVideoUser(session, userId, 'frontend');
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on('start_deepfake_detection', (_payload = {}, callback) => {
    const session = requireSession(socket, callback);
    if (!session) return;
    Promise.resolve()
      .then(async () => {
        await checkDeepfakeBackendHealth('start_deepfake_detection', session.meetingId);
        startDeepfakeDetection(session, 'frontend');
        callback?.({ ok: true });
      })
      .catch((error) => {
        callback?.({ ok: false, error: error.message });
      });
  });

  socket.on('stop_deepfake_detection', (_payload = {}, callback) => {
    const session = requireSession(socket, callback);
    if (!session) return;
    try {
      stopDeepfakeDetection(session, 'frontend');
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on('start_audio_deepfake_detection', (_payload = {}, callback) => {
    const session = requireSession(socket, callback);
    if (!session) return;
    Promise.resolve()
      .then(async () => {
        await checkAudioDeepfakeBackendHealth('start_audio_deepfake_detection', session.meetingId);
        startAudioDeepfakeDetection(session, 'frontend');
        callback?.({ ok: true });
      })
      .catch((error) => {
        callback?.({ ok: false, error: error.message });
      });
  });

  socket.on('stop_audio_deepfake_detection', (_payload = {}, callback) => {
    const session = requireSession(socket, callback);
    if (!session) return;
    try {
      stopAudioDeepfakeDetection(session, 'frontend');
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on('set_participant_mapping', ({ rtmsUserId, participantUUID } = {}, callback) => {
    const session = requireSession(socket, callback);
    if (!session) return;
    if (!rtmsUserId || !participantUUID) {
      callback?.({ ok: false, error: 'rtmsUserId and participantUUID are required.' });
      return;
    }
    session.participantMappings.set(participantKey(rtmsUserId), String(participantUUID));
    broadcastState(session);
    callback?.({ ok: true });
  });

  socket.on('rtms_control_update', async ({ status } = {}) => {
    const session = requireSession(socket);
    if (!session || !status) return;

    if (status === 'stopped' && session.activeStreamId) {
      const streamToStop = session.activeStreamId;
      session.bumpSelectionGeneration();
      try {
        await RTMSManager.instance.onStreamStop(streamToStop);
        logToRoom(session.meetingId, '[DeepfakeDemo] Local stop requested, disabled RTMS reconnect immediately', {
          streamId: streamToStop
        });
      } catch (error) {
        logToRoom(session.meetingId, '[DeepfakeDemo] Failed to suppress reconnect on local stop', {
          message: error.message
        });
      }
      sessionManager.unbindStream(streamToStop);
      session.activeStreamId = null;
      session.hlsPipeline.stop({ clean: true, emitReset: true, reason: 'local_stop' });
      session.hlsReady = false;
      session.selectedVideoUser = null;
      session.activeSpeaker = null;
      session.participantVerification.clear();
      session.resetDeepfakeState('stopped');
      session.resetAudioDeepfakeState('stopped');
    }

    session.rtmsStatus = status;
    broadcastState(session);
  });
});

await checkDeepfakeBackendHealth('startup').catch(() => {});
await checkAudioDeepfakeBackendHealth('startup').catch(() => {});

server.listen(appConfig.port, () => {
  console.log(`[DeepfakeDemo] Server listening on port ${appConfig.port}`);
  console.log(`[DeepfakeDemo] Zoom App URL: ${appConfig.publicBaseUrl || `http://localhost:${appConfig.port}`}`);
  console.log(`[DeepfakeDemo] Webhook URL: ${(appConfig.publicBaseUrl || `http://localhost:${appConfig.port}`)}${appConfig.webhookPath}`);
});

installGracefulShutdown({
  name: 'DeepfakeDemo',
  cleanup: async () => {
    clearInterval(inferenceTimer);
    sessionManager.destroyAll();
    await RTMSManager.stop();
    await new Promise((resolve) => io.close(resolve));
    await closeHttpServer(server);
  }
});
