/**
 * RTMSConfigHelper
 * Handles configuration defaults, normalization, and merging for RTMSManager.
 * 
 * Supports two credential formats:
 * 1. Shorthand (single product): { clientId, clientSecret, secretToken }
 * 2. Product-keyed: { credentials: { meeting: {...}, videoSdk: {...}, webinar: {...} } }
 */
export class RTMSConfigHelper {
  /**
   * Default configuration for RTMS Manager
   */
  static get DEFAULTS() {
    return {
      // Media settings
      mediaTypes: 32, // Default ALL (use RTMSManager.MEDIA.* constants)
      
      // Legacy alias for mediaTypes (backward compatibility)
      mediaTypesFlag: null, // Will be mapped to mediaTypes if set
      
      // Gap filler settings
      enableRealTimeAudioVideoGapFiller: false,
      enableGapFilling: false,
      useFiller: false,
      
      // Media socket mode: true = single socket for all media (better sync), false = separate sockets
      useUnifiedMediaSocket: false,
      
      // History settings
      maxStreamHistorySize: 100,
      
      // Logging (off by default for cleaner output)
      logging: 'off', // 'off' | 'error' | 'warn' | 'info' | 'debug'
      
      // Credentials - flattened, product-keyed structure
      // Supports: meeting, videoSdk, webinar, contactCenter, phone
      credentials: {
        meeting: { clientId: null, clientSecret: null, secretToken: null },
        videoSdk: { clientId: null, clientSecret: null, secretToken: null },
        webinar: { clientId: null, clientSecret: null, secretToken: null },
        contactCenter: { clientId: null, clientSecret: null, secretToken: null },
        phone: { clientId: null, clientSecret: null, secretToken: null },
        s2s: { clientId: null, clientSecret: null, accountId: null }
      },
      
      // Media parameters (advanced - usually use PRESETS instead)
      mediaParams: {
        audio: {
          contentType: 1, // MEDIA_CONTENT_TYPE_RTP
          sampleRate: 1,  // AUDIO_SAMPLE_RATE_SR_16K
          channel: 1,     // AUDIO_CHANNEL_MONO
          codec: 1,       // MEDIA_PAYLOAD_TYPE_L16
          dataOpt: 1,     // MEDIA_DATA_OPTION_AUDIO_MIXED_STREAM
          sendRate: 100,
        },
        video: {
          codec: 7,       // MEDIA_PAYLOAD_TYPE_H264
          dataOpt: 3,     // MEDIA_DATA_OPTION_VIDEO_SINGLE_ACTIVE_STREAM
          resolution: 2,  // MEDIA_RESOLUTION_HD
          fps: 25,
        },
        deskshare: {
          codec: 5,       // MEDIA_PAYLOAD_TYPE_JPG
          resolution: 2,  // MEDIA_RESOLUTION_HD
          fps: 1,
        },
        chat: {
          contentType: 5, // MEDIA_CONTENT_TYPE_TEXT
        },
        transcript: {
          contentType: 5, // MEDIA_CONTENT_TYPE_TEXT
          language: 9,    // LANGUAGE_ID_ENGLISH
        }
      }
    };
  }

  /**
   * Normalize user config to internal format
   * Handles shorthand credentials and legacy property names
   * @param {Object} userConfig 
   * @returns {Object}
   */
  static normalize(userConfig = {}) {
    const normalized = { ...userConfig };
    
    // Handle shorthand credentials (top-level clientId, clientSecret, secretToken)
    if (userConfig.clientId && !userConfig.credentials) {
      normalized.credentials = {
        meeting: {
          clientId: userConfig.clientId,
          clientSecret: userConfig.clientSecret,
          secretToken: userConfig.secretToken
        },
        videoSdk: {
          clientId: userConfig.clientId,
          clientSecret: userConfig.clientSecret,
          secretToken: userConfig.secretToken
        },
        webinar: {
          clientId: userConfig.clientId,
          clientSecret: userConfig.clientSecret,
          secretToken: userConfig.secretToken
        },
        contactCenter: {
          clientId: userConfig.clientId,
          clientSecret: userConfig.clientSecret,
          secretToken: userConfig.secretToken
        },
        phone: {
          clientId: userConfig.clientId,
          clientSecret: userConfig.clientSecret,
          secretToken: userConfig.secretToken
        }
      };
      // Remove top-level shorthand props
      delete normalized.clientId;
      delete normalized.clientSecret;
      delete normalized.secretToken;
    }
    
    // Normalize credentials structure - handle legacy naming
    if (normalized.credentials) {
      const creds = normalized.credentials;
      
      // Map legacy 'video' to 'videoSdk' with old property names
      if (creds.video && !creds.videoSdk) {
        creds.videoSdk = {
          clientId: creds.video.videoClientId || creds.video.clientId,
          clientSecret: creds.video.videoClientSecret || creds.video.clientSecret,
          secretToken: creds.video.videoSecretToken || creds.video.secretToken
        };
        delete creds.video;
      }
      
      // Map legacy 'meeting.zoomSecretToken' to 'meeting.secretToken'
      if (creds.meeting?.zoomSecretToken && !creds.meeting.secretToken) {
        creds.meeting.secretToken = creds.meeting.zoomSecretToken;
        delete creds.meeting.zoomSecretToken;
      }
      
      // Remove legacy websocket credentials (external handling now)
      delete creds.websocket;
    }
    
    // Handle legacy mediaTypesFlag -> mediaTypes
    if (normalized.mediaTypesFlag != null && normalized.mediaTypes == null) {
      normalized.mediaTypes = normalized.mediaTypesFlag;
    }
    delete normalized.mediaTypesFlag;
    
    // Remove deprecated mediaSocketConnectionMode if present (we only use split mode now)
    delete normalized.mediaSocketConnectionMode;
    
    return normalized;
  }

  /**
   * Merges user config with defaults
   * @param {Object} userConfig 
   * @returns {Object}
   */
  static merge(userConfig = {}) {
    const normalized = this.normalize(userConfig);
    return this.deepMerge(this.DEFAULTS, normalized);
  }

  /**
   * Get credentials for a specific product type
   * @param {string} productType - 'meeting' | 'videoSdk' | 'webinar' | 'contactCenter' | 'phone'
   * @param {Object} config - Merged config object
   * @returns {Object} { clientId, clientSecret, secretToken }
   */
  static getCredentialsForProduct(productType, config) {
    // Map legacy product type names
    const productMap = {
      'session': 'videoSdk',
      'video': 'videoSdk'
    };
    const normalizedType = productMap[productType] || productType;
    
    // Try product-specific credentials
    const creds = config.credentials?.[normalizedType];
    if (creds?.clientId) {
      return creds;
    }
    
    // Fall back to meeting credentials (most common)
    if (config.credentials?.meeting?.clientId) {
      return config.credentials.meeting;
    }
    
    throw new Error(`[RTMSManager] No credentials found for product: ${productType}`);
  }

  /**
   * Helper for deep merging objects
   */
  static deepMerge(target, source) {
    const output = { ...target };
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }

  static isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
  }
}

export default RTMSConfigHelper;
