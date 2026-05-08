const socket = io();
const appConfig = window.APP_CONFIG || {};
let sdk = window.zoomSdk || null;
const BASE_CAPABILITIES = [
  'getSupportedJsApis',
  'getAppContext',
  'getMeetingContext',
  'getMeetingUUID',
  'getMeetingParticipants',
  'getRunningContext',
  'getUserContext',
  'onRTMSStatusChange',
  'startRTMS',
  'stopRTMS',
  'showNotification',
  'onParticipantChange'
];
const LAYERS_CAPABILITIES = [
  'runRenderingContext',
  'closeRenderingContext',
  'drawParticipant',
  'clearParticipant',
  'drawImage',
  'clearImage'
];
const OPTIONAL_LAYERS_CAPABILITIES = [
  'clearWebView'
];

const elements = {
  startRtmsButton: document.getElementById('startRtmsButton'),
  stopRtmsButton: document.getElementById('stopRtmsButton'),
  loadVideoButton: document.getElementById('loadVideoButton'),
  startDetectionButton: document.getElementById('startDetectionButton'),
  stopDetectionButton: document.getElementById('stopDetectionButton'),
  startAudioDetectionButton: document.getElementById('startAudioDetectionButton'),
  stopAudioDetectionButton: document.getElementById('stopAudioDetectionButton'),
  overlayButton: document.getElementById('overlayButton'),
  closeOverlayButton: document.getElementById('closeOverlayButton'),
  overlaySurfaceStatus: document.getElementById('overlaySurfaceStatus'),
  layersCloseOverlayButton: document.getElementById('layersCloseOverlayButton'),
  zoomSdkStatus: document.getElementById('zoomSdkStatus'),
  rtmsStatus: document.getElementById('rtmsStatus'),
  streamId: document.getElementById('streamId'),
  activeSpeaker: document.getElementById('activeSpeaker'),
  rtmsParticipantSelect: document.getElementById('rtmsParticipantSelect'),
  zoomParticipantSelect: document.getElementById('zoomParticipantSelect'),
  participantStatusList: document.getElementById('participantStatusList'),
  participantCount: document.getElementById('participantCount'),
  videoPlayer: document.getElementById('videoPlayer'),
  playbackStatus: document.getElementById('playbackStatus'),
  verdictBadge: document.getElementById('verdictBadge'),
  audioVerdictBadge: document.getElementById('audioVerdictBadge'),
  heroInferenceMode: document.getElementById('heroInferenceMode'),
  heroMediaMode: document.getElementById('heroMediaMode'),
  heroModelName: document.getElementById('heroModelName'),
  modelName: document.getElementById('modelName'),
  audioModelName: document.getElementById('audioModelName'),
  videoFps: document.getElementById('videoFps'),
  clipFps: document.getElementById('clipFps'),
  clipDuration: document.getElementById('clipDuration'),
  audioClipDuration: document.getElementById('audioClipDuration'),
  clipName: document.getElementById('clipName'),
  audioClipName: document.getElementById('audioClipName'),
  processingTime: document.getElementById('processingTime'),
  audioProcessingTime: document.getElementById('audioProcessingTime'),
  realScore: document.getElementById('realScore'),
  fakeScore: document.getElementById('fakeScore'),
  audioRealScore: document.getElementById('audioRealScore'),
  audioFakeScore: document.getElementById('audioFakeScore'),
  logOutput: document.getElementById('logOutput')
};

let hls = null;
let currentState = {};
let zoomParticipants = [];
let meetingContext = null;
let runningContext = null;
let renderedBadgeImageId = null;
let rtmsControlInFlight = false;
let supportedApis = new Set();
let layersApisAvailable = false;
let sdkReady = false;
let sdkLoadPromise = null;
let currentPlaybackUrl = null;
let overlayActive = false;
applyRuntimeConfig(appConfig);
const IMMERSIVE_PARTICIPANT_FRAME = {
  x: 24,
  y: 150,
  width: 760,
  height: 540
};
const OVERLAY_BADGE_SIZE = {
  width: 520,
  height: 74
};

function setRunningContextUi(contextName) {
  document.documentElement.classList.remove('layers-runtime');
  document.body.classList.remove('layers-runtime');
}

function setOverlaySurfaceStatus(label, tone = 'pending') {
  if (elements.overlaySurfaceStatus) {
    elements.overlaySurfaceStatus.textContent = label;
  }
  document.body.classList.toggle('overlay-verified', tone === 'verified');
  document.body.classList.toggle('overlay-warning', tone === 'warning');
}

function normalizeSupportedApis(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.apis)) return response.apis;
  if (Array.isArray(response?.supportedApis)) return response.supportedApis;
  return [];
}

function log(message, data) {
  const line = data === undefined
    ? `${new Date().toISOString()} ${message}`
    : `${new Date().toISOString()} ${message} ${JSON.stringify(data)}`;
  if (data === undefined) {
    console.log(`[DeepfakeDemo:UI] ${message}`);
  } else {
    console.log(`[DeepfakeDemo:UI] ${message}`, data);
  }
  elements.logOutput.textContent = `${line}\n${elements.logOutput.textContent}`.slice(0, 12000);
}

function formatParticipant(participant = {}) {
  const id = participant.userId ?? participant.user_id ?? participant.participantUUID ?? participant.id;
  const name = participant.userName || participant.user_name || participant.displayName || participant.screenName || (id == null ? 'Unknown' : `User ${id}`);
  return `${name} (${id})`;
}

function participantName(participant = {}) {
  const id = participant.userId ?? participant.user_id ?? participant.participantUUID ?? participant.id;
  return participant.userName || participant.user_name || participant.displayName || participant.screenName || (id == null ? 'Unknown' : `User ${id}`);
}

function participantIdentity(participant = {}) {
  return participant.participantUUID || participant.participantUuid || participant.id || participant.userId || participant.user_id || null;
}

function normalizeName(value = '') {
  return String(value || '').trim().toLowerCase();
}

function renderRtmsParticipants(participants = []) {
  const selectedValue = elements.rtmsParticipantSelect.value;
  elements.rtmsParticipantSelect.innerHTML = '';

  if (participants.length === 0) {
    elements.rtmsParticipantSelect.innerHTML = '<option value="">Waiting for PARTICIPANT_VIDEO_ON...</option>';
    return;
  }

  for (const participant of participants) {
    const option = document.createElement('option');
    option.value = String(participant.userId);
    option.textContent = formatParticipant(participant);
    elements.rtmsParticipantSelect.appendChild(option);
  }

  if (selectedValue && participants.some((participant) => String(participant.userId) === selectedValue)) {
    elements.rtmsParticipantSelect.value = selectedValue;
  }
}

function renderZoomParticipants(participants = []) {
  const selectedValue = elements.zoomParticipantSelect.value;
  elements.zoomParticipantSelect.innerHTML = '';

  if (participants.length === 0) {
    elements.zoomParticipantSelect.innerHTML = '<option value="">No Zoom participants loaded</option>';
    return;
  }

  for (const participant of participants) {
    const option = document.createElement('option');
    option.value = participantIdentity(participant) || participantName(participant);
    option.textContent = participantName(participant);
    elements.zoomParticipantSelect.appendChild(option);
  }

  if (selectedValue && participants.some((participant) => String(participantIdentity(participant) || participantName(participant)) === selectedValue)) {
    elements.zoomParticipantSelect.value = selectedValue;
  }
}

function findRtmsParticipantForZoomParticipant(zoomParticipant = {}) {
  const allRtmsParticipants = [
    ...(currentState.videoOnParticipants || []),
    ...(currentState.participants || [])
  ];
  const byUserId = new Map();
  for (const participant of allRtmsParticipants) {
    if (participant?.userId != null) {
      byUserId.set(String(participant.userId), participant);
    }
  }

  const zoomUuid = String(participantIdentity(zoomParticipant) || '');
  for (const [rtmsUserId, participantUuid] of Object.entries(currentState.participantMappings || {})) {
    if (String(participantUuid) === zoomUuid) {
      return byUserId.get(String(rtmsUserId)) || { userId: rtmsUserId, userName: participantName(zoomParticipant) };
    }
  }

  const directUserId = zoomParticipant.userId ?? zoomParticipant.user_id ?? null;
  if (directUserId != null && byUserId.has(String(directUserId))) {
    return byUserId.get(String(directUserId));
  }

  const zoomName = normalizeName(participantName(zoomParticipant));
  if (!zoomName) return null;

  return allRtmsParticipants.find((participant) => normalizeName(participantName(participant)) === zoomName) || null;
}

function participantStatusDetails(status = 'not_checked') {
  const normalized = String(status || 'not_checked').toLowerCase();
  if (normalized === 'verified') return { label: 'Verified', tone: 'verified' };
  if (normalized === 'deepfake' || normalized === 'fake') return { label: 'Deepfake', tone: 'warning' };
  if (normalized === 'running' || normalized === 'analyzing') return { label: 'Analyzing', tone: 'running' };
  if (normalized === 'error') return { label: 'Error', tone: 'warning' };
  if (normalized === 'unverified') return { label: 'Unverified', tone: 'pending' };
  return { label: 'Not checked', tone: 'muted' };
}

function getVerificationForRtmsParticipant(rtmsParticipant) {
  if (rtmsParticipant?.userId == null) return null;
  const key = String(rtmsParticipant.userId);
  const storedVerification = currentState.participantVerification?.[key];
  const verification = storedVerification ? { ...storedVerification } : {};

  if (storedVerification?.status && !storedVerification.video && !storedVerification.audio) {
    verification.video = {
      status: storedVerification.status,
      realScore: storedVerification.realScore ?? null,
      fakeScore: storedVerification.fakeScore ?? null,
      clipName: storedVerification.clipName || null
    };
  }

  if (String(currentState.selectedVideoUser?.userId ?? '') === key) {
    verification.video ||= {
      status: currentState.deepfakeStatus || 'unverified',
      realScore: currentState.lastDeepfakeResult?.realScore ?? null,
      fakeScore: currentState.lastDeepfakeResult?.fakeScore ?? null,
      clipName: currentState.lastDeepfakeResult?.clip?.name || null
    };
    verification.audio ||= {
      status: currentState.audioDeepfakeStatus || 'unverified',
      realScore: currentState.lastAudioDeepfakeResult?.realScore ?? null,
      fakeScore: currentState.lastAudioDeepfakeResult?.fakeScore ?? null,
      clipName: currentState.lastAudioDeepfakeResult?.clip?.name || null
    };
  }

  return verification.video || verification.audio ? verification : null;
}

function formatScorePair(label, verification = {}) {
  if (verification.realScore == null || verification.fakeScore == null) return '';
  return `${label} Real ${Number(verification.realScore).toFixed(3)} / Fake ${Number(verification.fakeScore).toFixed(3)}`;
}

function renderParticipantStatusList() {
  if (!elements.participantStatusList) return;

  const sourceParticipants = zoomParticipants.length > 0
    ? zoomParticipants
    : (currentState.zoomParticipants || []);
  const fallbackParticipants = sourceParticipants.length > 0
    ? sourceParticipants
    : (currentState.videoOnParticipants || []);

  elements.participantStatusList.innerHTML = '';
  if (elements.participantCount) {
    elements.participantCount.textContent = `${fallbackParticipants.length} loaded`;
  }

  if (fallbackParticipants.length === 0) {
    elements.participantStatusList.innerHTML = '<div class="participant-empty">No participants loaded yet. Open this inside Zoom and start RTMS.</div>';
    return;
  }

  for (const participant of fallbackParticipants) {
    const rtmsParticipant = findRtmsParticipantForZoomParticipant(participant) || (
      participant.userId != null ? participant : null
    );
    const verification = getVerificationForRtmsParticipant(rtmsParticipant);
    const videoStatus = participantStatusDetails(verification?.video?.status || (rtmsParticipant ? 'unverified' : 'not_checked'));
    const audioStatus = participantStatusDetails(verification?.audio?.status || (rtmsParticipant ? 'unverified' : 'not_checked'));
    const isSelected = rtmsParticipant?.userId != null
      && String(currentState.selectedVideoUser?.userId ?? '') === String(rtmsParticipant.userId);
    const videoScores = formatScorePair('Video', verification?.video);
    const audioScores = formatScorePair('Audio', verification?.audio);

    const row = document.createElement('div');
    row.className = `participant-status-row${isSelected ? ' selected' : ''}`;
    row.innerHTML = `
      <div class="participant-status-main">
        <strong></strong>
        <span></span>
      </div>
      <div class="participant-chip-stack">
        <span class="participant-verification-chip video ${videoStatus.tone}"></span>
        <span class="participant-verification-chip audio ${audioStatus.tone}"></span>
      </div>
    `;
    row.querySelector('strong').textContent = participantName(participant);
    row.querySelector('.participant-status-main span').textContent = [
      rtmsParticipant?.userId != null ? `RTMS ${rtmsParticipant.userId}` : 'Zoom participant',
      isSelected ? 'selected stream' : null,
      videoScores || null,
      audioScores || null
    ].filter(Boolean).join(' · ');
    row.querySelector('.participant-verification-chip.video').textContent = `Video: ${videoStatus.label}`;
    row.querySelector('.participant-verification-chip.audio').textContent = `Audio: ${audioStatus.label}`;
    elements.participantStatusList.appendChild(row);
  }
}

function setPlayback(hlsUrl) {
  if (!hlsUrl) return;
  if (currentPlaybackUrl === hlsUrl) {
    return;
  }
  currentPlaybackUrl = hlsUrl;

  const url = `${hlsUrl}${hlsUrl.includes('?') ? '&' : '?'}clientTs=${Date.now()}`;

  if (hls) {
    hls.destroy();
    hls = null;
  }

  if (window.Hls?.isSupported()) {
    hls = new Hls({
      enableWorker: false,
      lowLatencyMode: false,
      maxBufferLength: 10,
      backBufferLength: 8
    });
    hls.loadSource(url);
    hls.attachMedia(elements.videoPlayer);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      elements.videoPlayer.play().catch(() => {});
      elements.playbackStatus.textContent = 'HLS stream attached.';
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data?.fatal && data?.type === 'otherError' && data?.details === 'internalException') {
        log('Ignoring non-fatal HLS internal exception', data);
        return;
      }

      if (!data?.fatal && data?.details === 'bufferStalledError') {
        elements.playbackStatus.textContent = 'HLS waiting for the next segment...';
        log('Transient HLS buffer stall detected', data);
        elements.videoPlayer.play().catch(() => {});
        return;
      }

      const details = [data?.type, data?.details, data?.fatal ? 'fatal' : null].filter(Boolean).join(' / ');
      elements.playbackStatus.textContent = `HLS warning: ${details || 'unknown error'}`;
      log('HLS playback error', data);

      if (!data?.fatal) {
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }

      hls.destroy();
      hls = null;
      currentPlaybackUrl = null;
    });
    return;
  }

  if (elements.videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
    elements.videoPlayer.src = url;
    elements.videoPlayer.play().catch(() => {});
    elements.playbackStatus.textContent = 'Native HLS stream attached.';
    return;
  }

  elements.playbackStatus.textContent = 'This browser does not support HLS playback.';
}

function updateVerdict(result) {
  if (!result || result.skipped) {
    elements.verdictBadge.className = 'verdict-badge pending';
    elements.verdictBadge.textContent = 'Video unverified';
    elements.clipName.textContent = 'n/a';
    elements.processingTime.textContent = 'n/a';
    elements.realScore.textContent = 'n/a';
    elements.fakeScore.textContent = 'n/a';
    renderParticipantStatusList();
    return;
  }

  const status = result.status || (result.verified === true ? 'verified' : result.deepfake === true ? 'deepfake' : 'unverified');
  const verified = status === 'verified';
  const deepfake = status === 'deepfake';
  elements.verdictBadge.className = `verdict-badge ${verified ? 'verified' : deepfake ? 'warning' : 'pending'}`;
  elements.verdictBadge.textContent = verified
    ? `Video verified by ${result.vendorName || appConfig.vendorName}`
    : deepfake
      ? 'Video flagged as deepfake'
      : 'Video unverified';
  elements.clipName.textContent = result.clip?.name || result.metadata?.clipPath?.split('/').pop() || 'n/a';
  elements.processingTime.textContent = result.processingMs == null ? 'n/a' : `${Math.round(result.processingMs)} ms`;
  elements.realScore.textContent = result.realScore == null ? 'n/a' : result.realScore.toFixed(3);
  elements.fakeScore.textContent = result.fakeScore == null ? 'n/a' : result.fakeScore.toFixed(3);
  renderParticipantStatusList();
}

function updateAudioVerdict(result) {
  if (!elements.audioVerdictBadge) return;

  if (!result || result.skipped) {
    elements.audioVerdictBadge.className = 'verdict-badge pending';
    elements.audioVerdictBadge.textContent = 'Audio unverified';
    elements.audioClipName.textContent = 'n/a';
    elements.audioProcessingTime.textContent = 'n/a';
    elements.audioRealScore.textContent = 'n/a';
    elements.audioFakeScore.textContent = 'n/a';
    renderParticipantStatusList();
    return;
  }

  const status = result.status || (result.verified === true ? 'verified' : result.deepfake === true ? 'deepfake' : 'unverified');
  const verified = status === 'verified';
  const deepfake = status === 'deepfake';
  elements.audioVerdictBadge.className = `verdict-badge ${verified ? 'verified' : deepfake ? 'warning' : 'pending'}`;
  elements.audioVerdictBadge.textContent = verified
    ? `Audio verified by ${result.vendorName || 'audio service'}`
    : deepfake
      ? 'Audio flagged as deepfake'
      : 'Audio unverified';
  elements.audioClipName.textContent = result.clip?.name || result.metadata?.clipPath?.split('/').pop() || 'n/a';
  elements.audioProcessingTime.textContent = result.processingMs == null ? 'n/a' : `${Math.round(result.processingMs)} ms`;
  elements.audioRealScore.textContent = result.realScore == null ? 'n/a' : result.realScore.toFixed(3);
  elements.audioFakeScore.textContent = result.fakeScore == null ? 'n/a' : result.fakeScore.toFixed(3);
  renderParticipantStatusList();
}

function applyDeepfakeStatus(status, result) {
  if (status === 'running') {
    elements.verdictBadge.className = 'verdict-badge pending';
    elements.verdictBadge.textContent = 'Video analysis running';
    elements.clipName.textContent = 'waiting...';
    elements.processingTime.textContent = 'waiting...';
    elements.realScore.textContent = 'n/a';
    elements.fakeScore.textContent = 'n/a';
    setOverlaySurfaceStatus('ANALYZING', 'pending');
    return;
  }

  if (status === 'unverified' || status === 'stopped' || !status) {
    updateVerdict(null);
    setOverlaySurfaceStatus('UNVERIFIED', 'pending');
    return;
  }

  if (status === 'error') {
    elements.verdictBadge.className = 'verdict-badge warning';
    elements.verdictBadge.textContent = 'Video analysis error';
    setOverlaySurfaceStatus('ERROR', 'warning');
    return;
  }

  updateVerdict(result);
  if (result?.verified === true) {
    setOverlaySurfaceStatus('VERIFIED', 'verified');
  } else if (status === 'deepfake') {
    setOverlaySurfaceStatus('DEEPFAKE', 'warning');
  }
}

function applyAudioDeepfakeStatus(status, result) {
  if (!elements.audioVerdictBadge) return;

  if (status === 'running') {
    elements.audioVerdictBadge.className = 'verdict-badge pending';
    elements.audioVerdictBadge.textContent = 'Audio analysis running';
    elements.audioClipName.textContent = 'waiting for selected speaker audio...';
    elements.audioProcessingTime.textContent = 'waiting...';
    elements.audioRealScore.textContent = 'n/a';
    elements.audioFakeScore.textContent = 'n/a';
    return;
  }

  if (status === 'unverified' || status === 'stopped' || !status) {
    updateAudioVerdict(null);
    return;
  }

  if (status === 'error') {
    elements.audioVerdictBadge.className = 'verdict-badge warning';
    elements.audioVerdictBadge.textContent = 'Audio analysis error';
    return;
  }

  updateAudioVerdict(result);
}

function updateControlButtons(status) {
  const startingOrRunning = status === 'starting' || status === 'running';
  const canStart = sdkReady && supportedApis.has('startRTMS');
  const canStop = sdkReady && supportedApis.has('stopRTMS');
  elements.startRtmsButton.disabled = rtmsControlInFlight || startingOrRunning || !canStart;
  elements.stopRtmsButton.disabled = rtmsControlInFlight || status === 'stopped' || !canStop;
  elements.loadVideoButton.disabled = !currentState.streamId || !selectedRtmsUserId();
  elements.startDetectionButton.disabled = !currentState.streamId || !currentState.selectedVideoUser || currentState.deepfakeDetectionEnabled;
  elements.stopDetectionButton.disabled = !currentState.deepfakeDetectionEnabled;
  if (elements.startAudioDetectionButton) {
    elements.startAudioDetectionButton.disabled = !currentState.streamId || !currentState.selectedVideoUser || currentState.audioDeepfakeDetectionEnabled;
  }
  if (elements.stopAudioDetectionButton) {
    elements.stopAudioDetectionButton.disabled = !currentState.audioDeepfakeDetectionEnabled;
  }
  if (elements.overlayButton) {
    elements.overlayButton.disabled = !layersApisAvailable || !currentState.selectedVideoUser;
  }
  if (elements.closeOverlayButton) {
    elements.closeOverlayButton.disabled = !layersApisAvailable;
  }
}

function setStatusChip(element, value, tone = 'muted') {
  element.textContent = value;
  element.className = `status-chip ${tone}`.trim();
}

function rtmsStatusTone(status) {
  if (status === 'running') return 'running';
  if (status === 'starting') return 'warning';
  if (status === 'stopped') return 'muted';
  return 'warning';
}

function formatNumber(value, fallback = 'n/a') {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Number.isInteger(numberValue) ? String(numberValue) : String(Number(numberValue.toFixed(2)));
}

function applyRuntimeConfig(runtimeConfig = appConfig) {
  const videoFps = formatNumber(runtimeConfig.videoFps ?? appConfig.videoFps);
  const inferenceFps = formatNumber(runtimeConfig.inferenceFps ?? runtimeConfig.frameFps ?? appConfig.frameFps);
  const clipSeconds = formatNumber(runtimeConfig.clipSeconds ?? appConfig.clipSeconds);
  const audioClipSeconds = formatNumber(runtimeConfig.audioClipSeconds ?? appConfig.audioClipSeconds);
  const modelName = runtimeConfig.vendorName || runtimeConfig.modelName || appConfig.vendorName || 'n/a';
  const audioModelName = runtimeConfig.audioVendorName || runtimeConfig.audioModelName || 'Audio service';

  elements.heroInferenceMode.textContent = `Video inference ${inferenceFps} fps`;
  elements.heroMediaMode.textContent = `RTMS ${videoFps} fps video · ${clipSeconds}s video clips · ${audioClipSeconds}s individual audio`;
  elements.heroModelName.textContent = `Video: ${modelName} · Audio: ${audioModelName}`;
  elements.modelName.textContent = modelName;
  if (elements.audioModelName) elements.audioModelName.textContent = audioModelName;
  elements.videoFps.textContent = `${videoFps} fps`;
  elements.clipFps.textContent = `${inferenceFps} fps`;
  elements.clipDuration.textContent = `${clipSeconds} s`;
  if (elements.audioClipDuration) elements.audioClipDuration.textContent = `${audioClipSeconds} s`;
}

function waitForZoomSdk(timeoutMs = 5000, intervalMs = 100) {
  if (window.zoomSdk) {
    sdk = window.zoomSdk;
    return Promise.resolve();
  }

  if (sdkLoadPromise) {
    return sdkLoadPromise;
  }

  sdkLoadPromise = new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const sdkScript = document.querySelector('script[src*="appssdk.zoom.us/sdk.js"]');

    const finish = () => {
      if (window.zoomSdk) {
        sdk = window.zoomSdk;
        resolve();
        return true;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Zoom Apps SDK script did not expose window.zoomSdk before timeout.'));
        return true;
      }
      return false;
    };

    if (finish()) {
      return;
    }

    const timer = setInterval(() => {
      if (finish()) {
        clearInterval(timer);
      }
    }, intervalMs);

    if (sdkScript) {
      sdkScript.addEventListener('load', () => {
        if (window.zoomSdk) {
          clearInterval(timer);
          sdk = window.zoomSdk;
          console.log('[DeepfakeDemo:UI] sdk.js loaded', true);
          resolve();
        }
      }, { once: true });
      sdkScript.addEventListener('error', (event) => {
        clearInterval(timer);
        console.error('[DeepfakeDemo:UI] sdk.js failed', event);
        reject(new Error('Zoom Apps SDK script request was blocked or failed.'));
      }, { once: true });
      return;
    }

    clearInterval(timer);
    reject(new Error('Zoom Apps SDK script tag is missing from the page.'));
  });

  return sdkLoadPromise;
}

function applyState(nextState = {}) {
  currentState = nextState;
  const rtmsStatus = nextState.rtmsStatus || 'unknown';
  setStatusChip(elements.rtmsStatus, rtmsStatus, rtmsStatusTone(rtmsStatus));
  elements.streamId.textContent = nextState.streamId || 'none';
  elements.activeSpeaker.textContent = nextState.activeSpeaker ? formatParticipant(nextState.activeSpeaker) : 'none';
  applyRuntimeConfig(nextState.runtimeConfig || appConfig);
  if (Array.isArray(nextState.zoomParticipants)) {
    zoomParticipants = nextState.zoomParticipants;
    renderZoomParticipants(zoomParticipants);
  }
  renderRtmsParticipants(nextState.videoOnParticipants || []);
  renderParticipantStatusList();

  if (nextState.hlsReady && nextState.hlsUrl) {
    setPlayback(nextState.hlsUrl);
  }

  updateControlButtons(nextState.rtmsStatus);
  applyDeepfakeStatus(nextState.deepfakeStatus, nextState.lastDeepfakeResult);
  applyAudioDeepfakeStatus(nextState.audioDeepfakeStatus, nextState.lastAudioDeepfakeResult);
}

async function initZoomSdk() {
  try {
    setStatusChip(elements.zoomSdkStatus, 'loading', 'warning');
    await waitForZoomSdk();
    sdk = window.zoomSdk || sdk;
    sdkReady = true;
    log('Zoom Apps SDK script loaded', { available: !!sdk });

    await sdk.config({
      capabilities: [...BASE_CAPABILITIES, ...OPTIONAL_LAYERS_CAPABILITIES],
      version: '0.16.31'
    });

    setStatusChip(elements.zoomSdkStatus, 'configured', '');
    log('Zoom Apps SDK configured', {
      capabilities: [...BASE_CAPABILITIES, ...OPTIONAL_LAYERS_CAPABILITIES]
    });

    try {
      const response = await sdk.getSupportedJsApis();
      const apiList = normalizeSupportedApis(response);
      supportedApis = new Set(apiList);
      layersApisAvailable = LAYERS_CAPABILITIES.every((capability) => supportedApis.has(capability));
      log('Supported Zoom App APIs', {
        count: supportedApis.size,
        apis: apiList,
        startRTMS: supportedApis.has('startRTMS'),
        stopRTMS: supportedApis.has('stopRTMS'),
        layersApisAvailable
      });
    } catch (error) {
      log('Failed to fetch supported APIs', { message: error.message });
    }

    runningContext = await sdk.getRunningContext().catch(() => null);
    setRunningContextUi(runningContext?.context || null);
    meetingContext = await sdk.getMeetingContext().catch(() => null);
    const appContext = await sdk.getAppContext().catch(() => null);
    log('Zoom App context', {
      runningContext: runningContext?.context || null,
      meetingUUID: meetingContext?.meetingUUID || meetingContext?.meetingID || null,
      appContext: appContext?.context || appContext || null
    });

    await refreshZoomParticipants();

    if (supportedApis.has('onParticipantChange') && typeof sdk.addEventListener === 'function') {
      sdk.addEventListener('onParticipantChange', () => {
        refreshZoomParticipants().catch(() => {});
      });
    }

    if (supportedApis.has('onRTMSStatusChange') && typeof sdk.addEventListener === 'function') {
      sdk.addEventListener('onRTMSStatusChange', (event) => {
        log('Zoom Apps RTMS status changed', event);
      });
    }

    updateControlButtons(currentState.rtmsStatus);
  } catch (error) {
    sdkReady = false;
    setStatusChip(elements.zoomSdkStatus, 'configuration failed', 'warning');
    log('Zoom Apps SDK config failed', { message: error.message });
    updateControlButtons(currentState.rtmsStatus);
  }
}

async function refreshZoomParticipants() {
  if (!sdkReady || !sdk) return;
  try {
    const response = await sdk.getMeetingParticipants();
    zoomParticipants = response.participants || [];
    renderZoomParticipants(zoomParticipants);
    renderParticipantStatusList();
    socket.emit('zoom_participants', {
      meetingId: meetingContext?.meetingUUID || meetingContext?.meetingID,
      participants: zoomParticipants
    });
  } catch (error) {
    log('Failed to load Zoom participants', { message: error.message });
  }
}

async function callRtmsApi(action) {
  if (rtmsControlInFlight) return;

  if (!sdk) {
    log(`Cannot ${action}: Zoom Apps SDK unavailable.`);
    return;
  }

  const apiName = `${action}RTMS`;
  if (runningContext?.context && runningContext.context !== 'inMeeting') {
    log(`Cannot ${apiName}: current running context is ${runningContext.context}, expected inMeeting.`);
    return;
  }

  if (!supportedApis.has(apiName)) {
    log(`${apiName} is not available in this Zoom App context. Check Marketplace capabilities and client support.`);
    return;
  }

  try {
    rtmsControlInFlight = true;
    updateControlButtons(currentState.rtmsStatus);
    log(`Calling Zoom Apps SDK ${apiName}`);

    if (typeof sdk[apiName] === 'function') {
      await sdk[apiName]();
    } else if (typeof sdk.callZoomApi === 'function') {
      await sdk.callZoomApi(apiName);
    } else {
      throw new Error(`Neither sdk.${apiName}() nor callZoomApi('${apiName}') is available.`);
    }

    socket.emit('rtms_control_update', { status: action === 'start' ? 'starting' : 'stopped' });
    log(`${apiName} completed successfully`);
  } catch (error) {
    log(`${apiName} failed`, { message: error.message });
  } finally {
    rtmsControlInFlight = false;
    updateControlButtons(currentState.rtmsStatus);
  }
}

function selectedRtmsUserId() {
  return elements.rtmsParticipantSelect.value;
}

function selectedZoomParticipantUUID() {
  return elements.zoomParticipantSelect?.value || '';
}

function upsertSelectedMapping() {
  const rtmsUserId = currentState.selectedVideoUser?.userId || selectedRtmsUserId();
  const participantUUID = selectedZoomParticipantUUID();
  if (!rtmsUserId || !participantUUID) {
    return;
  }

  socket.emit('set_participant_mapping', { rtmsUserId, participantUUID }, (response) => {
    log('Mapping response', response);
  });
}

function loadIndividualVideo() {
  const userId = selectedRtmsUserId();
  if (!userId) {
    log('Select an RTMS video-on participant before loading individual video.');
    return;
  }

  upsertSelectedMapping();
  socket.emit('select_video_user', {
    streamId: currentState.streamId,
    userId
  }, (response) => {
    log('Load individual video response', response);
  });
}

function startDeepfakeDetection() {
  socket.emit('start_deepfake_detection', {
    streamId: currentState.streamId
  }, (response) => {
    log('Start video verification response', response);
  });
}

function stopDeepfakeDetection() {
  socket.emit('stop_deepfake_detection', {
    streamId: currentState.streamId
  }, (response) => {
    log('Stop video verification response', response);
  });
}

function startAudioDeepfakeDetection() {
  socket.emit('start_audio_deepfake_detection', {
    streamId: currentState.streamId
  }, (response) => {
    log('Start audio verification response', response);
  });
}

function stopAudioDeepfakeDetection() {
  socket.emit('stop_audio_deepfake_detection', {
    streamId: currentState.streamId
  }, (response) => {
    log('Stop audio verification response', response);
  });
}

function makeBadgeImageData({ title, tone }) {
  const canvas = document.createElement('canvas');
  canvas.width = OVERLAY_BADGE_SIZE.width;
  canvas.height = OVERLAY_BADGE_SIZE.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const palette = {
    pending: {
      fill: 'rgba(0, 0, 0, 0)',
      border: 'rgba(0, 0, 0, 0)',
      dot: '#9ca3af',
      title: '#111111',
      text: 'UNVERIFIED'
    },
    verified: {
      fill: 'rgba(0, 0, 0, 0)',
      border: 'rgba(0, 0, 0, 0)',
      dot: '#0f9f6e',
      title: '#111111',
      text: 'VERIFIED'
    },
    warning: {
      fill: 'rgba(0, 0, 0, 0)',
      border: 'rgba(0, 0, 0, 0)',
      dot: '#d35b2b',
      title: '#111111',
      text: 'DEEPFAKE'
    }
  };

  const theme = palette[tone] || palette.pending;

  ctx.beginPath();
  ctx.arc(22, 36, 8, 0, Math.PI * 2);
  ctx.fillStyle = theme.dot;
  ctx.fill();

  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.98)';
  ctx.fillStyle = theme.title;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.font = '900 38px "Segoe UI", Arial, sans-serif';
  ctx.lineWidth = 8;
  const text = theme.text || title;
  ctx.strokeText(text, 40, 49);
  ctx.fillText(text, 40, 49);

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function showVerifiedOverlay() {
  if (!sdk || appConfig.enableLayersOverlay === false) {
    log('Layers overlay is disabled or Zoom Apps SDK is unavailable.');
    return;
  }

  if (!layersApisAvailable) {
    log('Layers APIs are not available. Enable the required Zoom App capabilities in Marketplace.');
    return;
  }

  const rtmsUserId = currentState.selectedVideoUser?.userId || selectedRtmsUserId();
  upsertSelectedMapping();
  const mappedUuid = selectedZoomParticipantUUID() || currentState.participantMappings?.[String(rtmsUserId)];
  if (!mappedUuid) {
    log('No participantUUID mapping available for the selected RTMS user.');
    return;
  }

  try {
    await sdk.runRenderingContext({ view: 'immersive', defaultCutout: 'rectangle' });
    runningContext = { ...(runningContext || {}), context: 'inImmersive' };
    setRunningContextUi('inImmersive');
    await sdk.drawParticipant({
      participantUUID: mappedUuid,
      x: IMMERSIVE_PARTICIPANT_FRAME.x,
      y: IMMERSIVE_PARTICIPANT_FRAME.y,
      width: IMMERSIVE_PARTICIPANT_FRAME.width,
      height: IMMERSIVE_PARTICIPANT_FRAME.height,
      zIndex: 1,
      cutout: 'rectangle'
    });

    if (renderedBadgeImageId) {
      await sdk.clearImage({ imageId: renderedBadgeImageId }).catch(() => {});
    }

    let badgeTone = 'pending';
    let badgeTitle = 'UNVERIFIED';
    if (currentState.deepfakeStatus === 'running') {
      badgeTitle = 'ANALYZING';
    } else if (currentState.lastDeepfakeResult?.verified === true) {
      badgeTone = 'verified';
      badgeTitle = 'VERIFIED';
    } else if (currentState.deepfakeStatus === 'deepfake') {
      badgeTone = 'warning';
      badgeTitle = 'DEEPFAKE';
    }
    setOverlaySurfaceStatus(badgeTitle, badgeTone);
    renderedBadgeImageId = null;
    overlayActive = true;
    updateControlButtons(currentState.rtmsStatus);
  } catch (error) {
    log('Failed to draw Layers overlay', { message: error.message });
  }
}

async function closeOverlay() {
  if (!sdk || !layersApisAvailable) {
    log('Layers overlay is unavailable.');
    return;
  }

  try {
    const imageIdToClear = renderedBadgeImageId;

    // Restore the sidebar UI immediately so the page does not stay hidden
    // while Zoom transitions out of the rendering context.
    renderedBadgeImageId = null;
    overlayActive = false;
    runningContext = { ...(runningContext || {}), context: 'inMeeting' };
    setRunningContextUi('inMeeting');
    updateControlButtons(currentState.rtmsStatus);

    if (imageIdToClear && supportedApis.has('clearImage') && typeof sdk.clearImage === 'function') {
      await sdk.clearImage({ imageId: imageIdToClear }).catch(() => {});
    }

    if (supportedApis.has('closeRenderingContext') && typeof sdk.closeRenderingContext === 'function') {
      await sdk.closeRenderingContext();
    }
    log('Closed verification overlay');
  } catch (error) {
    log('Failed to close verification overlay', { message: error.message });
  }
}

elements.startRtmsButton.addEventListener('click', () => {
  log('Start RTMS button clicked', {
    disabled: elements.startRtmsButton.disabled,
    sdkReady,
    supported: supportedApis.has('startRTMS'),
    runningContext: runningContext?.context || null
  });
  callRtmsApi('start');
});
elements.stopRtmsButton.addEventListener('click', () => {
  log('Stop RTMS button clicked', {
    disabled: elements.stopRtmsButton.disabled,
    sdkReady,
    supported: supportedApis.has('stopRTMS'),
    runningContext: runningContext?.context || null
  });
  callRtmsApi('stop');
});
elements.loadVideoButton.addEventListener('click', loadIndividualVideo);
elements.startDetectionButton.addEventListener('click', startDeepfakeDetection);
elements.stopDetectionButton.addEventListener('click', stopDeepfakeDetection);
elements.startAudioDetectionButton?.addEventListener('click', startAudioDeepfakeDetection);
elements.stopAudioDetectionButton?.addEventListener('click', stopAudioDeepfakeDetection);
elements.overlayButton?.addEventListener('click', showVerifiedOverlay);
elements.closeOverlayButton?.addEventListener('click', closeOverlay);
elements.layersCloseOverlayButton?.addEventListener('click', closeOverlay);
elements.rtmsParticipantSelect.addEventListener('change', () => updateControlButtons(currentState.rtmsStatus));
elements.zoomParticipantSelect?.addEventListener('change', () => {
  upsertSelectedMapping();
  updateControlButtons(currentState.rtmsStatus);
  renderParticipantStatusList();
});

socket.on('connect', () => log('Socket.IO connected'));
socket.on('state', applyState);
socket.on('backend_log', ({ message, data }) => log(message, data));
socket.on('hls_ready', ({ playlistUrl }) => setPlayback(playlistUrl));
socket.on('deepfake_result', (result) => {
  const status = result?.status || (result?.verified === true ? 'verified' : result?.deepfake === true ? 'deepfake' : currentState.deepfakeStatus);
  currentState = {
    ...currentState,
    lastDeepfakeResult: result,
    deepfakeStatus: status
  };
  updateVerdict(result);
});
socket.on('deepfake_error', (error) => {
  currentState = { ...currentState, deepfakeStatus: 'error' };
  renderParticipantStatusList();
  log('Deepfake error', error);
});
socket.on('audio_deepfake_result', (result) => {
  const status = result?.status || (result?.verified === true ? 'verified' : result?.deepfake === true ? 'deepfake' : currentState.audioDeepfakeStatus);
  currentState = {
    ...currentState,
    lastAudioDeepfakeResult: result,
    audioDeepfakeStatus: status
  };
  updateAudioVerdict(result);
});
socket.on('audio_deepfake_error', (error) => {
  currentState = { ...currentState, audioDeepfakeStatus: 'error' };
  applyAudioDeepfakeStatus('error', null);
  renderParticipantStatusList();
  log('Audio deepfake error', error);
});
socket.on('video_subscription_response', (message) => {
  log('Video subscription response', message);
  if (message?.success) {
    elements.playbackStatus.textContent = `Subscribed to individual video user ${message.userId}. Waiting for video packets...`;
  } else {
    elements.playbackStatus.textContent = `Individual video subscription failed: ${message?.reason || message?.statusCode || 'unknown error'}`;
  }
});
socket.on('active_speaker', ({ activeSpeaker }) => {
  elements.activeSpeaker.textContent = activeSpeaker ? formatParticipant(activeSpeaker) : 'none';
});

document.addEventListener('DOMContentLoaded', initZoomSdk);
log('Frontend script loaded');
updateControlButtons(currentState.rtmsStatus);
