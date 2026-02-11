import { connectToSignalingWebSocket } from './signalingSocket.js';
import { MediaAudioFiller } from './helpers/audio/MediaAudioFiller.js';
import { MediaVideoFiller } from './helpers/video/MediaVideoFiller.js';
import {
  getRtmsSessionState,
  getRtmsStreamState,
  getRtmsStopReason,
  getRtmsStatusCode
} from './utils/rtmsEventLookupHelper.js';
import { FileLogger } from './utils/FileLogger.js';

export class RTMSMessageHandler {
  /**
   * @param {string} rtmsId - Meeting/session UUID
   * @param {string} streamId - RTMS stream ID
   * @param {Object} serverUrls - Server URLs from webhook
   * @param {string} clientId - OAuth client ID
   * @param {string} clientSecret - OAuth client secret
   * @param {Function} emit - Event emitter function
   * @param {number} mediaTypesFlag - Media types to subscribe (bitmask)
   * @param {Object} config - Configuration options
   * @param {string} rtmsType - Product type (meeting, webinar, videoSdk, etc.)
   * @param {number|null} startTime - Start timestamp from webhook
   */
  constructor(rtmsId, streamId, serverUrls, clientId, clientSecret, emit, mediaTypesFlag = 32, config = {}, rtmsType = 'meeting', startTime = null) {
    this.rtmsId = rtmsId;
    this.rtmsType = rtmsType;
    this.streamId = streamId;
    this.startTime = startTime;
    this.serverUrls = serverUrls;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.emit = (eventName, ...args) => {
      if (eventName === 'error') {
        try {
          return emit(eventName, ...args);
        } catch (eventError) {
          const sourceError = args[0];
          const errorText = sourceError && typeof sourceError.toShortString === 'function'
            ? sourceError.toShortString()
            : (sourceError?.message || String(sourceError || eventError));
          FileLogger.error(`[RTMSManager] Unhandled error event (no error listener): ${errorText}`);
          return false;
        }
      }

      return emit(eventName, ...args);
    };
    this.mediaTypesFlag = mediaTypesFlag;
    this.config = config;
    this.shouldReconnect = true;
    this.signaling = { socket: null, state: 'connecting', lastKeepAlive: null };
    this._signalingReconnectTimer = null;
    this._signalingHandshakeInFlight = false;
    
    // Split mode only - each media type gets its own socket
    this.media = {};
    
    this._firstPacketTimestamp = null;
    this._lastPacketTimestamp = null;
    this.mediaConfig = {};
    this.pingRtt = -1;

    this.audioFiller = null;
    this.videoFiller = null;

    if (this.config.useFiller) {
      const audioParams = this.config.mediaParams?.audio;
      const videoParams = this.config.mediaParams?.video;

      if (!audioParams) {
        FileLogger.warn(`[RTMSMessageHandler] Audio filler enabled but mediaParams.audio is missing. Using defaults.`);
      }
      if (!videoParams) {
        FileLogger.warn(`[RTMSMessageHandler] Video filler enabled but mediaParams.video is missing. Using defaults.`);
      }

      this.audioFiller = new MediaAudioFiller(this.rtmsId, this.streamId, 'mixed', this.startTime, audioParams || {});
      this.videoFiller = new MediaVideoFiller(this.rtmsId, this.streamId, 'mixed', this.startTime, videoParams || {});

      // Filler emits event objects
      this.audioFiller.on('data', (chunk, uid, ts, mid, sid) => {
        this.emit('audio', {
          type: 'audio',
          buffer: chunk,
          userId: uid,
          userName: 'Mixed Audio',
          timestamp: ts,
          meetingId: mid,
          streamId: sid,
          productType: this.rtmsType
        });
      });

      this.videoFiller.on('data', (chunk, uid, ts, mid, sid) => {
        this.emit('video', {
          type: 'video',
          buffer: chunk,
          userId: uid,
          userName: 'Mixed Video',
          timestamp: ts,
          meetingId: mid,
          streamId: sid,
          productType: this.rtmsType
        });
      });
    }

    this.connect();
  }

  setPingRtt(rtt) {
    this.pingRtt = rtt;
  }

  get firstPacketTimestamp() {
    return this._firstPacketTimestamp;
  }

  get lastPacketTimestamp() {
    return this._lastPacketTimestamp;
  }

  setFirstPacketTimestamp(ts) {
    if (this._firstPacketTimestamp === null) {
      this._firstPacketTimestamp = ts;
    }
  }

  updateLastPacketTimestamp(ts) {
    this._lastPacketTimestamp = ts;
  }

  connect() {
    FileLogger.log(`[Handler:${this.streamId.slice(-8)}] Starting for ${this.rtmsType} ${this.rtmsId}`);
    connectToSignalingWebSocket(
      this.rtmsId,
      this.streamId,
      this.serverUrls,
      this,
      this.clientId,
      this.clientSecret,
      (...args) => this.emit(...args),
      this.mediaTypesFlag
    );
  }

  stop() {
    FileLogger.log(`[Handler:${this.streamId.slice(-8)}] Stopping for ${this.rtmsType} ${this.rtmsId}`);
    this.shouldReconnect = false;
    this._lastPacketTimestamp = Date.now();

    if (this._signalingReconnectTimer) {
      clearTimeout(this._signalingReconnectTimer);
      this._signalingReconnectTimer = null;
    }

    if (this.audioFiller) {
      this.audioFiller.stop(this._lastPacketTimestamp);
    }
    if (this.videoFiller) {
      this.videoFiller.stop(this._lastPacketTimestamp);
    }

    if (this.signaling.socket) {
      this.signaling.socket.close();
    }

    // Close all media sockets
    if (this.media && typeof this.media === 'object') {
      Object.values(this.media).forEach(m => {
        if (m && m.socket) m.socket.close();
      });
    }
  }

  getActiveConnections() {
    return [this];
  }
}
