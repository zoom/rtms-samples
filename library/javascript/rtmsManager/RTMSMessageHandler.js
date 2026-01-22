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
  constructor(rtmsId, streamId, serverUrls, clientId, clientSecret, mediaSocketConnectionMode, emit, mediaTypesFlag = 32, config = {}, rtmsType = 'meeting', startTime = null) {
    this.rtmsId = rtmsId;
    this.rtmsType = rtmsType;
    this.streamId = streamId;
    this.startTime = startTime;
    this.serverUrls = serverUrls;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.mediaSocketConnectionMode = mediaSocketConnectionMode;
    this.emit = emit;
    this.mediaTypesFlag = mediaTypesFlag;
    this.config = config;
    this.shouldReconnect = true;
    this.signaling = { socket: null, state: 'connecting', lastKeepAlive: null };
    this.media = this.mediaSocketConnectionMode === 'split' ? {} : { socket: null, state: 'idle', lastKeepAlive: null };
    
    this._firstPacketTimestamp = null;
    this._lastPacketTimestamp = null;
    this.mediaConfig = {};
    this.pingRtt = -1;

    this.audioFiller = null;
    this.videoFiller = null;

    if (this.config.useFiller) {
      // Defensive null checks for config properties
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

      this.audioFiller.on('data', (chunk, uid, ts, mid, sid) => {
        this.emit('audio', chunk, uid, 'Mixed Audio', ts, mid, sid, this.rtmsType);
      });

      this.videoFiller.on('data', (chunk, uid, ts, mid, sid) => {
        this.emit('video', chunk, uid, 'Mixed Video', ts, mid, sid, this.rtmsType);
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
    FileLogger.log(`[Handler:${this.streamId.slice(-8)}] Starting handler for ${this.rtmsType} ${this.rtmsId} stream ${this.streamId}`);
    connectToSignalingWebSocket(
      this.rtmsId,
      this.streamId,
      this.serverUrls,
      this,
      this.clientId,
      this.clientSecret,
      this.mediaSocketConnectionMode,
      (...args) => this.emit(...args),
      this.mediaTypesFlag
    );
  }

  stop() {
    FileLogger.log(`[Handler:${this.streamId.slice(-8)}] Stopping handler for ${this.rtmsType} ${this.rtmsId} stream ${this.streamId}`);
    this.shouldReconnect = false;
    this._lastPacketTimestamp = Date.now();

    if (this.audioFiller) {
      this.audioFiller.stop(this._lastPacketTimestamp);
    }
    if (this.videoFiller) {
      this.videoFiller.stop(this._lastPacketTimestamp);
    }

    if (this.signaling.socket) {
      this.signaling.socket.close();
    }

    if (this.media && typeof this.media === 'object') {
      Object.values(this.media).forEach(m => {
        if (m && m.socket) m.socket.close();
      });
    }
  }

  getActiveConnections() { // compat?
    return [this];
  }
}
