const socket = io({
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 15000
});
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

const elements = {
  startRtmsButton: document.getElementById('startRtmsButton'),
  stopRtmsButton: document.getElementById('stopRtmsButton'),
  loadVideoButton: document.getElementById('loadVideoButton'),
  startDetectionButton: document.getElementById('startDetectionButton'),
  stopDetectionButton: document.getElementById('stopDetectionButton'),
  startAudioDetectionButton: document.getElementById('startAudioDetectionButton'),
  stopAudioDetectionButton: document.getElementById('stopAudioDetectionButton'),
  zoomSdkStatus: document.getElementById('zoomSdkStatus'),
  socketStatus: document.getElementById('socketStatus'),
  rtmsStatus: document.getElementById('rtmsStatus'),
  streamId: document.getElementById('streamId'),
  activeSpeaker: document.getElementById('activeSpeaker'),
  rtmsParticipantSelect: document.getElementById('rtmsParticipantSelect'),
  zoomParticipantSelect: document.getElementById('zoomParticipantSelect'),
  participantStatusList: document.getElementById('participantStatusList'),
  participantCount: document.getElementById('participantCount'),
  videoPlayer: document.getElementById('videoPlayer'),
  playbackStatus: document.getElementById('playbackStatus'),
  combinedVerdictBadge: document.getElementById('combinedVerdictBadge'),
  combinedConfidenceScore: document.getElementById('combinedConfidenceScore'),
  videoHistoryBars: document.getElementById('videoHistoryBars'),
  audioHistoryBars: document.getElementById('audioHistoryBars'),
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
let registrationIdentity = { meetingUUID: null, userID: null };
let socketRegistered = false;
let registrationRetryTimer = null;
let rtmsControlInFlight = false;
let supportedApis = new Set();
let sdkReady = false;
let sdkLoadPromise = null;
let currentPlaybackUrl = null;

applyRuntimeConfig(appConfig);

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

function setStatusChip(element, value, tone = 'muted') {
  if (!element) return;
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

function scheduleRegistrationRetry() {
  if (registrationRetryTimer || !registrationIdentity.meetingUUID) return;
  registrationRetryTimer = setTimeout(() => {
    registrationRetryTimer = null;
    registerSocketRoom();
  }, 3000);
}

function registerSocketRoom() {
  if (!socket.connected || !registrationIdentity.meetingUUID || !registrationIdentity.userID) return;
  setStatusChip(elements.socketStatus, 'registering', 'warning');
  socket.emit(
    'register',
    {
      meetingUUID: registrationIdentity.meetingUUID,
      userID: registrationIdentity.userID,
      token: appConfig.wsAuthToken || undefined
    },
    (response) => {
      if (response?.ok) {
        socketRegistered = true;
        setStatusChip(elements.socketStatus, 'registered', '');
        log('Registered in meeting room', { meetingId: response.meetingId, reason: response.reason });
        if (zoomParticipants.length > 0) {
          socket.emit('zoom_participants', { participants: zoomParticipants });
        }
      } else {
        socketRegistered = false;
        setStatusChip(elements.socketStatus, 'waiting for RTMS', 'warning');
        log('Room registration deferred', { error: response?.error || 'unauthorized' });
        scheduleRegistrationRetry();
      }
    }
  );
}

function renderRtmsParticipants(participants = []) {
  const selectedValue = elements.rtmsParticipantSelect.value;
  elements.rtmsParticipantSelect.replaceChildren();

  if (participants.length === 0) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'Waiting for PARTICIPANT_VIDEO_ON...';
    elements.rtmsParticipantSelect.appendChild(emptyOpt);
    return;
  }

  for (const participant of participants) {
    const option = document.createElement('option');
    option.value = String(participant.userId);
    option.textContent = formatParticipant(participant);
    elements.rtmsParticipantSelect.appendChild(option);
  }

  if (selectedValue && participants.some((p) => String(p.userId) === selectedValue)) {
    elements.rtmsParticipantSelect.value = selectedValue;
  } else if (currentState.selectedVideoUser?.userId != null) {
    const sel = String(currentState.selectedVideoUser.userId);
    if (participants.some((p) => String(p.userId) === sel)) {
      elements.rtmsParticipantSelect.value = sel;
    }
  }
}

function renderZoomParticipants(participants = []) {
  const selectedValue = elements.zoomParticipantSelect.value;
  elements.zoomParticipantSelect.replaceChildren();

  if (participants.length === 0) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'No Zoom participants loaded';
    elements.zoomParticipantSelect.appendChild(emptyOpt);
    return;
  }

  for (const participant of participants) {
    const option = document.createElement('option');
    option.value = String(participantIdentity(participant) || participantName(participant));
    option.textContent = participantName(participant);
    elements.zoomParticipantSelect.appendChild(option);
  }

  if (selectedValue && participants.some((p) => String(participantIdentity(p) || participantName(p)) === selectedValue)) {
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
  if (normalized === 'running' || normalized === 'analyzing' || normalized === 'partial') return { label: normalized === 'partial' ? 'Partial' : 'Analyzing', tone: 'running' };
  if (normalized === 'error') return { label: 'Error', tone: 'warning' };
  if (normalized === 'unverified') return { label: 'Unverified', tone: 'pending' };
  return { label: 'Not checked', tone: 'muted' };
}

function getVerificationForRtmsParticipant(rtmsParticipant) {
  if (rtmsParticipant?.userId == null) return null;
  const key = String(rtmsParticipant.userId);
  return currentState.participantVerification?.[key] || null;
}

function formatScorePair(label, verification = {}) {
  if (verification?.realScore == null || verification?.fakeScore == null) return '';
  return `${label} Real ${Number(verification.realScore).toFixed(2)} / Fake ${Number(verification.fakeScore).toFixed(2)}`;
}

function selectParticipantById(userId, zoomUuid = null) {
  if (!userId || !currentState.streamId) return;
  elements.rtmsParticipantSelect.value = String(userId);
  if (zoomUuid && elements.zoomParticipantSelect) {
    elements.zoomParticipantSelect.value = String(zoomUuid);
    socket.emit('set_participant_mapping', { rtmsUserId: userId, participantUUID: zoomUuid });
  }
  socket.emit('select_video_user', { userId }, (response) => {
    log('Select participant response', response);
  });
}

function renderParticipantStatusList() {
  if (!elements.participantStatusList) return;

  const sourceParticipants = zoomParticipants.length > 0
    ? zoomParticipants
    : (currentState.zoomParticipants || []);
  const fallbackParticipants = sourceParticipants.length > 0
    ? sourceParticipants
    : (currentState.videoOnParticipants || []);

  elements.participantStatusList.replaceChildren();
  if (elements.participantCount) {
    elements.participantCount.textContent = `${fallbackParticipants.length} loaded`;
  }

  if (fallbackParticipants.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'participant-empty';
    empty.textContent = 'No participants loaded yet. Open this inside Zoom and start RTMS.';
    elements.participantStatusList.appendChild(empty);
    return;
  }

  const videoOnSet = new Set((currentState.videoOnParticipants || []).map((p) => String(p.userId)));

  for (const participant of fallbackParticipants) {
    const rtmsParticipant = findRtmsParticipantForZoomParticipant(participant) || (
      participant.userId != null ? participant : null
    );
    const verification = getVerificationForRtmsParticipant(rtmsParticipant);
    const videoStatus = participantStatusDetails(verification?.video?.status || (rtmsParticipant ? 'unverified' : 'not_checked'));
    const audioStatus = participantStatusDetails(verification?.audio?.status || (rtmsParticipant ? 'unverified' : 'not_checked'));
    const combinedStatus = participantStatusDetails(verification?.combined?.status || 'not_checked');
    const isSelected = rtmsParticipant?.userId != null
      && String(currentState.selectedVideoUser?.userId ?? '') === String(rtmsParticipant.userId);
    const isVideoOn = rtmsParticipant?.userId != null && videoOnSet.has(String(rtmsParticipant.userId));
    const canSelect = Boolean(currentState.streamId && rtmsParticipant?.userId != null && isVideoOn);

    const row = document.createElement('div');
    row.className = `participant-status-row${isSelected ? ' selected' : ''}${canSelect ? ' clickable' : ''}`;
    if (canSelect) {
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      const zoomUuid = participant.participantUUID || participant.participantUuid || null;
      row.addEventListener('click', () => selectParticipantById(rtmsParticipant.userId, zoomUuid));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectParticipantById(rtmsParticipant.userId, zoomUuid);
        }
      });
    }

    const mainDiv = document.createElement('div');
    mainDiv.className = 'participant-status-main';
    const nameEl = document.createElement('strong');
    nameEl.textContent = participantName(participant);

    const metaEl = document.createElement('span');
    metaEl.textContent = [
      rtmsParticipant?.userId != null ? `RTMS ${rtmsParticipant.userId}` : 'Zoom participant',
      isSelected ? 'selected stream' : (canSelect ? 'click to inspect' : null),
      formatScorePair('V', verification?.video) || null,
      formatScorePair('A', verification?.audio) || null
    ].filter(Boolean).join(' · ');

    mainDiv.append(nameEl, metaEl);

    const chipStack = document.createElement('div');
    chipStack.className = 'participant-chip-stack';

    const combinedChip = document.createElement('span');
    combinedChip.className = `participant-verification-chip combined ${combinedStatus.tone}`;
    combinedChip.textContent = `Trust: ${combinedStatus.label}`;

    const videoChip = document.createElement('span');
    videoChip.className = `participant-verification-chip video ${videoStatus.tone}`;
    videoChip.textContent = `Video: ${videoStatus.label}`;

    const audioChip = document.createElement('span');
    audioChip.className = `participant-verification-chip audio ${audioStatus.tone}`;
    audioChip.textContent = `Audio: ${audioStatus.label}`;

    chipStack.append(combinedChip, videoChip, audioChip);
    row.append(mainDiv, chipStack);
    elements.participantStatusList.appendChild(row);
  }
}

function resetPlayback(statusText = 'Waiting for HLS stream...') {
  currentPlaybackUrl = null;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (elements.videoPlayer) {
    elements.videoPlayer.pause();
    elements.videoPlayer.removeAttribute('src');
    elements.videoPlayer.load();
  }
  if (elements.playbackStatus) {
    elements.playbackStatus.textContent = statusText;
  }
}

function setPlayback(hlsUrl) {
  if (!hlsUrl) return;
  if (currentPlaybackUrl === hlsUrl) return;
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
        return;
      }
      if (!data?.fatal && data?.details === 'bufferStalledError') {
        elements.playbackStatus.textContent = 'HLS waiting for the next segment...';
        elements.videoPlayer.play().catch(() => {});
        return;
      }

      const details = [data?.type, data?.details, data?.fatal ? 'fatal' : null].filter(Boolean).join(' / ');
      elements.playbackStatus.textContent = `HLS warning: ${details || 'unknown error'}`;
      log('HLS playback error', data);

      if (!data?.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }

      resetPlayback('HLS playback stopped after fatal error.');
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

function renderConfidenceBars(container, entries = []) {
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(entries) || entries.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'history-empty';
    empty.textContent = 'No readings yet';
    container.appendChild(empty);
    return;
  }

  for (const item of entries) {
    const pct = Math.round(Math.max(0, Math.min(1, Number(item.realScore) || 0)) * 100);
    const bar = document.createElement('span');
    bar.className = `history-bar ${item.status === 'verified' ? 'verified' : item.status === 'deepfake' ? 'warning' : 'pending'}`;
    bar.style.height = `${Math.max(18, pct)}%`;
    bar.title = `Real ${pct}% (${item.status})`;
    container.appendChild(bar);
  }
}

function renderCombinedVerdict(combinedVerdict, history) {
  const verdict = combinedVerdict || { status: 'unverified', tone: 'pending', label: 'Unverified', combinedRealScore: null };
  if (elements.combinedVerdictBadge) {
    const badgeClass = verdict.tone === 'verified' ? 'verified' : verdict.tone === 'warning' ? 'warning' : 'pending';
    elements.combinedVerdictBadge.className = `verdict-badge ${badgeClass}`;
    elements.combinedVerdictBadge.textContent = verdict.label;
  }
  if (elements.combinedConfidenceScore) {
    elements.combinedConfidenceScore.textContent = verdict.combinedRealScore == null
      ? 'Confidence: n/a'
      : `Avg real score: ${(verdict.combinedRealScore * 100).toFixed(1)}%`;
  }
  renderConfidenceBars(elements.videoHistoryBars, history?.video || []);
  renderConfidenceBars(elements.audioHistoryBars, history?.audio || []);
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
  elements.clipName.textContent = result.clip?.name || 'n/a';
  elements.processingTime.textContent = result.processingMs == null ? 'n/a' : `${Math.round(result.processingMs)} ms`;
  elements.realScore.textContent = result.realScore == null ? 'n/a' : result.realScore.toFixed(3);
  elements.fakeScore.textContent = result.fakeScore == null ? 'n/a' : result.fakeScore.toFixed(3);
  renderParticipantStatusList();
}

function updateAudioVerdict(result) {
  if (!elements.audioVerdictBadge) return;

  if (!result || result.skipped) {
    elements.audioVerdictBadge.className = 'verdict-badge pending';
    elements.audioVerdictBadge.textContent = result?.reason || 'Audio unverified';
    elements.audioClipName.textContent = result?.clip?.name || 'n/a';
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
  elements.audioClipName.textContent = result.clip?.name || 'n/a';
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
    return;
  }
  if (status === 'unverified' || status === 'stopped' || !status) {
    updateVerdict(null);
    return;
  }
  if (status === 'error') {
    elements.verdictBadge.className = 'verdict-badge warning';
    elements.verdictBadge.textContent = 'Video analysis error';
    return;
  }
  updateVerdict(result);
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
  elements.loadVideoButton.disabled = !socketRegistered || !currentState.streamId || !selectedRtmsUserId();
  elements.startDetectionButton.disabled = !socketRegistered || !currentState.streamId || !currentState.selectedVideoUser || currentState.deepfakeDetectionEnabled;
  elements.stopDetectionButton.disabled = !currentState.deepfakeDetectionEnabled;
  if (elements.startAudioDetectionButton) {
    elements.startAudioDetectionButton.disabled = !socketRegistered || !currentState.streamId || !currentState.selectedVideoUser || currentState.audioDeepfakeDetectionEnabled;
  }
  if (elements.stopAudioDetectionButton) {
    elements.stopAudioDetectionButton.disabled = !currentState.audioDeepfakeDetectionEnabled;
  }
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
  if (sdkLoadPromise) return sdkLoadPromise;

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

    if (finish()) return;

    const timer = setInterval(() => {
      if (finish()) clearInterval(timer);
    }, intervalMs);

    if (sdkScript) {
      sdkScript.addEventListener('load', () => {
        if (window.zoomSdk) {
          clearInterval(timer);
          sdk = window.zoomSdk;
          resolve();
        }
      }, { once: true });
      sdkScript.addEventListener('error', () => {
        clearInterval(timer);
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
  const rtmsStatus = nextState.rtmsStatus || 'stopped';
  setStatusChip(elements.rtmsStatus, rtmsStatus, rtmsStatusTone(rtmsStatus));
  elements.streamId.textContent = nextState.streamId || 'none';
  elements.activeSpeaker.textContent = nextState.activeSpeaker ? formatParticipant(nextState.activeSpeaker) : 'none';
  applyRuntimeConfig(nextState.runtimeConfig || appConfig);
  if (Array.isArray(nextState.zoomParticipants) && nextState.zoomParticipants.length > 0) {
    zoomParticipants = nextState.zoomParticipants;
    renderZoomParticipants(zoomParticipants);
  }
  renderRtmsParticipants(nextState.videoOnParticipants || []);
  renderParticipantStatusList();

  if (rtmsStatus === 'stopped' || !nextState.hlsReady || !nextState.hlsUrl) {
    if (currentPlaybackUrl !== null) {
      resetPlayback(rtmsStatus === 'stopped' ? 'RTMS stopped. Start RTMS and select a participant.' : 'Waiting for HLS stream...');
    }
  } else {
    setPlayback(nextState.hlsUrl);
  }

  updateControlButtons(rtmsStatus);
  applyDeepfakeStatus(nextState.deepfakeStatus, nextState.lastDeepfakeResult);
  applyAudioDeepfakeStatus(nextState.audioDeepfakeStatus, nextState.lastAudioDeepfakeResult);
  renderCombinedVerdict(nextState.combinedVerdict, nextState.selectedConfidenceHistory);
}

async function initZoomSdk() {
  try {
    setStatusChip(elements.zoomSdkStatus, 'loading', 'warning');
    await waitForZoomSdk();
    sdk = window.zoomSdk || sdk;
    sdkReady = true;

    await sdk.config({
      capabilities: [...BASE_CAPABILITIES],
      version: '0.16.31'
    });

    setStatusChip(elements.zoomSdkStatus, 'configured', '');
    log('Zoom Apps SDK configured');

    try {
      const response = await sdk.getSupportedJsApis();
      supportedApis = new Set(normalizeSupportedApis(response));
    } catch (error) {
      log('Failed to fetch supported APIs', { message: error.message });
    }

    runningContext = await sdk.getRunningContext().catch(() => null);
    meetingContext = await sdk.getMeetingContext().catch(() => null);
    const meetingUuidRes = await sdk.getMeetingUUID().catch(() => null);
    const userContext = await sdk.getUserContext().catch(() => null);

    const meetingUUID = meetingUuidRes?.meetingUUID || meetingContext?.meetingUUID || meetingContext?.meetingID || null;
    const userID = userContext?.participantUUID || userContext?.participantId || userContext?.screenName || 'zoom-app-user';
    if (meetingUUID) {
      registrationIdentity = { meetingUUID, userID };
      registerSocketRoom();
    }

    await refreshZoomParticipants();

    if (supportedApis.has('onParticipantChange') && typeof sdk.addEventListener === 'function') {
      sdk.addEventListener('onParticipantChange', () => {
        refreshZoomParticipants().catch(() => {});
      });
    }

    if (supportedApis.has('onRTMSStatusChange') && typeof sdk.addEventListener === 'function') {
      sdk.addEventListener('onRTMSStatusChange', (event) => {
        log('Zoom Apps RTMS status changed', event);
        if (!socketRegistered && registrationIdentity.meetingUUID) {
          registerSocketRoom();
        }
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
    if (socketRegistered) {
      socket.emit('zoom_participants', { participants: zoomParticipants });
    }
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

    if (socketRegistered) {
      socket.emit('rtms_control_update', { status: action === 'start' ? 'starting' : 'stopped' });
    } else if (action === 'start') {
      // Retry room registration shortly after webhook arrives.
      setTimeout(() => registerSocketRoom(), 1500);
    }
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
  if (!rtmsUserId || !participantUUID || !socketRegistered) return;
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
  socket.emit('select_video_user', { userId }, (response) => {
    log('Load individual video response', response);
  });
}

function startDeepfakeDetection() {
  socket.emit('start_deepfake_detection', {}, (response) => {
    log('Start video verification response', response);
  });
}

function stopDeepfakeDetection() {
  socket.emit('stop_deepfake_detection', {}, (response) => {
    log('Stop video verification response', response);
  });
}

function startAudioDeepfakeDetection() {
  socket.emit('start_audio_deepfake_detection', {}, (response) => {
    log('Start audio verification response', response);
  });
}

function stopAudioDeepfakeDetection() {
  socket.emit('stop_audio_deepfake_detection', {}, (response) => {
    log('Stop audio verification response', response);
  });
}

elements.startRtmsButton.addEventListener('click', () => callRtmsApi('start'));
elements.stopRtmsButton.addEventListener('click', () => callRtmsApi('stop'));
elements.loadVideoButton.addEventListener('click', loadIndividualVideo);
elements.startDetectionButton.addEventListener('click', startDeepfakeDetection);
elements.stopDetectionButton.addEventListener('click', stopDeepfakeDetection);
elements.startAudioDetectionButton?.addEventListener('click', startAudioDeepfakeDetection);
elements.stopAudioDetectionButton?.addEventListener('click', stopAudioDeepfakeDetection);
elements.rtmsParticipantSelect.addEventListener('change', () => updateControlButtons(currentState.rtmsStatus));
elements.zoomParticipantSelect?.addEventListener('change', () => {
  upsertSelectedMapping();
  updateControlButtons(currentState.rtmsStatus);
  renderParticipantStatusList();
});

socket.on('connect', () => {
  setStatusChip(elements.socketStatus, 'connected', 'warning');
  log('Socket.IO connected');
  registerSocketRoom();
});

socket.on('disconnect', () => {
  socketRegistered = false;
  setStatusChip(elements.socketStatus, 'reconnecting', 'warning');
  log('Socket.IO disconnected; reconnecting...');
});

socket.on('state', applyState);
socket.on('backend_log', ({ message, data }) => log(message, data));
socket.on('hls_ready', ({ playlistUrl }) => setPlayback(playlistUrl));
socket.on('hls_reset', () => {
  resetPlayback('HLS pipeline reset; waiting for next keyframe...');
});
socket.on('deepfake_result', (result) => {
  const status = result?.status || (result?.verified === true ? 'verified' : result?.deepfake === true ? 'deepfake' : currentState.deepfakeStatus);
  currentState = { ...currentState, lastDeepfakeResult: result, deepfakeStatus: status };
  updateVerdict(result);
});
socket.on('deepfake_error', (error) => {
  currentState = { ...currentState, deepfakeStatus: 'error' };
  applyDeepfakeStatus('error', null);
  renderParticipantStatusList();
  log('Deepfake error', error);
});
socket.on('audio_deepfake_result', (result) => {
  const status = result?.status || (result?.verified === true ? 'verified' : result?.deepfake === true ? 'deepfake' : currentState.audioDeepfakeStatus);
  currentState = { ...currentState, lastAudioDeepfakeResult: result, audioDeepfakeStatus: status };
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
