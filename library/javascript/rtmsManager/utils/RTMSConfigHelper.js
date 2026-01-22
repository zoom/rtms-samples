export class RTMSConfigHelper {
  /**
   * Default configuration for RTMS Manager
   */
  static get DEFAULTS() {
    return {
      port: 3000,
      managerType: 'none', // 'webhook', 'websocket', or 'none'
      mediaSocketConnectionMode: 'split',
      mediaTypesFlag: 32, // Default all
      enableRealTimeAudioVideoGapFiller: false,
      enableGapFilling: false,
      maxStreamHistorySize: 100, // Maximum number of archived streams to keep in memory
      credentials: {
        meeting: {
          clientId: null,
          clientSecret: null,
          zoomSecretToken: null,
        },
        video: {
          videoClientId: null,
          videoClientSecret: null,
          videoSecretToken: null,
        },
        s2s: {
          clientId: null,
          clientSecret: null,
          accountId: null,
        },
        websocket: {
          zoomWSURLForEvents: '',
          clientId: null,
          clientSecret: null,
        }
      },
      useFiller: false,
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
   * Merges user config with defaults
   * @param {Object} userConfig 
   * @returns {Object}
   */
  static merge(userConfig = {}) {
    return this.deepMerge(this.DEFAULTS, userConfig);
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
