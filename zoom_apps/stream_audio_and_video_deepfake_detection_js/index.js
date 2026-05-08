import express from 'express';
import http from 'http';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const { MEDIA_PARAMS } = RTMSManager;

const VALID_MEDIA_TYPE_FLAGS = new Set([1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 16, 17, 18, 20, 24, 32]);

const state = {
  activeStreamId: null,
  activeMeetingId: null,
  rtmsStatus: 'stopped',
  videoOnParticipantsByStream: new Map(),
  participantsByStream: new Map(),
  activeSpeakerByStream: new Map(),
  selectedVideoUserByStream: new Map(),
  zoomParticipantsByMeeting: new Map(),
  participantMappings: new Map(),
  participantVerificationByRtmsUser: new Map(),
  lastDeepfakeResult: null,
  lastAudioDeepfakeResult: null,
  hlsReady: false,
  deepfakeDetectionEnabled: false,
  deepfakeStatus: 'unverified',
  audioDeepfakeDetectionEnabled: false,
  audioDeepfakeStatus: 'unverified'
};

let lastInferenceClipKey = null;
let inferenceInFlight = false;
let lastAudioInferenceClipKey = null;
let audioInferenceInFlight = false;
let audioClipBuffer = null;

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null) return fallback;
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
    'ecosystem.config.js'
  ]);

  return segments.some((segment) => blockedNames.has(segment));
}

function getDeepfakeFrameFps() {
  const configuredFps = Number(process.env.DEEPFAKE_FRAME_FPS);
  if (Number.isFinite(configuredFps) && configuredFps > 0) {
    return configuredFps;
  }

  const sampleIntervalMs = Math.max(envNumber('DEEPFAKE_SAMPLE_INTERVAL_MS', 3000), 1);
  return 1000 / sampleIntervalMs;
}

function getDeepfakeClipSeconds() {
  return Math.max(envNumber('DEEPFAKE_CLIP_SECONDS', 4), 1);
}

function getAudioDeepfakeClipSeconds() {
  return Math.max(envNumber('AUDIO_DEEPFAKE_CLIP_SECONDS', 4), 1);
}

function getMediaTypesFlagFromEnv() {
  const rawValue = String(process.env.MEDIA_TYPES_FLAG || '3').trim();
  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsedValue) || !VALID_MEDIA_TYPE_FLAGS.has(parsedValue)) {
    throw new Error(
      `Unsupported MEDIA_TYPES_FLAG: ${rawValue}. Use a valid RTMS media bitmask such as 1, 2, 3, 9, or 32.`
    );
  }

  return parsedValue;
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

function includesMedia(mediaTypesFlag, mediaType) {
  return mediaTypesFlag === RTMSManager.MEDIA.ALL || Boolean(mediaTypesFlag & mediaType);
}

function validateRuntimeConfig({ mediaTypesFlag, videoMode, audioMode, hlsEnabled }) {
  if (!includesMedia(mediaTypesFlag, RTMSManager.MEDIA.VIDEO)) {
    throw new Error('This sample requires video media. Set MEDIA_TYPES_FLAG to include video, for example 2 or 3.');
  }

  if (videoMode !== 'individual' && videoMode !== 'single_individual') {
    throw new Error('This sample is designed for RTMS individual video. Set VIDEO_STREAM_MODE=individual.');
  }

  if (hlsEnabled && !includesMedia(mediaTypesFlag, RTMSManager.MEDIA.AUDIO)) {
    throw new Error('HLS preview currently muxes video with RTMS audio. Set MEDIA_TYPES_FLAG=3 or disable HLS with ENABLE_HLS_PREVIEW=false.');
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
  if (raw === '') {
    return raw;
  }

  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  return raw;
}

function getOrCreateMap(container, key) {
  if (!container.has(key)) container.set(key, new Map());
  return container.get(key);
}

function log(message, data = undefined) {
  if (data === undefined) {
    console.log(message);
    io.emit('backend_log', { message, timestamp: Date.now() });
    return;
  }

  console.log(message, data);
  io.emit('backend_log', { message, data, timestamp: Date.now() });
}

function serializeMapValues(map) {
  return Array.from(map?.values?.() || []);
}

function snapshot() {
  const streamId = state.activeStreamId;
  const meetingId = state.activeMeetingId;
  return {
    rtmsStatus: state.rtmsStatus,
    streamId,
    meetingId,
    hlsReady: state.hlsReady,
    hlsUrl: state.hlsReady ? '/hls/stream.m3u8' : null,
    participants: serializeMapValues(state.participantsByStream.get(streamId)),
    videoOnParticipants: serializeMapValues(state.videoOnParticipantsByStream.get(streamId)),
    activeSpeaker: state.activeSpeakerByStream.get(streamId) || null,
    selectedVideoUser: state.selectedVideoUserByStream.get(streamId) || null,
    zoomParticipants: serializeMapValues(state.zoomParticipantsByMeeting.get(meetingId)),
    participantMappings: Object.fromEntries(state.participantMappings.entries()),
    participantVerification: Object.fromEntries(state.participantVerificationByRtmsUser.entries()),
    lastDeepfakeResult: state.lastDeepfakeResult,
    lastAudioDeepfakeResult: state.lastAudioDeepfakeResult,
    deepfakeDetectionEnabled: state.deepfakeDetectionEnabled,
    deepfakeStatus: state.deepfakeStatus,
    audioDeepfakeDetectionEnabled: state.audioDeepfakeDetectionEnabled,
    audioDeepfakeStatus: state.audioDeepfakeStatus,
    runtimeConfig: {
      videoFps: rtmsConfig?.mediaParams?.video?.fps,
      inferenceFps: deepfakeFrameFps,
      clipSeconds: deepfakeClipSeconds,
      audioMode,
      audioClipSeconds: audioDeepfakeClipSeconds,
      modelName: deepfakeModelName,
      vendorName: deepfakeVendorName,
      audioModelName: audioDeepfakeModelName,
      audioVendorName: audioDeepfakeVendorName
    }
  };
}

function broadcastState() {
  io.emit('state', snapshot());
}

function mergeParticipants(streamId, participants = []) {
  if (!streamId) return;
  const participantMap = getOrCreateMap(state.participantsByStream, streamId);
  for (const rawParticipant of participants) {
    const participant = normalizeParticipant(rawParticipant);
    if (participant.userId == null) continue;
    participantMap.set(participantKey(participant.userId), participant);
  }
}

function removeParticipants(streamId, participants = []) {
  const participantMap = state.participantsByStream.get(streamId);
  if (!participantMap) return;
  for (const rawParticipant of participants) {
    const participant = normalizeParticipant(rawParticipant);
    if (participant.userId == null) continue;
    participantMap.delete(participantKey(participant.userId));
  }
}

function enrichParticipantForStream(streamId, participant = {}) {
  const normalized = normalizeParticipant(participant);
  if (normalized.userId == null) {
    return normalized;
  }

  if (normalized.userName) {
    return normalized;
  }

  const participantMap = state.participantsByStream.get(streamId);
  const existing = participantMap?.get(participantKey(normalized.userId));

  return {
    ...normalized,
    userName: existing?.userName ?? null
  };
}

function replaceVideoOnParticipants(streamId, participants = []) {
  const participantMap = getOrCreateMap(state.videoOnParticipantsByStream, streamId);
  participantMap.clear();
  for (const rawParticipant of participants) {
    const participant = enrichParticipantForStream(streamId, rawParticipant);
    if (participant.userId == null) continue;
    participantMap.set(participantKey(participant.userId), participant);
  }
}

function getSelectedParticipantForStream(streamId) {
  const selected = state.selectedVideoUserByStream.get(streamId);
  if (!selected) return null;
  const participantMap = state.videoOnParticipantsByStream.get(streamId) || state.participantsByStream.get(streamId);
  return enrichParticipantForStream(streamId, participantMap?.get(participantKey(selected.userId)) || selected);
}

function setParticipantVerification(userId, mediaType, status, result = null, participant = null) {
  if (userId == null || String(userId).trim() === '') return;

  const key = participantKey(userId);
  const existing = state.participantVerificationByRtmsUser.get(key) || {};
  const mediaKey = mediaType === 'audio' ? 'audio' : 'video';
  const previousMedia = existing[mediaKey] || {};
  state.participantVerificationByRtmsUser.set(key, {
    ...existing,
    userId,
    userName: participant?.userName ?? participant?.user_name ?? existing.userName ?? null,
    [mediaKey]: {
      status: status || 'unverified',
      vendorName: result?.vendorName || previousMedia.vendorName || (mediaKey === 'audio' ? audioDeepfakeVendorName : deepfakeVendorName),
      realScore: result?.realScore ?? null,
      fakeScore: result?.fakeScore ?? null,
      clipName: result?.clip?.name || previousMedia.clipName || null,
      processingMs: result?.processingMs ?? null,
      updatedAt: Date.now()
    },
    updatedAt: Date.now()
  });
}

function resetDeepfakeState(status = 'unverified') {
  state.deepfakeDetectionEnabled = false;
  state.deepfakeStatus = status;
  state.lastDeepfakeResult = null;
  lastInferenceClipKey = null;
}

function resetAudioDeepfakeState(status = 'unverified') {
  state.audioDeepfakeDetectionEnabled = false;
  state.audioDeepfakeStatus = status;
  state.lastAudioDeepfakeResult = null;
  lastAudioInferenceClipKey = null;
  audioClipBuffer?.reset();
}

function setAudioDeepfakeError(streamId, selectedParticipant = null) {
  state.audioDeepfakeDetectionEnabled = false;
  state.audioDeepfakeStatus = 'error';
  state.lastAudioDeepfakeResult = null;
  const participant = selectedParticipant || getSelectedParticipantForStream(streamId || state.activeStreamId);
  if (participant) {
    setParticipantVerification(participant.userId, 'audio', 'error', null, participant);
  }
}

function selectVideoUser(streamId, userId, source = 'frontend') {
  if (!streamId) throw new Error('No active RTMS stream is available yet.');
  if (userId == null || String(userId).trim() === '') throw new Error('userId is required.');

  const normalizedUserId = normalizeRtmsUserId(userId);

  const participantMap = state.videoOnParticipantsByStream.get(streamId) || state.participantsByStream.get(streamId);
  const participant = enrichParticipantForStream(
    streamId,
    participantMap?.get(participantKey(normalizedUserId)) || { userId: normalizedUserId, userName: null }
  );
  const allowManualUserId = envBoolean('ALLOW_MANUAL_RTMS_USER_ID', false);

  if (!allowManualUserId && !participantMap?.has(participantKey(normalizedUserId))) {
    throw new Error(`RTMS user ${normalizedUserId} is not in the current video-on participant list. Set ALLOW_MANUAL_RTMS_USER_ID=true to override for testing.`);
  }

  RTMSManager.subscribeToIndividualVideo(streamId, normalizedUserId, true);
  state.selectedVideoUserByStream.set(streamId, participant);
  lastInferenceClipKey = null;
  resetDeepfakeState('unverified');
  resetAudioDeepfakeState('unverified');
  setParticipantVerification(normalizedUserId, 'video', 'unverified', null, participant);
  setParticipantVerification(normalizedUserId, 'audio', 'unverified', null, participant);
  log('[DeepfakeDemo] Subscribed to individual video user', {
    streamId,
    userId: normalizedUserId,
    originalUserId: userId,
    source,
    participant
  });
  broadcastState();
}

function startDeepfakeDetection(streamId, source = 'frontend') {
  if (!streamId) throw new Error('No active RTMS stream is available yet.');
  if (!state.selectedVideoUserByStream.get(streamId)) {
    throw new Error('Load an individual video first before starting deepfake detection.');
  }
  if (!hlsPipeline.started) {
    throw new Error('The HLS/video pipeline is not ready yet. Wait for video packets after loading the individual stream.');
  }

  state.deepfakeDetectionEnabled = true;
  state.deepfakeStatus = 'running';
  state.lastDeepfakeResult = null;
  setParticipantVerification(
    state.selectedVideoUserByStream.get(streamId)?.userId,
    'video',
    'running',
    null,
    state.selectedVideoUserByStream.get(streamId)
  );
  log('[DeepfakeDemo] Video deepfake verification started', {
    streamId,
    source,
    selectedParticipant: state.selectedVideoUserByStream.get(streamId)
  });
  broadcastState();
}

function stopDeepfakeDetection(streamId, source = 'frontend') {
  if (streamId && state.activeStreamId && streamId !== state.activeStreamId) {
    throw new Error(`Cannot stop detection for inactive stream ${streamId}.`);
  }

  state.deepfakeDetectionEnabled = false;
  state.deepfakeStatus = state.lastDeepfakeResult ? state.deepfakeStatus : 'unverified';
  lastInferenceClipKey = null;
  const selectedParticipant = getSelectedParticipantForStream(streamId || state.activeStreamId);
  if (selectedParticipant && !state.lastDeepfakeResult) {
    setParticipantVerification(selectedParticipant.userId, 'video', 'unverified', null, selectedParticipant);
  }
  log('[DeepfakeDemo] Video deepfake verification stopped', {
    streamId: streamId || state.activeStreamId,
    source
  });
  broadcastState();
}

function startAudioDeepfakeDetection(streamId, source = 'frontend') {
  if (!streamId) throw new Error('No active RTMS stream is available yet.');
  const selectedParticipant = getSelectedParticipantForStream(streamId);
  if (!selectedParticipant) {
    throw new Error('Load an individual video participant first so audio packets can be filtered to the same RTMS user.');
  }
  if (audioDeepfakeClient.mode !== 'service') {
    throw new Error('Audio verification is disabled. Set AUDIO_DEEPFAKE_MODE=service and configure AUDIO_DEEPFAKE_SERVICE_URL.');
  }

  audioClipBuffer?.reset();
  state.audioDeepfakeDetectionEnabled = true;
  state.audioDeepfakeStatus = 'running';
  state.lastAudioDeepfakeResult = null;
  lastAudioInferenceClipKey = null;
  setParticipantVerification(selectedParticipant.userId, 'audio', 'running', null, selectedParticipant);
  log('[DeepfakeDemo] Audio deepfake verification started', {
    streamId,
    source,
    selectedParticipant,
    audioServiceUrl: audioDeepfakeClient.serviceUrl,
    clipSeconds: audioDeepfakeClipSeconds
  });
  broadcastState();
}

function stopAudioDeepfakeDetection(streamId, source = 'frontend') {
  if (streamId && state.activeStreamId && streamId !== state.activeStreamId) {
    throw new Error(`Cannot stop audio verification for inactive stream ${streamId}.`);
  }

  state.audioDeepfakeDetectionEnabled = false;
  state.audioDeepfakeStatus = state.lastAudioDeepfakeResult ? state.audioDeepfakeStatus : 'unverified';
  lastAudioInferenceClipKey = null;
  audioClipBuffer?.reset();
  const selectedParticipant = getSelectedParticipantForStream(streamId || state.activeStreamId);
  if (selectedParticipant && !state.lastAudioDeepfakeResult) {
    setParticipantVerification(selectedParticipant.userId, 'audio', 'unverified', null, selectedParticipant);
  }
  log('[DeepfakeDemo] Audio deepfake verification stopped', {
    streamId: streamId || state.activeStreamId,
    source
  });
  broadcastState();
}

async function checkDeepfakeBackendHealth(reason = 'startup') {
  if (deepfakeClient.mode !== 'service') {
    return null;
  }

  try {
    const health = await deepfakeClient.checkHealth();
    log('[DeepfakeDemo] Deepfake service is reachable', {
      reason,
      url: deepfakeClient.serviceUrl,
      uploadUrl: deepfakeClient.uploadUrl,
      device: health?.device ?? null,
      model: health?.model ?? null
    });
    return health;
  } catch (error) {
    log('[DeepfakeDemo] Deepfake service health check failed', {
      reason,
      url: deepfakeClient.serviceUrl,
      uploadUrl: deepfakeClient.uploadUrl,
      message: error.message
    });
    throw error;
  }
}

async function checkAudioDeepfakeBackendHealth(reason = 'start_audio_deepfake_detection') {
  if (audioDeepfakeClient.mode !== 'service') {
    return null;
  }

  try {
    const health = await audioDeepfakeClient.checkHealth();
    log('[DeepfakeDemo] Audio deepfake service is reachable', {
      reason,
      url: audioDeepfakeClient.serviceUrl,
      device: health?.device ?? null,
      model: health?.model ?? null
    });
    return health;
  } catch (error) {
    log('[DeepfakeDemo] Audio deepfake service health check failed', {
      reason,
      url: audioDeepfakeClient.serviceUrl,
      message: error.message
    });
    throw error;
  }
}

const appConfig = {
  port: envNumber('PORT', 5050),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || ''
};

validateRequiredEnv(['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_SECRET_TOKEN']);

const mediaTypesFlag = getMediaTypesFlagFromEnv();
const videoMode = normalizeMode(process.env.VIDEO_STREAM_MODE, 'individual');
const audioMode = normalizeMode(process.env.AUDIO_STREAM_MODE, 'multi');
const hlsEnabled = process.env.ENABLE_HLS_PREVIEW !== 'false';
const deepfakeFrameFps = getDeepfakeFrameFps();
const deepfakeClipSeconds = getDeepfakeClipSeconds();
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
const audioDeepfakeServiceUrl = process.env.AUDIO_DEEPFAKE_SERVICE_URL || 'https://deepfake.asdc.cc/audio/classify';
const audioDeepfakeUploadUrl = process.env.AUDIO_DEEPFAKE_UPLOAD_URL || '';
const audioDeepfakeMinRmsDbfs = envNumber('AUDIO_DEEPFAKE_MIN_RMS_DBFS', -65);

validateRuntimeConfig({
  mediaTypesFlag,
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
  apiKey: deepfakeApiKey,
  envName: 'DEEPFAKE_API_KEY',
  serviceName: 'Audio deepfake'
});

const rtmsConfig = {
  logging: {
    enabled: true,
    logDir: path.join(__dirname, 'logs'),
    console: process.env.LOG_LEVEL !== 'off'
  },
  mediaSocketConnectionMode: process.env.MEDIA_SOCKET_CONNECTION_MODE || 'split',
  mediaTypesFlag,
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

const hlsPipeline = new HlsPipeline({
  enabled: hlsEnabled,
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  threadQueueSize: envNumber('FFMPEG_THREAD_QUEUE_SIZE', 1024),
  hlsDir: path.join(__dirname, 'public', 'hls'),
  clipDir: path.join(__dirname, 'public', 'clips'),
  videoFps: rtmsConfig.mediaParams.video.fps,
  frameFps: deepfakeFrameFps,
  clipSegmentSeconds: deepfakeClipSeconds,
  clipStableAgeMs: envNumber('DEEPFAKE_CLIP_STABLE_AGE_MS', Math.max(deepfakeClipSeconds * 750, 1000)),
  clipMinBytes: envNumber('DEEPFAKE_MIN_CLIP_BYTES', 4096),
  hlsSegmentSeconds: envNumber('HLS_SEGMENT_SECONDS', 2),
  hlsListSize: envNumber('HLS_LIST_SIZE', 6),
  vendorName: deepfakeVendorName
});

audioClipBuffer = new AudioClipBuffer({
  clipDir: path.join(__dirname, 'public', 'audio_clips'),
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  clipSeconds: audioDeepfakeClipSeconds,
  maxClips: envNumber('AUDIO_DEEPFAKE_MAX_CLIPS', 24)
});

const deepfakeClient = new DeepfakeClient({
  mode: deepfakeMode,
  modelName: deepfakeModelName,
  serviceUrl: deepfakeServiceUrl,
  uploadUrl: deepfakeUploadUrl,
  apiKey: deepfakeApiKey,
  pythonBin: process.env.PYTHON_BIN || 'python3',
  threshold: envNumber('DEEPFAKE_REAL_THRESHOLD', 0.75),
  vendorName: deepfakeVendorName
});

const audioDeepfakeClient = new AudioDeepfakeClient({
  mode: audioDeepfakeMode,
  modelName: audioDeepfakeModelName,
  serviceUrl: audioDeepfakeServiceUrl,
  uploadUrl: audioDeepfakeUploadUrl,
  apiKey: deepfakeApiKey,
  threshold: envNumber('AUDIO_DEEPFAKE_REAL_THRESHOLD', 0.75),
  vendorName: audioDeepfakeVendorName
});

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

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
  deepfakeUploadUrl: deepfakeClient.mode === 'service' ? deepfakeClient.uploadUrl : null,
  deepfakeFrameFps,
  deepfakeClipSeconds,
  audioDeepfakeMode,
  audioDeepfakeServiceUrl: audioDeepfakeClient.mode === 'service' ? audioDeepfakeClient.serviceUrl : null,
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
app.use(express.json({ limit: '2mb' }));
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
app.use('/hls', express.static(path.join(__dirname, 'public', 'hls'), {
  dotfiles: 'deny',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));
app.use('/clips', express.static(path.join(__dirname, 'public', 'clips'), {
  dotfiles: 'deny',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.render('index', {
    config: {
      publicBaseUrl: appConfig.publicBaseUrl,
      vendorName: deepfakeVendorName,
      enableLayersOverlay: process.env.ENABLE_LAYERS_OVERLAY !== 'false',
      overlayLabelPrefix: process.env.OVERLAY_LABEL_PREFIX || 'Verified by',
      videoFps: rtmsConfig.mediaParams.video.fps,
      frameFps: deepfakeFrameFps,
      clipSeconds: deepfakeClipSeconds,
      audioClipSeconds: audioDeepfakeClipSeconds,
      audioModelName: audioDeepfakeModelName,
      audioVendorName: audioDeepfakeVendorName,
      assetVersion: Date.now()
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    rtmsStatus: state.rtmsStatus,
    streamId: state.activeStreamId,
    hlsReady: state.hlsReady
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
  log('[DeepfakeDemo] Webhook event received', { event, payload });

  if (event === 'meeting.rtms_started') {
    hlsPipeline.stop();
    state.activeStreamId = payload.rtms_stream_id;
    state.activeMeetingId = payload.meeting_uuid;
    state.rtmsStatus = 'starting';
    state.hlsReady = false;
    state.selectedVideoUserByStream.clear();
    state.participantVerificationByRtmsUser.clear();
    lastInferenceClipKey = null;
    resetDeepfakeState('unverified');
    resetAudioDeepfakeState('unverified');
    broadcastState();
  }

  if (event === 'meeting.rtms_stopped') {
    if (payload.rtms_stream_id && state.activeStreamId && payload.rtms_stream_id !== state.activeStreamId) {
      log('[DeepfakeDemo] Ignoring stale stop webhook for inactive stream', {
        activeStreamId: state.activeStreamId,
        stoppedStreamId: payload.rtms_stream_id,
        stopReason: payload.stop_reason ?? null
      });
      RTMSManager.handleEvent(event, payload);
      return;
    }

    state.rtmsStatus = 'stopped';
    hlsPipeline.stop();
    state.hlsReady = false;
    state.selectedVideoUserByStream.clear();
    state.participantVerificationByRtmsUser.clear();
    lastInferenceClipKey = null;
    resetDeepfakeState('stopped');
    resetAudioDeepfakeState('stopped');
    broadcastState();
  }

  RTMSManager.handleEvent(event, payload);
});

webhookManager.setup();

await RTMSManager.init(rtmsConfig);

RTMSManager.instance.on('error', (error) => {
  log('[DeepfakeDemo] RTMS error', error.toString ? error.toString() : error);
});

RTMSManager.on('audio', ({ buffer, userId, userName, timestamp, streamId }) => {
  const selectedParticipant = getSelectedParticipantForStream(streamId);
  const selectedAudio = Boolean(
    selectedParticipant?.userId != null
    && userId != null
    && String(selectedParticipant.userId) === String(userId)
  );

  if (selectedAudio) {
    hlsPipeline.writeAudio(buffer);
    audioClipBuffer?.writeAudio(buffer, {
      streamId,
      userId,
      userName: userName ?? selectedParticipant.userName ?? null,
      timestamp: timestamp ?? Date.now()
    });
  }

  io.emit('audio_packet', {
    streamId,
    userId: userId ?? null,
    userName: userName ?? null,
    timestamp: timestamp ?? Date.now(),
    bytes: buffer?.length ?? 0,
    selectedAudio,
    audioMode,
    activeSpeaker: state.activeSpeakerByStream.get(streamId) || null
  });
});

RTMSManager.on('video', ({ buffer, userId, userName, timestamp, streamId }) => {
  hlsPipeline.writeVideo(buffer);
  io.emit('video_packet', {
    streamId,
    userId: userId ?? null,
    userName: userName ?? null,
    timestamp: timestamp ?? Date.now(),
    bytes: buffer?.length ?? 0
  });
});

RTMSManager.on('event', (eventData) => {
  const streamId = eventData.streamId;
  const participants = eventData.data?.participants || [];

  if (eventData.eventType === 2) {
    const activeSpeaker = normalizeParticipant(eventData.data);
    state.activeSpeakerByStream.set(streamId, activeSpeaker);
    io.emit('active_speaker', { streamId, activeSpeaker });
  }

  if (eventData.eventType === 3) {
    mergeParticipants(streamId, participants);
  }

  if (eventData.eventType === 4) {
    removeParticipants(streamId, participants);
  }

  io.emit('rtms_event', eventData);
  broadcastState();
});

RTMSManager.on('participant_video_on', ({ availableParticipants, streamId }) => {
  replaceVideoOnParticipants(streamId, availableParticipants);
  io.emit('video_on_participants_changed', { streamId, availableParticipants });
  broadcastState();
});

RTMSManager.on('participant_video_off', ({ availableParticipants, streamId }) => {
  replaceVideoOnParticipants(streamId, availableParticipants);
  io.emit('video_on_participants_changed', { streamId, availableParticipants });
  broadcastState();
});

RTMSManager.on('video_on_participants_changed', ({ availableParticipants, streamId }) => {
  replaceVideoOnParticipants(streamId, availableParticipants);
  io.emit('video_on_participants_changed', { streamId, availableParticipants });
  broadcastState();
});

RTMSManager.on('video_subscription_response', (message) => {
  log('[DeepfakeDemo] Video subscription response', {
    streamId: message.streamId,
    userId: message.userId,
    success: message.success,
    statusCode: message.statusCode,
    reason: message.reason,
    currentVideoSubscriptionUserId: message.currentVideoSubscriptionUserId
  });
  io.emit('video_subscription_response', message);
  broadcastState();
});

RTMSManager.on('stream_state_changed', (message) => {
  if (message.state === 1) state.rtmsStatus = 'running';
  if (message.state === 3 || message.state === 4) state.rtmsStatus = 'stopped';
  io.emit('stream_state_changed', message);
  broadcastState();
});

hlsPipeline.on('started', (payload) => {
  state.hlsReady = true;
  io.emit('hls_ready', payload);
  broadcastState();
});
hlsPipeline.on('reset', (payload) => {
  state.hlsReady = false;
  io.emit('hls_reset', payload);
  broadcastState();
});
hlsPipeline.on('log', (message) => log(message));
hlsPipeline.on('error', (error) => {
  state.hlsReady = false;
  log('[DeepfakeDemo] HLS pipeline error', error.message);
  broadcastState();
});

setInterval(async () => {
  if (!state.deepfakeDetectionEnabled || inferenceInFlight || !hlsPipeline.hasLatestClip()) return;

  const latestClip = hlsPipeline.getLatestClip();
  if (!latestClip) return;

  const clipKey = `${latestClip.path}:${latestClip.mtimeMs}`;
  if (clipKey === lastInferenceClipKey) return;
  lastInferenceClipKey = clipKey;

  const selectedParticipant = getSelectedParticipantForStream(state.activeStreamId);
  inferenceInFlight = true;
  const inferenceStartedAt = Date.now();

  try {
    const result = await deepfakeClient.classifyVideo(latestClip.path, {
      streamId: state.activeStreamId,
      meetingId: state.activeMeetingId,
      selectedParticipant,
      clipPath: latestClip.path,
      clipMtimeMs: latestClip.mtimeMs
    });
    const inferenceCompletedAt = Date.now();
    result.clip = {
      name: path.basename(latestClip.path),
      path: latestClip.path,
      size: latestClip.size,
      mtimeMs: latestClip.mtimeMs
    };
    result.processingMs = inferenceCompletedAt - inferenceStartedAt;
    result.completedAt = inferenceCompletedAt;
    result.clipAgeMs = Math.max(0, inferenceStartedAt - latestClip.mtimeMs);

    state.lastDeepfakeResult = result;
    state.deepfakeStatus = result.status || (result.verified === true ? 'verified' : 'unverified');
    if (selectedParticipant) {
      setParticipantVerification(selectedParticipant.userId, 'video', state.deepfakeStatus, result, selectedParticipant);
    }
    io.emit('deepfake_result', result);
    broadcastState();
  } catch (error) {
    state.deepfakeStatus = 'error';
    if (selectedParticipant) {
      setParticipantVerification(selectedParticipant.userId, 'video', 'error', null, selectedParticipant);
    }
    io.emit('deepfake_error', {
      message: error.message,
      timestamp: Date.now()
    });
    log('[DeepfakeDemo] Deepfake inference failed', error.message);
  } finally {
    inferenceInFlight = false;
  }
}, 1000);

setInterval(async () => {
  if (!state.audioDeepfakeDetectionEnabled || audioInferenceInFlight || !audioClipBuffer?.hasLatestClip()) return;

  const latestClip = audioClipBuffer.getLatestClip();
  if (!latestClip) return;

  const clipKey = `${latestClip.path}:${latestClip.mtimeMs}`;
  if (clipKey === lastAudioInferenceClipKey) return;
  lastAudioInferenceClipKey = clipKey;

  const selectedParticipant = getSelectedParticipantForStream(state.activeStreamId);
  if (!selectedParticipant || String(latestClip.userId ?? '') !== String(selectedParticipant.userId ?? '')) {
    return;
  }

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
        path: latestClip.path,
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

    state.lastAudioDeepfakeResult = skippedResult;
    state.audioDeepfakeStatus = 'unverified';
    setParticipantVerification(selectedParticipant.userId, 'audio', 'unverified', skippedResult, selectedParticipant);
    io.emit('audio_deepfake_result', skippedResult);
    log('[DeepfakeDemo] Audio deepfake verification skipped low-signal clip', {
      clip: skippedResult.clip.name,
      selectedParticipant,
      minRmsDbfs: audioDeepfakeMinRmsDbfs,
      audioStats: latestClip.audioStats
    });
    broadcastState();
    return;
  }

  audioInferenceInFlight = true;
  const inferenceStartedAt = Date.now();

  try {
    const result = await audioDeepfakeClient.classifyAudio(latestClip.path, {
      streamId: state.activeStreamId,
      meetingId: state.activeMeetingId,
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
    const inferenceCompletedAt = Date.now();
    result.clip = {
      name: latestClip.name || path.basename(latestClip.path),
      path: latestClip.path,
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

    state.lastAudioDeepfakeResult = result;
    state.audioDeepfakeStatus = result.status || (result.verified === true ? 'verified' : 'unverified');
    setParticipantVerification(selectedParticipant.userId, 'audio', state.audioDeepfakeStatus, result, selectedParticipant);
    io.emit('audio_deepfake_result', result);
    log('[DeepfakeDemo] Audio deepfake verification result', {
      clip: result.clip.name,
      status: state.audioDeepfakeStatus,
      realScore: result.realScore,
      fakeScore: result.fakeScore,
      audioInfo: result.audioInfo,
      audioStats: result.audioStats,
      processingMs: result.processingMs
    });
    broadcastState();
  } catch (error) {
    setAudioDeepfakeError(state.activeStreamId, selectedParticipant);
    io.emit('audio_deepfake_error', {
      message: error.message,
      timestamp: Date.now()
    });
    log('[DeepfakeDemo] Audio deepfake inference failed', error.message);
    broadcastState();
  } finally {
    audioInferenceInFlight = false;
  }
}, 1000);

io.on('connection', (socket) => {
  log('[DeepfakeDemo] Zoom App client connected', { socketId: socket.id });
  socket.emit('state', snapshot());

  socket.on('zoom_participants', ({ meetingId, participants = [] } = {}) => {
    const resolvedMeetingId = meetingId || state.activeMeetingId || 'current';
    const participantMap = getOrCreateMap(state.zoomParticipantsByMeeting, resolvedMeetingId);
    participantMap.clear();
    for (const participant of participants) {
      const uuid = participant.participantUUID || participant.participantUuid || participant.id;
      if (!uuid) continue;
      participantMap.set(uuid, participant);
    }
    broadcastState();
  });

  socket.on('select_video_user', ({ streamId, userId } = {}, callback) => {
    try {
      selectVideoUser(streamId || state.activeStreamId, userId, 'frontend');
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on('start_deepfake_detection', ({ streamId } = {}, callback) => {
    Promise.resolve()
      .then(async () => {
        await checkDeepfakeBackendHealth('start_deepfake_detection');
        startDeepfakeDetection(streamId || state.activeStreamId, 'frontend');
        callback?.({ ok: true });
      })
      .catch((error) => {
        callback?.({ ok: false, error: error.message });
      });
  });

  socket.on('stop_deepfake_detection', ({ streamId } = {}, callback) => {
    try {
      stopDeepfakeDetection(streamId || state.activeStreamId, 'frontend');
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on('start_audio_deepfake_detection', ({ streamId } = {}, callback) => {
    Promise.resolve()
      .then(async () => {
        await checkAudioDeepfakeBackendHealth('start_audio_deepfake_detection');
        startAudioDeepfakeDetection(streamId || state.activeStreamId, 'frontend');
        callback?.({ ok: true });
      })
      .catch((error) => {
        callback?.({ ok: false, error: error.message });
      });
  });

  socket.on('stop_audio_deepfake_detection', ({ streamId } = {}, callback) => {
    try {
      stopAudioDeepfakeDetection(streamId || state.activeStreamId, 'frontend');
      callback?.({ ok: true });
    } catch (error) {
      callback?.({ ok: false, error: error.message });
    }
  });

  socket.on('set_participant_mapping', ({ rtmsUserId, participantUUID } = {}, callback) => {
    if (!rtmsUserId || !participantUUID) {
      callback?.({ ok: false, error: 'rtmsUserId and participantUUID are required.' });
      return;
    }
    state.participantMappings.set(participantKey(rtmsUserId), participantUUID);
    broadcastState();
    callback?.({ ok: true });
  });

  socket.on('rtms_control_update', ({ status } = {}) => {
    if (status) {
      if (status === 'stopped' && state.activeStreamId) {
        try {
          RTMSManager.instance.onStreamStop(state.activeStreamId);
          log('[DeepfakeDemo] Local stop requested, disabled RTMS reconnect immediately', {
            streamId: state.activeStreamId
          });
        } catch (error) {
          log('[DeepfakeDemo] Failed to suppress reconnect on local stop', { message: error.message });
        }
        hlsPipeline.stop();
        state.hlsReady = false;
        state.selectedVideoUserByStream.clear();
        state.participantVerificationByRtmsUser.clear();
        resetDeepfakeState('stopped');
        resetAudioDeepfakeState('stopped');
      }
      state.rtmsStatus = status;
      broadcastState();
    }
  });
});

await RTMSManager.start();
await checkDeepfakeBackendHealth('startup').catch(() => {});
await checkAudioDeepfakeBackendHealth('startup').catch(() => {});

server.listen(appConfig.port, () => {
  console.log(`[DeepfakeDemo] Server listening on port ${appConfig.port}`);
  console.log(`[DeepfakeDemo] Zoom App URL: ${appConfig.publicBaseUrl || `http://localhost:${appConfig.port}`}`);
  console.log(`[DeepfakeDemo] Webhook URL: ${(appConfig.publicBaseUrl || `http://localhost:${appConfig.port}`)}${appConfig.webhookPath}`);
});

process.on('SIGINT', async () => {
  console.log('[DeepfakeDemo] Shutting down...');
  hlsPipeline.stop();
  server.close();
  await RTMSManager.stop();
  process.exit(0);
});
