class RealtimeAudioClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.audioContext = null;
    this.isConnected = false;
    this.audioQueue = [];
    this.isPlaying = false;
    this.currentSource = null;
    this.currentChunk = null;
    this.currentChunkStartedAt = 0;
    this.receivedAudioDone = false;
    this.playedMsByItem = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.heartbeatInterval = null;
    this.heartbeatIntervalMs = 30000;

    this.onReady = () => {};
    this.onStatus = () => {};
    this.onTranscript = () => {};
    this.onTextDelta = () => {};
    this.onTextDone = () => {};
    this.onAudioStart = () => {};
    this.onAudioDone = () => {};
    this.onInterrupted = () => {};
    this.onError = () => {};
  }

  async connect() {
    if (this.ws) {
      this.ws.close();
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.serverUrl);

      const timeout = setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('WebSocket connection timeout'));
        }
      }, 7000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.startHeartbeat();
      };

      this.ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          await this.handleServerMessage(message);
          if (message.type === 'ready') {
            this.isConnected = true;
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) {
          this.onError(error.message || String(error));
        }
      };

      this.ws.onerror = (error) => {
        clearTimeout(timeout);
        this.onError('Frontend WebSocket error');
        reject(error);
      };

      this.ws.onclose = (event) => {
        clearTimeout(timeout);
        this.isConnected = false;
        this.stopHeartbeat();
        this.interrupt(false);
        if (event.code !== 1000 && event.code !== 1001) {
          this.tryReconnect();
        }
      };
    });
  }

  async handleServerMessage(message) {
    switch (message.type) {
      case 'ready':
        this.onReady();
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
        this.finishAudioIfIdle(message.metadata || {});
        break;
      case 'interrupt':
        this.interrupt(true, { skipCancel: message.data === 'speech_started' });
        this.onInterrupted(message.data || 'interrupted', message.metadata || {});
        break;
      case 'error':
        this.onError(message.data || 'Server error');
        break;
      default:
        break;
    }
  }

  sendReady(data) {
    this.send({ type: 'client_ready', data });
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  async enqueueAudio(base64Audio, metadata = {}) {
    const audioBuffer = this.base64ToArrayBuffer(base64Audio);
    const int16Array = new Int16Array(audioBuffer);
    const sampleRate = metadata.sampleRate || 24000;
    const durationMs = (int16Array.length / sampleRate) * 1000;
    this.audioQueue.push({
      audioBuffer,
      metadata,
      durationMs,
      sampleRate,
    });

    this.onAudioStart(metadata);

    if (!this.isPlaying) {
      await this.playNext();
    }
  }

  async ensureAudioContext(sampleRate = 24000) {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  async enablePlayback(sampleRate = 24000) {
    await this.ensureAudioContext(sampleRate);
    return this.audioContext?.state || 'unknown';
  }

  async playNext() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      this.currentChunk = null;
      this.finishAudioIfIdle();
      return;
    }

    this.isPlaying = true;
    this.currentChunk = this.audioQueue.shift();

    try {
      await this.ensureAudioContext(this.currentChunk.sampleRate);

      const int16Array = new Int16Array(this.currentChunk.audioBuffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let index = 0; index < int16Array.length; index += 1) {
        float32Array[index] = Math.max(-1, Math.min(1, int16Array[index] / 32768));
      }

      const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, this.currentChunk.sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);

      this.currentSource = source;
      this.currentChunkStartedAt = this.audioContext.currentTime;

      source.onended = () => {
        this.addCompletedChunkPlayback(this.currentChunk);
        this.currentSource = null;
        this.currentChunk = null;
        this.playNext();
      };

      source.start(0);
    } catch (error) {
      this.onError(error.message || String(error));
      this.currentSource = null;
      this.currentChunk = null;
      setTimeout(() => this.playNext(), 50);
    }
  }

  interrupt(reportToServer = true, options = {}) {
    const interruption = this.currentPlaybackPosition();

    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
        this.currentSource.disconnect();
      } catch {
        // Ignore already-stopped audio sources.
      }
    }

    this.currentSource = null;
    this.currentChunk = null;
    this.audioQueue = [];
    this.isPlaying = false;
    this.receivedAudioDone = false;

    if (reportToServer && interruption?.itemId) {
      this.send({
        type: 'playback_interrupted',
        data: {
          ...interruption,
          skipCancel: options.skipCancel === true,
        },
      });
    }
  }

  currentPlaybackPosition() {
    const chunk = this.currentChunk;
    if (!chunk?.metadata?.itemId) {
      return null;
    }

    const itemKey = this.playbackKey(chunk.metadata);
    const alreadyPlayedMs = this.playedMsByItem.get(itemKey) || 0;
    const elapsedCurrentMs = this.audioContext
      ? Math.max(0, (this.audioContext.currentTime - this.currentChunkStartedAt) * 1000)
      : 0;

    return {
      responseId: chunk.metadata.responseId,
      itemId: chunk.metadata.itemId,
      contentIndex: chunk.metadata.contentIndex || 0,
      audioEndMs: Math.min(
        Math.round(alreadyPlayedMs + elapsedCurrentMs),
        Math.round(alreadyPlayedMs + chunk.durationMs),
      ),
    };
  }

  addCompletedChunkPlayback(chunk) {
    if (!chunk?.metadata?.itemId) {
      return;
    }

    const itemKey = this.playbackKey(chunk.metadata);
    this.playedMsByItem.set(itemKey, (this.playedMsByItem.get(itemKey) || 0) + chunk.durationMs);
  }

  finishAudioIfIdle(metadata = {}) {
    if (!this.receivedAudioDone || this.isPlaying || this.audioQueue.length > 0 || this.currentChunk) {
      return;
    }

    this.receivedAudioDone = false;
    this.onAudioDone(metadata);
  }

  playbackKey(metadata) {
    return `${metadata.itemId}:${metadata.contentIndex || 0}`;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  async tryReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.onError('Maximum reconnect attempts reached');
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * (2 ** this.reconnectAttempts), 10000);
    setTimeout(() => {
      this.connect().catch((error) => this.onError(error.message || String(error)));
    }, delay);
  }

  close() {
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
    for (let index = 0; index < binaryString.length; index += 1) {
      bytes[index] = binaryString.charCodeAt(index);
    }
    return bytes.buffer;
  }
}
