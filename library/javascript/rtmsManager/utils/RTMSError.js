/**
 * RTMSError - Developer-friendly error class for RTMS operations
 * 
 * Provides:
 * - Clear error codes mapped to Zoom status codes
 * - Possible causes for the error
 * - Actionable fixes
 * - Links to relevant documentation
 */

// Zoom RTMS status codes mapped to helpful error information
const ZOOM_STATUS_CODES = {
  0: { code: 'SUCCESS', message: 'Success', category: 'success' },
  1: { code: 'STATUS_INVALID_MESSAGE_TYPE', message: 'Invalid message type', category: 'request' },
  2: { code: 'STATUS_INVALID_RTMS_STREAM_ID', message: 'Invalid RTMS stream ID', category: 'stream' },
  3: { code: 'STATUS_INVALID_SIGNATURE', message: 'Invalid signature', category: 'auth' },
  4: { code: 'STATUS_INVALID_PAYLOAD', message: 'Invalid payload', category: 'request' },
  5: { code: 'STATUS_INVALID_EVENTS', message: 'Invalid events array', category: 'request' },
  6: { code: 'STATUS_INVALID_EVENT_TYPE', message: 'Invalid event type', category: 'request' },
  7: { code: 'STATUS_INVALID_MEDIA_TYPE', message: 'Invalid media type', category: 'request' },
  8: {
    code: 'STATUS_DUPLICATE_SIGNAL_REQUEST',
    message: 'Duplicate signaling connection request',
    category: 'connection',
    causes: [
      'Another signaling connection for the same stream is still active',
      'The previous signaling socket has not fully closed yet',
      'Zoom retried the RTMS start flow while the old signaling connection was still shutting down'
    ],
    fixes: [
      'Ensure only one signaling connection exists per RTMS stream',
      'Wait for the previous signaling socket to fully close before reconnecting',
      'Acknowledge webhook events immediately to avoid duplicate startup races'
    ]
  },
  9: { code: 'STATUS_MEDIA_TYPE_AUDIO_NOT_SUPPORT', message: 'Audio media type is not supported', category: 'media' },
  10: { code: 'STATUS_MEDIA_TYPE_VIDEO_NOT_SUPPORT', message: 'Video media type is not supported', category: 'media' },
  11: { code: 'STATUS_MEDIA_TYPE_DESKSHARE_NOT_SUPPORT', message: 'Deskshare media type is not supported', category: 'media' },
  12: { code: 'STATUS_MEDIA_TYPE_TRANSCRIPT_NOT_SUPPORT', message: 'Transcript media type is not supported', category: 'media' },
  13: { code: 'STATUS_MEDIA_TYPE_CHAT_NOT_SUPPORT', message: 'Chat media type is not supported', category: 'media' },
  14: {
    code: 'STATUS_MEDIA_TYPE_INVALID_VALUE',
    message: 'media_type has an invalid RTMS bitmask value',
    category: 'request',
    causes: [
      'media_type in the RTMS data handshake is not a valid RTMS media flag or bitmask',
      'MEDIA_TYPES_FLAG is set to an unsupported value in the sample configuration'
    ],
    fixes: [
      'Use valid RTMS media flags such as 1=audio, 2=video, 4=deskshare, 8=transcript, 16=chat, or 32=all',
      'Review the top-level media_type bitmask in the data handshake payload'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/media-types/'
  },
  15: { code: 'STATUS_MEDIA_DATA_ALL_CONNECTION_EXIST', message: 'Unified media connection already exists', category: 'connection' },
  16: { code: 'STATUS_DUPLICATE_MEDIA_DATA_CONNECTION', message: 'Duplicate media data connection detected', category: 'connection' },
  17: { code: 'STATUS_INVALID_MEDIA_PARAMS', message: 'Invalid media_params payload', category: 'request' },
  18: { code: 'STATUS_INVALID_MEDIA_AUDIO_PARAMS', message: 'Invalid audio media parameters', category: 'request' },
  19: { code: 'STATUS_INVALID_MEDIA_AUDIO_CONTENT_TYPE', message: 'Invalid audio content_type', category: 'request' },
  20: { code: 'STATUS_INVALID_MEDIA_AUDIO_SAMPLE_RATE', message: 'Invalid audio sample_rate', category: 'request' },
  21: { code: 'STATUS_INVALID_MEDIA_AUDIO_CHANNEL', message: 'Invalid audio channel', category: 'request' },
  22: { code: 'STATUS_INVALID_MEDIA_AUDIO_CODEC', message: 'Invalid audio codec', category: 'request' },
  23: { code: 'STATUS_INVALID_MEDIA_AUDIO_DATA_OPT', message: 'Invalid audio data_opt', category: 'request' },
  24: { code: 'STATUS_INVALID_MEDIA_AUDIO_SEND_RATE', message: 'Invalid audio send_rate', category: 'request' },
  25: { code: 'STATUS_INVALID_MEDIA_VIDEO_PARAMS', message: 'Invalid video media parameters', category: 'request' },
  26: { code: 'STATUS_INVALID_MEDIA_VIDEO_CONTENT_TYPE', message: 'Invalid video content_type', category: 'request' },
  27: { code: 'STATUS_INVALID_MEDIA_VIDEO_CODEC', message: 'Invalid video codec', category: 'request' },
  28: { code: 'STATUS_INVALID_MEDIA_VIDEO_RESOLUTION', message: 'Invalid video resolution', category: 'request' },
  29: {
    code: 'STATUS_INVALID_MEDIA_VIDEO_DATA_OPT',
    message: 'Invalid video data_opt',
    category: 'request',
    causes: [
      'The video data_opt value in the data handshake is not supported by the RTMS server build',
      'The client is using the wrong numeric value for VIDEO_SINGLE_INDIVIDUAL_STREAM',
      'The selected video mode is not compatible with the current RTMS deployment'
    ],
    fixes: [
      'Verify video.data_opt matches the RTMS protocol definition used by your server build',
      'For single participant video, use VIDEO_SINGLE_INDIVIDUAL_STREAM = 4',
      'If active-stream video works but individual video fails, focus on video.data_opt instead of media_type'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/media-parameter-definition/'
  },
  30: { code: 'STATUS_INVALID_MEDIA_VIDEO_FPS', message: 'Invalid video fps', category: 'request' },
  31: { code: 'STATUS_INVALID_MEDIA_DESKSHARE_PARAMS', message: 'Invalid deskshare media parameters', category: 'request' },
  32: { code: 'STATUS_INVALID_MEDIA_DESKSHARE_CONTENT_TYPE', message: 'Invalid deskshare content_type', category: 'request' },
  33: { code: 'STATUS_INVALID_MEDIA_DESKSHARE_CODEC', message: 'Invalid deskshare codec', category: 'request' },
  34: { code: 'STATUS_INVALID_MEDIA_DESKSHARE_RESOLUTION', message: 'Invalid deskshare resolution', category: 'request' },
  35: { code: 'STATUS_INVALID_MEDIA_DESKSHARE_FPS', message: 'Invalid deskshare fps', category: 'request' },
  36: { code: 'STATUS_INVALID_MEDIA_TRANSCRIPT_PARAMS', message: 'Invalid transcript media parameters', category: 'request' },
  37: { code: 'STATUS_INVALID_MEDIA_TRANSCRIPT_CONTENT_TYPE', message: 'Invalid transcript content_type', category: 'request' },
  38: { code: 'STATUS_INVALID_MEDIA_CHAT_PARAMS', message: 'Invalid chat media parameters', category: 'request' },
  39: { code: 'STATUS_INVALID_MEDIA_CHAT_CONTENT_TYPE', message: 'Invalid chat content_type', category: 'request' },
  40: { code: 'STATUS_INVALID_RTMS_SESSION_ID', message: 'Invalid RTMS session ID', category: 'stream' },
  41: { code: 'STATUS_INVALID_CLIENT_READY_ACK', message: 'Invalid client ready acknowledgment', category: 'request' },
  42: { code: 'STATUS_INVALID_EVENT_SUBSCRIBE', message: 'Invalid event subscribe payload', category: 'request' },
  43: { code: 'STATUS_INVALID_MEDIA_TRANSCRIPT_SROUCE_LANGUAGE', message: 'Invalid transcript src_language', category: 'request' },
};

// Error causes and fixes by category
const ERROR_GUIDANCE = {
  auth: {
    causes: [
      'clientSecret does not match clientId',
      'Using Meeting SDK credentials for Video SDK (or vice versa)',
      'Credentials were regenerated but not updated in your app',
      'Clock skew between your server and Zoom servers'
    ],
    fixes: [
      'Verify clientId and clientSecret match in Zoom Marketplace -> App Credentials',
      'For Video SDK: use Video SDK app credentials, not Meeting SDK',
      'Check .env file has no extra spaces around values',
      'Ensure your server time is synchronized (use NTP)'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/auth/'
  },
  meeting: {
    causes: [
      'Meeting has already ended',
      'Meeting UUID format is incorrect',
      'Meeting was deleted or never existed',
      'Using a meeting ID instead of meeting UUID'
    ],
    fixes: [
      'Use the meeting_uuid from the webhook, not the meeting ID',
      'Ensure the meeting is still active when connecting',
      'Check that the webhook payload is being parsed correctly'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/webhooks/'
  },
  stream: {
    causes: [
      'Stream has already been stopped',
      'Stream ID was not found in active streams',
      'Using an old stream ID from a previous session'
    ],
    fixes: [
      'Use the rtms_stream_id from the current webhook event',
      'Handle rtms_stopped webhooks to clean up stream references',
      'Check stream lifecycle in your application logic'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/stream-lifecycle/'
  },
  permission: {
    causes: [
      'RTMS is not enabled for this Zoom account',
      'App does not have RTMS scopes',
      'Meeting host has not granted RTMS permission',
      'Account-level RTMS feature is disabled',
      'Another RTMS signaling connection for this meeting or stream is still shutting down',
      'RTMS start event arrived before the signaling server was fully ready'
    ],
    fixes: [
      'Enable RTMS in Zoom Admin Portal -> Account Settings',
      'Add RTMS scopes to your app in Zoom Marketplace',
      'Ensure meeting host allows real-time media streaming',
      'Ensure previous RTMS signaling sockets are fully closed before reconnecting',
      'Allow a short retry window after the rtms_started event before treating the failure as permanent',
      'Contact Zoom support if account-level feature is needed'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/prerequisites/'
  },
  network: {
    causes: [
      'Network connection was interrupted',
      'Firewall blocking WebSocket connections',
      'DNS resolution failed',
      'Zoom server region is unreachable'
    ],
    fixes: [
      'Check network connectivity to Zoom servers',
      'Allow outbound WebSocket connections (wss://) on port 443',
      'Verify DNS can resolve *.zoom.us domains',
      'Try connecting from a different network'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/troubleshooting/'
  },
  server: {
    causes: [
      'Zoom RTMS service is experiencing issues',
      'Temporary server overload',
      'Maintenance window in progress'
    ],
    fixes: [
      'Check Zoom status page: https://status.zoom.us',
      'Implement exponential backoff retry logic',
      'Wait a few minutes and try again'
    ],
    docsUrl: 'https://status.zoom.us'
  },
  limit: {
    causes: [
      'Too many API requests in a short time',
      'Maximum concurrent connections reached',
      'Account-level rate limit exceeded'
    ],
    fixes: [
      'Implement rate limiting in your application',
      'Use exponential backoff for retries',
      'Reduce connection frequency or batch requests'
    ],
    docsUrl: 'https://developers.zoom.us/docs/api/rate-limits/'
  },
  media: {
    causes: [
      'Requested media type is not being shared in the meeting',
      'Participant has not enabled video/audio',
      'Screen sharing has not started'
    ],
    fixes: [
      'Check which media types are available in the meeting',
      'Subscribe only to media types that are active',
      'Handle SHARING_START/SHARING_STOP events'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/media-types/'
  },
  protocol: {
    causes: [
      'RTMS protocol version mismatch',
      'Using outdated SDK version',
      'Incompatible message format'
    ],
    fixes: [
      'Update to the latest rtms-manager-dev version',
      'Check for breaking changes in release notes',
      'Ensure message payloads match expected format'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/changelog/'
  },
  security: {
    causes: [
      'Encryption key mismatch',
      'Payload decryption failed',
      'Security certificate issue'
    ],
    fixes: [
      'Verify clientSecret is correct',
      'Check that payload is not being modified in transit',
      'Ensure TLS certificates are valid'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/security/'
  },
  connection: {
    causes: [
      'Another connection with same credentials already exists',
      'Previous connection was not properly closed',
      'Reconnecting too quickly after disconnect'
    ],
    fixes: [
      'Ensure only one connection per stream ID',
      'Properly close connections before reconnecting',
      'Add a delay before reconnection attempts'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/connection-management/'
  },
  request: {
    causes: [
      'Missing required parameter',
      'Invalid parameter format',
      'Unexpected parameter value'
    ],
    fixes: [
      'Check all required parameters are provided',
      'Verify parameter formats match documentation',
      'Review the full request payload for issues'
    ],
    docsUrl: 'https://developers.zoom.us/docs/rtms/api-reference/'
  }
};

// SDK-level error codes (not from Zoom)
const SDK_ERROR_CODES = {
  NOT_INITIALIZED: {
    code: 'NOT_INITIALIZED',
    message: 'RTMSManager.init() must be called before using the SDK',
    category: 'sdk',
    causes: ['RTMSManager.init() was not called', 'init() failed silently'],
    fixes: ['Call await RTMSManager.init({...}) before using other methods'],
    docsUrl: 'https://developers.zoom.us/docs/rtms/quickstart/'
  },
  MISSING_CREDENTIALS: {
    code: 'MISSING_CREDENTIALS',
    message: 'Missing required credentials',
    category: 'config',
    causes: ['clientId, clientSecret, or secretToken not provided', 'Credentials object is empty'],
    fixes: ['Provide all required credentials in init() config', 'Check your .env file is loaded'],
    docsUrl: 'https://developers.zoom.us/docs/rtms/configuration/'
  },
  INVALID_CONFIG: {
    code: 'INVALID_CONFIG',
    message: 'Invalid configuration',
    category: 'config',
    causes: ['Configuration object has invalid values', 'mediaTypes value is out of range'],
    fixes: ['Review configuration options in documentation', 'Use RTMSManager.MEDIA.* constants'],
    docsUrl: 'https://developers.zoom.us/docs/rtms/configuration/'
  },
  CONNECTION_FAILED: {
    code: 'CONNECTION_FAILED',
    message: 'Failed to establish WebSocket connection',
    category: 'network',
    causes: ['Network connectivity issue', 'Firewall blocking connection', 'Invalid server URL'],
    fixes: ['Check network connectivity', 'Allow wss:// connections to *.zoom.us'],
    docsUrl: 'https://developers.zoom.us/docs/rtms/troubleshooting/'
  },
  SIGNALING_ERROR: {
    code: 'SIGNALING_ERROR',
    message: 'Signaling socket error',
    category: 'connection',
    causes: ['Signaling connection dropped', 'Server rejected connection'],
    fixes: ['Check credentials are correct', 'Verify meeting is still active'],
    docsUrl: 'https://developers.zoom.us/docs/rtms/signaling/'
  },
  MEDIA_ERROR: {
    code: 'MEDIA_ERROR',
    message: 'Media socket error',
    category: 'media',
    causes: ['Media connection dropped', 'Media type not available'],
    fixes: ['Check requested media types are being shared', 'Handle media availability events'],
    docsUrl: 'https://developers.zoom.us/docs/rtms/media/'
  }
};

/**
 * RTMSError - Enhanced error class for RTMS operations
 */
export class RTMSError extends Error {
  /**
   * @param {string} code - Error code (e.g., 'INVALID_SIGNATURE', 'CONNECTION_FAILED')
   * @param {string} [message] - Optional custom message (uses default if not provided)
   * @param {Object} [options] - Additional options
   * @param {number} [options.zoomStatus] - Zoom status code if applicable
   * @param {string} [options.meetingId] - Meeting/session UUID
   * @param {string} [options.streamId] - RTMS stream ID
   * @param {Error} [options.cause] - Original error that caused this
   */
  constructor(code, message, options = {}) {
    // Look up error info from Zoom status codes or SDK codes
    let errorInfo;
    
    if (options.zoomStatus !== undefined && ZOOM_STATUS_CODES[options.zoomStatus]) {
      errorInfo = ZOOM_STATUS_CODES[options.zoomStatus];
    } else if (SDK_ERROR_CODES[code]) {
      errorInfo = SDK_ERROR_CODES[code];
    } else {
      errorInfo = { code, message: message || 'Unknown error', category: 'unknown' };
    }
    
    const finalMessage = message || errorInfo.message;
    super(finalMessage);
    
    this.name = 'RTMSError';
    this.code = errorInfo.code || code;
    this.category = errorInfo.category;
    this.zoomStatus = options.zoomStatus;
    this.meetingId = options.meetingId;
    this.streamId = options.streamId;
    this.originalError = options.cause;
    
    // Get guidance for this error category
    const guidance = ERROR_GUIDANCE[this.category] || {
      causes: ['Unknown error occurred'],
      fixes: ['Check logs for more details', 'Report issue at https://github.com/zoom/rtms-samples/issues'],
      docsUrl: 'https://developers.zoom.us/docs/rtms/'
    };
    
    // Use custom causes/fixes if provided in SDK_ERROR_CODES, otherwise use category guidance
    this.causes = errorInfo.causes || guidance.causes;
    this.fixes = errorInfo.fixes || guidance.fixes;
    this.docsUrl = errorInfo.docsUrl || guidance.docsUrl;
    
    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RTMSError);
    }
  }
  
  /**
   * Create RTMSError from Zoom status code
   * @param {number} statusCode - Zoom status code
   * @param {Object} [context] - Additional context (meetingId, streamId)
   */
  static fromZoomStatus(statusCode, context = {}) {
    const info = ZOOM_STATUS_CODES[statusCode];
    if (!info) {
      return new RTMSError('UNKNOWN_STATUS', `Unknown Zoom status code: ${statusCode}`, {
        zoomStatus: statusCode,
        ...context
      });
    }
    return new RTMSError(info.code, info.message, {
      zoomStatus: statusCode,
      ...context
    });
  }
  
  /**
   * Create RTMSError from SDK error code
   * @param {string} code - SDK error code (e.g., 'NOT_INITIALIZED')
   * @param {Object} [context] - Additional context
   */
  static fromCode(code, context = {}) {
    return new RTMSError(code, null, context);
  }
  
  /**
   * Pretty-print the error with causes and fixes
   */
  toString() {
    const lines = [
      '============================================================',
      `RTMSError: ${this.message}`,
      '============================================================',
      ''
    ];
    
    // Code and category
    let codeStr = `   Code: ${this.code}`;
    if (this.zoomStatus !== undefined) {
      codeStr += ` (Zoom status: ${this.zoomStatus})`;
    }
    lines.push(codeStr);
    lines.push(`   Category: ${this.category}`);
    
    // Context
    if (this.meetingId) {
      lines.push(`   Meeting: ${this.meetingId}`);
    }
    if (this.streamId) {
      lines.push(`   Stream: ${this.streamId}`);
    }
    
    // Causes
    if (this.causes && this.causes.length > 0) {
      lines.push('');
      lines.push('   Possible causes:');
      this.causes.forEach((cause, i) => {
        lines.push(`   ${i + 1}. ${cause}`);
      });
    }
    
    // Fixes
    if (this.fixes && this.fixes.length > 0) {
      lines.push('');
      lines.push('   How to fix:');
      this.fixes.forEach((fix, i) => {
        lines.push(`   ${i + 1}. ${fix}`);
      });
    }
    
    // Docs link
    if (this.docsUrl) {
      lines.push('');
      lines.push(`   Docs: ${this.docsUrl}`);
    }
    
    // Unknown error notice
    if (this.category === 'unknown') {
      lines.push('');
      lines.push('   If this error is unclear, please report it at:');
      lines.push('   https://github.com/zoom/rtms-samples/issues');
    }
    
    lines.push('============================================================');
    
    return lines.join('\n');
  }
  
  /**
   * Get a short summary suitable for logging
   */
  toShortString() {
    let str = `[${this.code}] ${this.message}`;
    if (this.zoomStatus !== undefined) {
      str += ` (status: ${this.zoomStatus})`;
    }
    return str;
  }
  
  /**
   * Convert to plain object for JSON serialization
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      category: this.category,
      zoomStatus: this.zoomStatus,
      meetingId: this.meetingId,
      streamId: this.streamId,
      causes: this.causes,
      fixes: this.fixes,
      docsUrl: this.docsUrl
    };
  }
}

// Export lookup tables for external use
export { ZOOM_STATUS_CODES, SDK_ERROR_CODES, ERROR_GUIDANCE };

export default RTMSError;
