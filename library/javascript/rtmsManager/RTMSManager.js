import { EventEmitter } from 'events';
import { RTMSMessageHandler } from './RTMSMessageHandler.js';
import { ActiveConnectionManager } from './ActiveConnectionManager.js';
import { RTMS_MEDIA_PARAMS } from './utils/rtmsMediaParams.js';
import { RTMSConfigHelper } from './utils/RTMSConfigHelper.js';
import { FileLogger } from './utils/FileLogger.js';
import { RTMSError } from './utils/RTMSError.js';
import { redactSecrets } from './utils/redactSecrets.js';

/**
 * Media type constants for easy configuration
 * Use with mediaTypes config option: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT
 */
const MEDIA = Object.freeze({
  AUDIO: 1,
  VIDEO: 2,
  SHARESCREEN: 4,
  TRANSCRIPT: 8,
  CHAT: 16,
  ALL: 32
});

/**
 * Preset configurations for common use cases
 * Use with spread: { ...RTMSManager.PRESETS.TRANSCRIPTION, credentials: {...} }
 */
const PRESETS = Object.freeze({
  /** Audio only - optimized for speech processing */
  AUDIO_ONLY: {
    mediaTypes: MEDIA.AUDIO,
    mediaParams: {
      audio: {
        contentType: RTMS_MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
        sampleRate: RTMS_MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
        channel: RTMS_MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
        codec: RTMS_MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
        dataOpt: RTMS_MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
        sendRate: 100
      }
    }
  },
  /** Transcription - audio + transcript for real-time captions */
  TRANSCRIPTION: {
    mediaTypes: MEDIA.AUDIO | MEDIA.TRANSCRIPT,
    mediaParams: {
      audio: {
        contentType: RTMS_MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
        sampleRate: RTMS_MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
        channel: RTMS_MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
        codec: RTMS_MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
        dataOpt: RTMS_MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
        sendRate: 100
      },
      transcript: {
        contentType: RTMS_MEDIA_PARAMS.MEDIA_CONTENT_TYPE_TEXT,
        language: RTMS_MEDIA_PARAMS.LANGUAGE_ID_ENGLISH
      }
    }
  },
  /** Video recording - audio + video for recording */
  VIDEO_RECORDING: {
    mediaTypes: MEDIA.AUDIO | MEDIA.VIDEO,
    mediaParams: {
      audio: {
        contentType: RTMS_MEDIA_PARAMS.MEDIA_CONTENT_TYPE_RTP,
        sampleRate: RTMS_MEDIA_PARAMS.AUDIO_SAMPLE_RATE_SR_16K,
        channel: RTMS_MEDIA_PARAMS.AUDIO_CHANNEL_MONO,
        codec: RTMS_MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_L16,
        dataOpt: RTMS_MEDIA_PARAMS.MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM,
        sendRate: 100
      },
      video: {
        codec: RTMS_MEDIA_PARAMS.MEDIA_PAYLOAD_TYPE_H264,
        dataOpt: RTMS_MEDIA_PARAMS.MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM,
        resolution: RTMS_MEDIA_PARAMS.MEDIA_RESOLUTION_HD,
        fps: 25
      }
    }
  },
  /** Full media - all media types (default) */
  FULL_MEDIA: {
    mediaTypes: MEDIA.ALL
  }
});

/**
 * RTMSManager
 * Singleton class that orchestrates RTMS connections and events.
 * Extends EventEmitter to provide a standard event interface.
 */
export class RTMSManager extends EventEmitter {
  /**
   * @type {RTMSManager}
   * @private
   */
  static #instance = null;

  /**
   * Get the singleton instance of RTMSManager.
   * @returns {RTMSManager}
   * @throws {RTMSError} If init() has not been called yet.
   */
  static get instance() {
    if (!RTMSManager.#instance) {
      throw RTMSError.fromCode('NOT_INITIALIZED');
    }
    return RTMSManager.#instance;
  }

  /**
   * Static proxy to emit events on the singleton instance.
   * @param {string} event 
   * @param  {...any} args 
   */
  static handleEvent(event, ...args) {
    try {
      RTMSManager.instance.emit(event, ...args);
    } catch (e) {
      FileLogger.error(`RTMSManager.handleEvent: ${e.message}`);
    }
  }

  /**
   * Static proxy to register event listeners on the singleton instance.
   * @param {string} event 
   * @param {Function} handler 
   */
  static on(event, handler) {
    if (RTMSManager.#instance) {
      RTMSManager.instance.on(event, handler);
    } else {
      throw RTMSError.fromCode('NOT_INITIALIZED');
    }
  }

  /**
   * Start the RTMS Manager.
   */
  static async start() {
    return await RTMSManager.instance.start();
  }

  /**
   * Stop the RTMS Manager.
   */
  static async stop() {
    return RTMSManager.instance.stop();
  }

  /**
   * Get all active RTMS connections.
   */
  static getActiveConnections() {
    try {
      return RTMSManager.instance.getActiveConnections();
    } catch (error) {
      FileLogger.warn(`[RTMSManager] getActiveConnections failed: ${error.message}`);
      return [];
    }
  }


  /**
   * Media type constants for easy configuration
   * @example
   * mediaTypes: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT
   */
  static get MEDIA() {
    return MEDIA;
  }

  /**
   * Preset configurations for common use cases
   * @example
   * await RTMSManager.init({ ...RTMSManager.PRESETS.TRANSCRIPTION, credentials: {...} })
   */
  static get PRESETS() {
    return PRESETS;
  }

  /**
   * Flat RTMS Media Params Constants from Zoom docs (advanced usage)
   * @deprecated Use RTMSManager.MEDIA for media types, this is for advanced codec/format config
   */
  static get MEDIA_PARAMS() {
    return RTMS_MEDIA_PARAMS;
  }

  /**
   * Utility to redact secrets from config objects for safe logging
   */
  static redactSecrets(obj) {
    return redactSecrets(obj);
  }

  /**
   * Initialize the RTMS Manager with a configuration object.
   * Auto-starts after initialization - no need to call start() separately.
   * 
   * Note: Can only be called once. Subsequent calls will return the existing instance
   * and ignore the new configuration. To reinitialize, the process must be restarted.
   * 
   * @param {Object} options - Configuration options
   * @param {Object} options.credentials - Product-keyed credentials or shorthand
   * @param {number} [options.mediaTypes=RTMSManager.MEDIA.ALL] - Media types to subscribe
   * @param {string} [options.logging='off'] - Logging level: 'off'|'error'|'warn'|'info'|'debug'
   * @returns {Promise<RTMSManager>}
   * 
   * @example
   * // Shorthand credentials (applies to all products)
   * await RTMSManager.init({
   *   clientId: 'xxx',
   *   clientSecret: 'xxx', 
   *   secretToken: 'xxx'
   * });
   * 
   * @example
   * // Product-keyed credentials
   * await RTMSManager.init({
   *   credentials: {
   *     meeting: { clientId: 'xxx', clientSecret: 'xxx', secretToken: 'xxx' },
   *     videoSdk: { clientId: 'yyy', clientSecret: 'yyy', secretToken: 'yyy' }
   *   },
   *   mediaTypes: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT
   * });
   */
  static async init(options = {}) {
    if (RTMSManager.#instance) {
      (RTMSManager.#instance.logger || FileLogger).warn('[RTMSManager] Already initialized. Returning existing instance.');
      return RTMSManager.#instance;
    }

    // Merge provided options with defaults (handles normalization internally)
    const config = RTMSConfigHelper.merge(options);

    // Configure logging directory and level
    if (config.logDir) {
      FileLogger.setLogDir(config.logDir);
    }
    if (config.logging && config.logging !== 'off') {
      FileLogger.setLevel(config.logging);
    } else if (!options.logger) {
      FileLogger.setLevel('off');
    }

    // Handle the master gap filler flag
    if (config.enableRealTimeAudioVideoGapFiller) {
      config.enableGapFilling = true;
      config.useFiller = true;
    }

    // Build internal config with flattened credentials for sub-modules
    const meetingCreds = config.credentials.meeting || {};
    const videoSdkCreds = config.credentials.videoSdk || {};
    const s2sCreds = config.credentials.s2s || {};

    const internalConfig = {
      ...config,
      // Flattened credentials for internal use
      clientId: meetingCreds.clientId,
      clientSecret: meetingCreds.clientSecret,
      secretToken: meetingCreds.secretToken,
      // Video SDK credentials
      videoClientId: videoSdkCreds.clientId,
      videoClientSecret: videoSdkCreds.clientSecret,
      videoSecretToken: videoSdkCreds.secretToken,
      // S2S credentials
      s2sClientId: s2sCreds.clientId,
      s2sClientSecret: s2sCreds.clientSecret,
      accountId: s2sCreds.accountId,
      // Map mediaTypes to legacy mediaTypesFlag for internal handlers
      mediaTypesFlag: config.mediaTypes,
      // Map mediaParams to naming convention expected by low-level RTMS socket handlers
      mediaParams: {
        audio: {
          content_type: config.mediaParams.audio.contentType,
          sample_rate: config.mediaParams.audio.sampleRate,
          channel: config.mediaParams.audio.channel,
          codec: config.mediaParams.audio.codec,
          data_opt: config.mediaParams.audio.dataOpt,
          send_rate: config.mediaParams.audio.sendRate,
        },
        video: {
          codec: config.mediaParams.video.codec,
          data_opt: config.mediaParams.video.dataOpt,
          resolution: config.mediaParams.video.resolution,
          fps: config.mediaParams.video.fps,
        },
        deskshare: {
          codec: config.mediaParams.deskshare.codec,
          resolution: config.mediaParams.deskshare.resolution,
          fps: config.mediaParams.deskshare.fps,
        },
        chat: { content_type: config.mediaParams.chat.contentType },
        transcript: {
          content_type: config.mediaParams.transcript.contentType,
          language: config.mediaParams.transcript.language
        }
      }
    };

    RTMSManager.#instance = new RTMSManager({ 
      config: internalConfig, 
      logger: options.logger || FileLogger
    });

    // Auto-start - SDK is ready to process events immediately
    await RTMSManager.#instance.start();

    return RTMSManager.#instance;
  }

  constructor(options = {}) {
    super();
    this.config = options.config || {};
    this.logger = options.logger || FileLogger;
    this._state = 'INITIALIZED';
    this.connectionManager = new ActiveConnectionManager();
    this.streamHistory = new Map();
    this.streamHistoryAccessOrder = []; // Track access order for LRU eviction

    this.on('error', (error) => {
      const errorText = error && typeof error.toShortString === 'function'
        ? error.toShortString()
        : (error?.message || String(error));
      this.logger.error(`[RTMSManager] ${errorText}`);
    });

    // Internal handlers for RTMS lifecycle events
    // Supports: meeting, webinar, videoSdk (session), contactCenter, phone
    this.on('meeting.rtms_started', (payload) => {
      const { meeting_uuid, rtms_stream_id, server_urls, event_ts } = payload;
      const creds = RTMSConfigHelper.getCredentialsForProduct('meeting', this.config);
      this.onStreamStart(meeting_uuid, 'meeting', rtms_stream_id, server_urls, creds, event_ts);
    });

    this.on('webinar.rtms_started', (payload) => {
      const { webinar_uuid, rtms_stream_id, server_urls, event_ts } = payload;
      const creds = RTMSConfigHelper.getCredentialsForProduct('webinar', this.config);
      this.onStreamStart(webinar_uuid, 'webinar', rtms_stream_id, server_urls, creds, event_ts);
    });

    this.on('session.rtms_started', (payload) => {
      const { session_id, rtms_stream_id, server_urls, event_ts } = payload;
      const creds = RTMSConfigHelper.getCredentialsForProduct('videoSdk', this.config);
      this.onStreamStart(session_id, 'videoSdk', rtms_stream_id, server_urls, creds, event_ts);
    });

    // Future product support - contactCenter and phone
    this.on('contactcenter.rtms_started', (payload) => {
      const { session_id, rtms_stream_id, server_urls, event_ts } = payload;
      const creds = RTMSConfigHelper.getCredentialsForProduct('contactCenter', this.config);
      this.onStreamStart(session_id, 'contactCenter', rtms_stream_id, server_urls, creds, event_ts);
    });

    this.on('phone.rtms_started', (payload) => {
      const { call_id, rtms_stream_id, server_urls, event_ts } = payload;
      const creds = RTMSConfigHelper.getCredentialsForProduct('phone', this.config);
      this.onStreamStart(call_id, 'phone', rtms_stream_id, server_urls, creds, event_ts);
    });

    this.on('meeting.rtms_stopped', (payload) => {
      const { rtms_stream_id } = payload;
      this.onStreamStop(rtms_stream_id);
    });

    this.on('webinar.rtms_stopped', (payload) => {
      const { rtms_stream_id } = payload;
      this.onStreamStop(rtms_stream_id);
    });

    this.on('session.rtms_stopped', (payload) => {
      const { rtms_stream_id } = payload;
      this.onStreamStop(rtms_stream_id);
    });

    this.on('contactcenter.rtms_stopped', (payload) => {
      const { rtms_stream_id } = payload;
      this.onStreamStop(rtms_stream_id);
    });

    this.on('phone.rtms_stopped', (payload) => {
      const { rtms_stream_id } = payload;
      this.onStreamStop(rtms_stream_id);
    });

    // Bind methods
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
  }

  // Start the RTMS manager
  async start() {
    if (this._state === 'STARTED') {
      this.logger.warn('[RTMSManager] Manager already started.');
      return;
    }
    if (this._state !== 'INITIALIZED' && this._state !== 'STOPPED') {
      throw new RTMSError('INVALID_CONFIG', `Cannot start from state: ${this._state}`);
    }

    this._state = 'STARTED';
    this.logger.info(`[RTMSManager] Ready - feed RTMS events via emit(event, payload)`);
    return Promise.resolve();
  }

  // Stop the RTMS manager
  stop() {
    return new Promise((resolve) => {
      if (this._state !== 'STARTED') {
        this.logger.warn('[RTMSManager] Manager not started.');
        resolve();
        return;
      }

      const handlers = this.connectionManager.getAll();
      for (const handler of handlers) {
        this.logger.info(`[RTMSManager] Stopping ${handler.rtmsType} ${handler.rtmsId}`);
        handler.stop();
      }
      this.connectionManager.clear();
      this.logger.info('[RTMSManager] Stopped');
      this._state = 'STOPPED';
      resolve();
    });
  }

  onStreamStart(rtmsId, rtmsType, streamId, serverUrls, creds, startTime = null) {
    if (this.connectionManager.has(streamId)) {
      this.logger.warn(`[RTMSManager] Duplicate stream ID ${streamId} for ${rtmsType} ${rtmsId}`);
      return true;
    }

    this.logger.info(`[RTMSManager] Starting ${rtmsType} ${rtmsId} stream ${streamId}`);

    const handler = new RTMSMessageHandler(
      rtmsId,
      streamId,
      serverUrls,
      creds.clientId,
      creds.clientSecret,
      this.emit.bind(this), // Pass the native emit method
      this.config.mediaTypesFlag,
      this.config,
      rtmsType,
      startTime
    );
    this.connectionManager.add(streamId, handler);
    return false;
  }

  onStreamStop(streamId) {
    const handler = this.connectionManager.get(streamId);
    if (handler) {
      this.logger.info(`[RTMSManager] Stopping ${handler.rtmsType} ${handler.rtmsId} stream ${streamId}`);
      handler.stop();

      // Archive stream data
      RTMSManager.archiveStream(streamId, {
        firstPacketTimestamp: handler.firstPacketTimestamp,
        lastPacketTimestamp: handler.lastPacketTimestamp,
        startTime: handler.startTime,
        endTime: Date.now(),
        rtmsId: handler.rtmsId,
        rtmsType: handler.rtmsType,
        streamId: handler.streamId,
        serverUrls: handler.serverUrls,
        clientId: handler.clientId,
        mediaConfig: handler.mediaConfig,
        pingRtt: handler.pingRtt
      });

      this.connectionManager.remove(streamId);
    } else {
      this.logger.warn(`[RTMSManager] No handler found for streamId ${streamId}`);
    }
  }

  // Get active connections
  getActiveConnections() {
    return this.connectionManager.getAll();
  }

  /**
   * Archive stream data to history with LRU eviction
   * @param {string} streamId
   * @param {Object} data
   */
  static archiveStream(streamId, data) {
    if (!RTMSManager.#instance) return;

    const instance = RTMSManager.instance;
    const maxSize = instance.config.maxStreamHistorySize || 100;

    // Add timestamp for tracking
    data.archivedAt = Date.now();

    // Add to history
    instance.streamHistory.set(streamId, data);
    instance.streamHistoryAccessOrder.push(streamId);

    // Enforce size limit with LRU eviction
    if (instance.streamHistory.size > maxSize) {
      // Remove oldest entries (from beginning of access order array)
      const entriesToRemove = instance.streamHistory.size - maxSize;
      for (let i = 0; i < entriesToRemove; i++) {
        const oldestStreamId = instance.streamHistoryAccessOrder.shift();
        if (oldestStreamId) {
          instance.streamHistory.delete(oldestStreamId);
          instance.logger.log(`[RTMSManager] Evicted stream ${oldestStreamId} from history (LRU)`);
        }
      }
    }
  }

  /**
   * Get timestamps for a stream (active or archived)
   * @param {string} streamId 
   * @returns {Object|null} { firstPacketTimestamp, lastPacketTimestamp }
   */
  static getStreamTimestamps(streamId) {
    if (!RTMSManager.#instance) return null;

    // 1. Check active connections
    const active = RTMSManager.instance.connectionManager.get(streamId);
    if (active) {
      return {
        firstPacketTimestamp: active.firstPacketTimestamp,
        lastPacketTimestamp: active.lastPacketTimestamp
      };
    }

    // 2. Check history
    return RTMSManager.instance.streamHistory.get(streamId) || null;
  }

  /**
   * Get the start time of a stream (from the start event)
   * @param {string} streamId 
   * @returns {number|null}
   */
  static getStreamStartTime(streamId) {
    if (!RTMSManager.#instance) return null;

    // 1. Check active connections
    const active = RTMSManager.instance.connectionManager.get(streamId);
    if (active) {
      return active.startTime;
    }

    // 2. Check history
    const history = RTMSManager.instance.streamHistory.get(streamId);
    if (history) {
      return history.startTime;
    }
    return null;
  }

  /**
   * Get the media configuration for a stream (active or archived)
   * @param {string} streamId 
   * @returns {Object|null}
   */
  static getStreamMediaConfig(streamId) {
    if (!RTMSManager.#instance) return null;

    const active = RTMSManager.instance.connectionManager.get(streamId);
    if (active) return active.mediaConfig;

    const history = RTMSManager.instance.streamHistory.get(streamId);
    return history ? history.mediaConfig : null;
  }

  /**
   * Get metadata for a stream (active or archived)
   * @param {string} streamId 
   * @returns {Object|null}
   */
  static getStreamMetadata(streamId) {
    if (!RTMSManager.#instance) return null;

    const active = RTMSManager.instance.connectionManager.get(streamId);
    if (active) {
      return {
        rtmsId: active.rtmsId,
        rtmsType: active.rtmsType,
        streamId: active.streamId,
        serverUrls: active.serverUrls,
        clientId: active.clientId,
        pingRtt: active.pingRtt,
        startTime: active.startTime,
        firstPacketTimestamp: active.firstPacketTimestamp,
        lastPacketTimestamp: active.lastPacketTimestamp
      };
    }

    return RTMSManager.instance.streamHistory.get(streamId) || null;
  }

  static getAudioDetails(streamId) {
    const config = RTMSManager.getStreamMediaConfig(streamId);
    return config ? config.audio : null;
  }

  static getVideoDetails(streamId) {
    const config = RTMSManager.getStreamMediaConfig(streamId);
    return config ? config.video : null;
  }

  static getShareScreenDetails(streamId) {
    const config = RTMSManager.getStreamMediaConfig(streamId);
    return config ? config.deskshare : null;
  }

  static getTranscriptDetails(streamId) {
    const config = RTMSManager.getStreamMediaConfig(streamId);
    return config ? config.transcript : null;
  }

  static getChatDetails(streamId) {
    const config = RTMSManager.getStreamMediaConfig(streamId);
    return config ? config.chat : null;
  }

  static getPingRtt(streamId) {
    const metadata = RTMSManager.getStreamMetadata(streamId);
    return metadata ? metadata.pingRtt : -1;
  }
}

export default RTMSManager;
