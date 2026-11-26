class RealtimeAudioClient {
  constructor(serverUrl, options = {}) {
    this.serverUrl = serverUrl;
    this.authToken = options.authToken || '';
    this.ws = null;
    this.audioContext = null;
    this.gainNode = null;
    this.isMuted = false;
    this.speakerSafeMode = false;
    this.isConnected = false;
    this.isRegistered = false;
    this.registrationPayload = null;
    this.shouldReconnect = true;

    // Gapless Web Audio scheduling state
    this.jitterBufferSec = 0.06; // ~60ms jitter buffer
    this.nextPlayTime = 0;
    this.scheduledSources = new Set();
    this.turnActive = false;
    this.turnAudioStartTime = 0;
    this.receivedAudioDone = false;
    this.lastAudioDoneMetadata = {};
    this.playedMsByItem = new Map();
    this.maxTrackedItems = 50;

    // Word-synced caption timeline state
    this.captionWords = [];
    this.captionRafId = null;

    // Reconnection state (exponential backoff with cap)
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatInterval = null;
    this.heartbeatIntervalMs = 30000;

    this.onConnected = () => {};
    this.onRegistered = () => {};
    this.onDisconnected = () => {};
    this.onStatus = () => {};
    this.onTranscript = () => {};
    this.onTextDelta = () => {};
    this.onTextDone = () => {};
    this.onAudioStart = () => {};
    this.onAudioDone = () => {};
    this.onAudioTimestamp = () => {};
    this.onCaptionWordActive = () => {};
    this.onInterrupted = () => {};
    this.onError = () => {};
  }

  setRegistration(meetingUUID, userID, token = null) {
    this.registrationPayload = {
      meetingUUID: String(meetingUUID || ''),
      userID: String(userID || ''),
      token: token !== null ? token : this.authToken,
    };
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.registrationPayload.meetingUUID && this.registrationPayload.userID) {
      this.send({
        type: 'register',
        meetingUUID: this.registrationPayload.meetingUUID,
        userID: this.registrationPayload.userID,
        token: this.registrationPayload.token,
      });
    }
  }

  connect() {
    this.shouldReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) {
      try {
        this.ws.close(1000, 'reconnecting');
      } catch {
        // Ignore close errors
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.serverUrl);
      this.ws = ws;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);

      ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        if (this.registrationPayload?.meetingUUID && this.registrationPayload?.userID) {
          this.sendSafe({
            type: 'register',
            meetingUUID: this.registrationPayload.meetingUUID,
            userID: this.registrationPayload.userID,
            token: this.registrationPayload.token,
          });
        }
        this.onConnected();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      };

      ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          await this.handleServerMessage(message);
        } catch (error) {
          this.onError(error.message || String(error));
        }
      };

      ws.onerror = () => {
        const connectionError = new Error(`Frontend WebSocket connection failed: ${this.serverUrl}`);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(connectionError);
        } else {
          this.onError(connectionError.message);
        }
      };

      ws.onclose = (event) => {
        clearTimeout(timeout);
        this.isConnected = false;
        this.isRegistered = false;
        this.stopHeartbeat();
        this.interrupt(false);
        this.onDisconnected(event.code, event.reason);
        if (this.shouldReconnect && event.code !== 1000 && event.code !== 1001) {
          this.scheduleReconnect();
        }
      };
    });
  }

  async handleServerMessage(message) {
    switch (message.type) {
      case 'ping':
        this.sendSafe({ type: 'pong' });
        break;
      case 'connected':
        if (this.registrationPayload?.meetingUUID && this.registrationPayload?.userID) {
          this.sendSafe({
            type: 'register',
            meetingUUID: this.registrationPayload.meetingUUID,
            userID: this.registrationPayload.userID,
            token: this.registrationPayload.token,
          });
        }
        break;
      case 'registration_success':
        this.isRegistered = true;
        if (this.speakerSafeMode) {
          this.sendSafe({ type: 'speaker_safe_mode', data: { enabled: true } });
        }
        this.onRegistered(message);
        break;
      case 'status':
        this.onStatus(message.data || '');
        break;
      case 'transcript':
        this.onTranscript(message.data || '', message.metadata || {});
        break;
      case 'text':
        this.onTextDelta(message.data || '', message.metadata || {});
        break;
      case 'text_done':
        this.onTextDone(message.data || '', message.metadata || {});
        break;
      case 'audio':
        await this.enqueueAudio(message.data, message.metadata || {});
        break;
      case 'audio_done':
        this.receivedAudioDone = true;
        this.lastAudioDoneMetadata = message.metadata || {};
        this.finishAudioIfIdle();
        break;
      case 'audio_timestamp':
        this.handleAudioTimestamp(message.data || {}, message.metadata || {});
        break;
      case 'interrupt':
        this.interrupt(true, {
          skipCancel: message.data === 'speech_started',
          autoTruncate: message.metadata?.autoTruncate === true,
        });
        this.onInterrupted(message.data || 'interrupted', message.metadata || {});
        break;
      case 'error':
        this.onError(message.data || message.message || 'Server error');
        break;
      default:
        break;
    }
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  sendSafe(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  setMuted(muted) {
    this.isMuted = Boolean(muted);
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setValueAtTime(this.isMuted ? 0 : 1, this.audioContext.currentTime);
    }
    return this.isMuted;
  }

  setSpeakerSafeMode(enabled) {
    this.speakerSafeMode = Boolean(enabled);
    if (this.isRegistered) {
      this.sendSafe({ type: 'speaker_safe_mode', data: { enabled: this.speakerSafeMode } });
    }
    return this.speakerSafeMode;
  }

  async ensureAudioContext(sampleRate = 24000) {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate });
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.isMuted ? 0 : 1;
      this.gainNode.connect(this.audioContext.destination);
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  async enablePlayback(sampleRate = 24000) {
    await this.ensureAudioContext(sampleRate);
    return this.audioContext?.state || 'unknown';
  }

  getAudioState() {
    return this.audioContext?.state || 'uninitialized';
  }

  async enqueueAudio(base64Audio, metadata = {}) {
    if (!base64Audio) return;

    const sampleRate = metadata.sampleRate || 24000;
    await this.ensureAudioContext(sampleRate);

    const arrayBuffer = this.base64ToArrayBuffer(base64Audio);
    const int16Array = new Int16Array(arrayBuffer);
    if (int16Array.length === 0) return;

    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i += 1) {
      float32Array[i] = int16Array[i] / 32768;
    }

    const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32Array);

    const now = this.audioContext.currentTime;
    const isNewTurn = !this.turnActive;

    // Gapless scheduling with ~60ms jitter buffer on initial turn start / underrun
    if (this.nextPlayTime < now + 0.005) {
      this.nextPlayTime = now + this.jitterBufferSec;
    }

    const startTime = this.nextPlayTime;
    const durationSec = audioBuffer.duration;
    const endTime = startTime + durationSec;
    this.nextPlayTime = endTime;

    if (isNewTurn) {
      this.turnActive = true;
      this.receivedAudioDone = false;
      this.turnAudioStartTime = startTime;
      this.captionWords = [];
      this.startCaptionSyncLoop();
      this.sendSafe({ type: 'playback_state', data: { playing: true } });
      this.onAudioStart(metadata);
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode || this.audioContext.destination);

    const entry = {
      source,
      startTime,
      endTime,
      durationMs: durationSec * 1000,
      metadata,
    };
    this.scheduledSources.add(entry);

    source.onended = () => {
      this.scheduledSources.delete(entry);
      this.addCompletedChunkPlayback(entry);
      this.finishAudioIfIdle();
    };

    source.start(startTime);
  }

  handleAudioTimestamp(data, metadata) {
    const wordEntry = {
      text: data.text || '',
      audioOffsetMs: Number(data.audioOffsetMs || 0),
      audioDurationMs: Number(data.audioDurationMs || 0),
      activated: false,
      metadata,
    };
    this.captionWords.push(wordEntry);
    this.onAudioTimestamp(wordEntry, metadata);
  }

  startCaptionSyncLoop() {
    this.stopCaptionSyncLoop();
    const tick = () => {
      if (!this.turnActive || !this.audioContext) {
        this.captionRafId = null;
        return;
      }

      const elapsedMs = Math.max(0, (this.audioContext.currentTime - this.turnAudioStartTime) * 1000);
      let activeIndex = -1;
      for (let i = 0; i < this.captionWords.length; i += 1) {
        if (this.captionWords[i].audioOffsetMs <= elapsedMs) {
          activeIndex = i;
        }
      }
      if (activeIndex >= 0) {
        this.onCaptionWordActive(activeIndex, this.captionWords);
      }

      this.captionRafId = requestAnimationFrame(tick);
    };
    this.captionRafId = requestAnimationFrame(tick);
  }

  stopCaptionSyncLoop() {
    if (this.captionRafId !== null) {
      cancelAnimationFrame(this.captionRafId);
      this.captionRafId = null;
    }
  }

  interrupt(reportToServer = true, options = {}) {
    const interruption = this.currentPlaybackPosition();

    for (const entry of this.scheduledSources) {
      try {
        entry.source.onended = null;
        entry.source.stop();
        entry.source.disconnect();
      } catch {
        // Ignore already-stopped sources
      }
    }
    this.scheduledSources.clear();

    const wasTurnActive = this.turnActive;
    this.turnActive = false;
    this.receivedAudioDone = false;
    this.nextPlayTime = 0;
    this.stopCaptionSyncLoop();

    if (wasTurnActive) {
      this.sendSafe({ type: 'playback_state', data: { playing: false } });
    }

    // Safe WS readyState check & avoid duplicate truncate when auto_truncate handles server-VAD barge-in
    const skipBecauseAutoTruncate = options.autoTruncate === true && options.skipCancel === true;
    if (reportToServer && !skipBecauseAutoTruncate && interruption?.itemId) {
      this.sendSafe({
        type: 'playback_interrupted',
        data: {
          ...interruption,
          skipCancel: options.skipCancel === true,
        },
      });
    }
  }

  currentPlaybackPosition() {
    if (this.scheduledSources.size === 0 || !this.audioContext) {
      return null;
    }

    const now = this.audioContext.currentTime;
    let activeEntry = null;

    for (const entry of this.scheduledSources) {
      if (!entry.metadata?.itemId) continue;
      if (now >= entry.startTime && now <= entry.endTime) {
        activeEntry = entry;
        break;
      }
      if (!activeEntry || entry.startTime < activeEntry.startTime) {
        activeEntry = entry;
      }
    }

    if (!activeEntry?.metadata?.itemId) {
      return null;
    }

    const itemKey = this.playbackKey(activeEntry.metadata);
    const alreadyPlayedMs = this.playedMsByItem.get(itemKey) || 0;
    const elapsedCurrentMs = Math.max(0, Math.min(activeEntry.durationMs, (now - activeEntry.startTime) * 1000));

    return {
      responseId: activeEntry.metadata.responseId,
      itemId: activeEntry.metadata.itemId,
      contentIndex: activeEntry.metadata.contentIndex || 0,
      audioEndMs: Math.round(alreadyPlayedMs + elapsedCurrentMs),
    };
  }

  addCompletedChunkPlayback(entry) {
    if (!entry?.metadata?.itemId) {
      return;
    }

    const itemKey = this.playbackKey(entry.metadata);
    this.playedMsByItem.set(itemKey, (this.playedMsByItem.get(itemKey) || 0) + entry.durationMs);

    // Keep playedMsByItem bounded to prevent unbounded memory growth
    while (this.playedMsByItem.size > this.maxTrackedItems) {
      const oldestKey = this.playedMsByItem.keys().next().value;
      this.playedMsByItem.delete(oldestKey);
    }
  }

  finishAudioIfIdle() {
    if (!this.receivedAudioDone || this.scheduledSources.size > 0) {
      return;
    }

    this.receivedAudioDone = false;
    this.turnActive = false;
    this.nextPlayTime = 0;
    this.stopCaptionSyncLoop();
    this.sendSafe({ type: 'playback_state', data: { playing: false } });
    this.onAudioDone(this.lastAudioDoneMetadata);
  }

  playbackKey(metadata) {
    return `${metadata.itemId}:${metadata.contentIndex || 0}`;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.sendSafe({ type: 'heartbeat' });
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  scheduleReconnect() {
    if (!this.shouldReconnect) return;
    this.reconnectAttempts += 1;
    const baseDelay = Math.min(1000 * (2 ** Math.min(this.reconnectAttempts - 1, 4)), 15000);
    const jitter = Math.floor(Math.random() * 400);
    const delay = baseDelay + jitter;
    this.onStatus(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        this.onError(error.message || String(error));
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  close() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.interrupt(false);
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) {
      this.ws.close(1000, 'client closed');
    }
  }

  base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i += 1) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
