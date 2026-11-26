/**
 * AudioClient: WebSocket + Web Audio playback client for AI Chat with Audio Playback.
 * Supports FrontendWssManager registration, resilient exponential-backoff reconnect,
 * WAV decodeAudioData() + raw PCM fallback, gapless scheduling, mute, and barge-in interrupt.
 */
class AudioClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.audioContext = null;
    this.isConnected = false;
    this.isRegistered = false;
    this.isModelSpeaking = false;
    this.isMuted = false;
    this.audioUnlocked = false;
    this.manualClose = false;

    this.registrationPayload = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelayMs = 15000;
    this.reconnectTimer = null;

    // Gapless Web Audio scheduling state
    this.activeSources = new Set();
    this.nextStartTime = 0;

    // Callbacks
    this.onConnected = () => {};
    this.onDisconnected = () => {};
    this.onRegistered = () => {};
    this.onReady = () => {};
    this.onTranscriptReceived = () => {};
    this.onUserMessageReceived = () => {};
    this.onTextReceived = () => {};
    this.onAudioReceived = () => {};
    this.onStateReceived = () => {};
    this.onStatusChange = () => {};
    this.onSpeakingChange = () => {};
    this.onInterrupted = () => {};
    this.onError = () => {};
  }

  /**
   * Must be called inside a user gesture handler to unlock browser AudioContext playback.
   */
  async unlockAudio() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioCtx();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this.audioUnlocked = this.audioContext.state === 'running';
    return this.audioUnlocked;
  }

  setMuted(muted) {
    this.isMuted = Boolean(muted);
    if (this.isMuted) {
      this._stopLocalPlayback();
    }
  }

  setRegistration(payload) {
    this.registrationPayload = payload;
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendRegistration();
    }
  }

  _sendRegistration() {
    if (!this.registrationPayload || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const { meetingUUID, userID, token } = this.registrationPayload;
    this.ws.send(JSON.stringify({
      type: 'register',
      meetingUUID: String(meetingUUID),
      userID: String(userID),
      token: token || ''
    }));
  }

  connect() {
    this.manualClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      try {
        this.ws.onclose = null;
        this.ws.close(1000, 'Reconnecting');
      } catch {
        // ignore close errors
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        const ws = new WebSocket(this.serverUrl);
        this.ws = ws;

        const timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            try { ws.close(); } catch { /* ignore */ }
            reject(new Error('WebSocket connection timed out'));
          }
        }, 10000);

        ws.onopen = () => {
          clearTimeout(timeoutId);
          this.isConnected = true;
          this.isRegistered = false;
          this.reconnectAttempts = 0;

          if (this.registrationPayload) {
            this._sendRegistration();
          }

          this.onConnected();
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        ws.onmessage = async (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch (err) {
            console.warn('[AudioClient] Ignored non-JSON message:', err);
            return;
          }

          switch (message.type) {
            case 'ping':
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pong' }));
              }
              break;
            case 'connected':
              if (this.registrationPayload && !this.isRegistered) {
                this._sendRegistration();
              }
              break;
            case 'registration_success':
              this.isRegistered = true;
              this.onRegistered(message);
              this.onReady(message);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'sync_state' }));
              }
              break;
            case 'session_state':
            case 'settings_updated':
              this.onStateReceived(message.state);
              break;
            case 'transcript':
              this.onTranscriptReceived(message);
              break;
            case 'user_message':
              this.onUserMessageReceived(message.message);
              break;
            case 'text':
              this.onTextReceived(message.data, message.metadata || {});
              break;
            case 'audio':
              this.onAudioReceived(message.data, message.metadata || {});
              if (!this.isMuted) {
                await this.playAudio(message.data, message.metadata || {});
              }
              break;
            case 'assistant_status':
            case 'rtms_status':
              this.onStatusChange(message);
              break;
            case 'interrupted':
              this._stopLocalPlayback();
              this.onInterrupted(message);
              break;
            case 'error':
              this.onError(message.message || message.data || 'Server error');
              break;
            default:
              break;
          }
        };

        ws.onerror = (err) => {
          clearTimeout(timeoutId);
          this.onError('WebSocket connection error');
          if (!settled) {
            settled = true;
            reject(err instanceof Error ? err : new Error('WebSocket error'));
          }
        };

        ws.onclose = (event) => {
          clearTimeout(timeoutId);
          this.isConnected = false;
          this.isRegistered = false;
          this.onDisconnected(event);
          if (!this.manualClose) {
            this._scheduleReconnect();
          }
        };
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  _scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelayMs);
    const jitter = Math.floor(Math.random() * 400);
    const delay = baseDelay + jitter;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // onclose / onerror will schedule the next retry
      });
    }, delay);
  }

  sendText(text, speaker) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isRegistered) {
      return false;
    }
    this.ws.send(JSON.stringify({
      type: 'text',
      data: text,
      speaker: speaker || ''
    }));
    return true;
  }

  sendSettings(settings) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isRegistered) {
      return false;
    }
    this.ws.send(JSON.stringify({
      type: 'settings',
      settings
    }));
    return true;
  }

  async playAudio(base64Audio, metadata = {}) {
    if (!base64Audio || this.isMuted) return;

    try {
      const arrayBuffer = this._base64ToArrayBuffer(base64Audio);

      if (!this.audioContext || this.audioContext.state === 'closed') {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        try {
          await this.audioContext.resume();
        } catch {
          this.onError('Click "Enable Audio" to allow voice playback in your browser.');
          return;
        }
      }

      this.audioUnlocked = this.audioContext.state === 'running';
      if (!this.audioUnlocked) {
        this.onError('Audio is suspended. Click "Enable Audio" to hear AI voice responses.');
        return;
      }

      const audioBuffer = await this._decodeAudioBuffer(arrayBuffer, metadata);
      this._scheduleBuffer(audioBuffer);
    } catch (error) {
      console.error('[AudioClient] Error decoding/playing audio:', error);
      this.onError('Could not play audio response.');
    }
  }

  async _decodeAudioBuffer(arrayBuffer, metadata) {
    const bytes = new Uint8Array(arrayBuffer);
    const isWav = metadata.format === 'wav' || (
      bytes.length >= 4 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    );

    if (isWav) {
      return await this.audioContext.decodeAudioData(arrayBuffer.slice(0));
    }

    const sampleRate = Number(metadata.sampleRate) || 24000;
    const sampleCount = Math.floor(arrayBuffer.byteLength / 2);
    const int16 = new Int16Array(arrayBuffer, 0, sampleCount);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      float32[i] = int16[i] / 32768.0;
    }
    const audioBuffer = this.audioContext.createBuffer(1, sampleCount, sampleRate);
    audioBuffer.getChannelData(0).set(float32);
    return audioBuffer;
  }

  _scheduleBuffer(audioBuffer) {
    const ctx = this.audioContext;
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.01, this.nextStartTime);
    this.nextStartTime = startAt + audioBuffer.duration;

    this.activeSources.add(source);
    if (!this.isModelSpeaking) {
      this.isModelSpeaking = true;
      this.onSpeakingChange(true);
    }

    source.onended = () => {
      source.disconnect();
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) {
        this.nextStartTime = 0;
        if (this.isModelSpeaking) {
          this.isModelSpeaking = false;
          this.onSpeakingChange(false);
        }
      }
    };

    source.start(startAt);
  }

  _stopLocalPlayback() {
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        // already stopped
      }
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
    if (this.isModelSpeaking) {
      this.isModelSpeaking = false;
      this.onSpeakingChange(false);
    }
  }

  interrupt() {
    this._stopLocalPlayback();
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isRegistered) {
      this.ws.send(JSON.stringify({ type: 'interrupt' }));
    }
  }

  close() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._stopLocalPlayback();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    if (this.ws) {
      try {
        this.ws.onclose = null;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'Client closed');
        }
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.isConnected = false;
    this.isRegistered = false;
  }

  _base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AudioClient };
}
