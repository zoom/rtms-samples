import { EventEmitter } from 'events';
import { RTMSMessageHandler } from './RTMSMessageHandler.js';
import { ActiveConnectionManager } from './ActiveConnectionManager.js';
import { RTMS_MEDIA_PARAMS } from './utils/rtmsMediaParams.js';
import { RTMSConfigHelper } from './utils/RTMSConfigHelper.js';
import { FileLogger } from './utils/FileLogger.js';
import { redactSecrets } from './utils/redactSecrets.js';

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
   * @throws {Error} If init() has not been called yet.
   */
  static get instance() {
    if (!RTMSManager.#instance) {
      throw new Error('RTMSManager must be initialized first with RTMSManager.init()');
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
      FileLogger.error(`RTMSManager.handleEvent: not initialized ${e.message}`);
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
      throw new Error('[RTMSManager] Must call init() before registering event handlers.');
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
      FileLogger.warn(`[RTMSManager] getActiveConnections failed: ${error.message}. RTMSManager may not be initialized. Call RTMSManager.init() first.`);
      return [];
    }
  }


  /**
   * Flat RTMS Media Params Constants from Zoom docs
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
   * Note: Can only be called once. Subsequent calls will return the existing instance
   * and ignore the new configuration. To reinitialize, the process must be restarted.
   * @param {Object} options
   */
  static async init(options = {}) {
    if (RTMSManager.#instance) {
      (RTMSManager.#instance.logger || FileLogger).warn('[RTMSManager] Already initialized. Returning existing instance.');
      return RTMSManager.#instance;
    }

    if (options.logging) {
      FileLogger.configure({
        logDir: options.logging.logDir,
        enabled: options.logging.enabled !== false,
        console: options.logging.console !== false
      });
    }

    const config = RTMSConfigHelper.merge(options);

    // Handle the master gap filler flag
    if (config.enableRealTimeAudioVideoGapFiller) {
      config.enableGapFilling = true;
      config.useFiller = true;
    }

    // Compatibility mapper for internal property names used by handlers and secondary managers
    const internalConfig = {
      ...config,
      // Map nested structured credentials to flat format expected by sub-modules
      clientId: config.credentials.meeting.clientId || config.credentials.websocket.clientId,
      clientSecret: config.credentials.meeting.clientSecret || config.credentials.websocket.clientSecret,
      zoomSecretToken: config.credentials.meeting.zoomSecretToken,
      videoClientId: config.credentials.video.videoClientId,
      videoClientSecret: config.credentials.video.videoClientSecret,
      videoSecretToken: config.credentials.video.videoSecretToken,
      s2sClientId: config.credentials.s2s.clientId,
      s2sClientSecret: config.credentials.s2s.clientSecret,
      accountId: config.credentials.s2s.accountId,
      webhookPath: config.webhookPath || '/webhook',
      zoomWSURLForEvents: config.credentials.websocket.zoomWSURLForEvents,
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

    // Note: We no longer need this.eventHandlers = new Map() because we extend EventEmitter

    // Internal handlers for RTMS lifecycle events
    // We use super.on() to register these internal listeners
    this.on('meeting.rtms_started', (payload) => {
      const { meeting_uuid, rtms_stream_id, server_urls, event_ts } = payload;
      this.onStreamStart(meeting_uuid, 'meeting', rtms_stream_id, server_urls, {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret
      }, event_ts);
    });

    this.on('webinar.rtms_started', (payload) => {
      const { webinar_uuid, rtms_stream_id, server_urls, event_ts } = payload;
      this.onStreamStart(webinar_uuid, 'webinar', rtms_stream_id, server_urls, {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret
      }, event_ts);
    });

    this.on('session.rtms_started', (payload) => {
      const { session_id, rtms_stream_id, server_urls, event_ts } = payload;
      this.onStreamStart(session_id, 'session', rtms_stream_id, server_urls, {
        clientId: this.config.videoClientId || this.config.clientId,
        clientSecret: this.config.videoClientSecret || this.config.clientSecret
      }, event_ts);
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

    // Bind methods
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
  }

  // Note: We removed the custom on() and emit() methods to use the native EventEmitter ones.

  // Start the RTMS manager
  async start() {
    if (this._state === 'STARTED') {
      this.logger.warn('[RTMSManager] Manager already started.');
      return;
    }
    if (this._state !== 'INITIALIZED' && this._state !== 'STOPPED') {
      throw new Error(`[RTMSManager] Cannot start from state: ${this._state}`);
    }

    this._state = 'STARTED';
    this.logger.info(`[RTMSManager] 🚀 RTMS Manager ready - feed RTMS events via emit(event, payload)`);
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
        this.logger.info(`[RTMSManager] Stopping RTMS for ${handler.rtmsType} ${handler.rtmsId} stream ${handler.streamId}`);
        handler.stop();
      }
      this.connectionManager.clear();
      this.logger.info('[RTMSManager] RTMS Manager stopped');
      this._state = 'STOPPED';
      resolve();
    });
  }

  onStreamStart(rtmsId, rtmsType, streamId, serverUrls, creds, startTime = null) {
    if (this.connectionManager.has(streamId)) {
      this.logger.warn(`[RTMSManager] Duplicate stream ID ${streamId} detected for ${rtmsType} ${rtmsId}. Ignoring.`);
      return true;
    }

    this.logger.info(`[RTMSManager] Starting RTMS for ${rtmsType} ${rtmsId} stream ${streamId}`);

    const handler = new RTMSMessageHandler(
      rtmsId,
      streamId,
      serverUrls,
      creds.clientId,
      creds.clientSecret,
      this.config.mediaSocketConnectionMode,
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
      this.logger.info(`[RTMSManager] Stopping RTMS for ${handler.rtmsType} ${handler.rtmsId} stream ${streamId}`);
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
        mediaSocketConnectionMode: handler.mediaSocketConnectionMode,
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
          instance.logger.log(`[RTMSManager] Evicted stream ${oldestStreamId} from history (LRU, size limit: ${maxSize})`);
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
        mediaSocketConnectionMode: active.mediaSocketConnectionMode,
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
