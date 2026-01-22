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
  1: { code: 'INVALID_SIGNATURE', message: 'Signature validation failed', category: 'auth' },
  2: { code: 'INVALID_CLIENT_ID', message: 'Invalid client ID', category: 'auth' },
  3: { code: 'INVALID_MEETING_UUID', message: 'Invalid meeting UUID', category: 'meeting' },
  4: { code: 'INVALID_STREAM_ID', message: 'Invalid stream ID', category: 'stream' },
  5: { code: 'MEETING_NOT_FOUND', message: 'Meeting not found or ended', category: 'meeting' },
  6: { code: 'STREAM_NOT_FOUND', message: 'Stream not found', category: 'stream' },
  7: { code: 'INVALID_PARAMETER', message: 'Invalid parameter in request', category: 'request' },
  8: { code: 'PERMISSION_DENIED', message: 'Permission denied - RTMS not enabled', category: 'permission' },
  9: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limit exceeded', category: 'limit' },
  10: { code: 'SERVER_ERROR', message: 'Zoom server error', category: 'server' },
  11: { code: 'SERVICE_UNAVAILABLE', message: 'RTMS service temporarily unavailable', category: 'server' },
  12: { code: 'TIMEOUT', message: 'Request timed out', category: 'network' },
  13: { code: 'CONNECTION_CLOSED', message: 'Connection closed unexpectedly', category: 'network' },
  14: { code: 'PROTOCOL_ERROR', message: 'Protocol version mismatch', category: 'protocol' },
  15: { code: 'HANDSHAKE_FAILED', message: 'Handshake failed - authentication rejected', category: 'auth' },
  16: { code: 'MEDIA_NOT_AVAILABLE', message: 'Requested media type not available', category: 'media' },
  17: { code: 'ENCRYPTION_ERROR', message: 'Encryption/decryption failed', category: 'security' },
  18: { code: 'INVALID_TOKEN', message: 'Invalid or expired access token', category: 'auth' },
  19: { code: 'DUPLICATE_CONNECTION', message: 'Duplicate connection detected', category: 'connection' },
  20: { code: 'MAX_CONNECTIONS', message: 'Maximum connections reached', category: 'limit' },
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
      'Account-level RTMS feature is disabled'
    ],
    fixes: [
      'Enable RTMS in Zoom Admin Portal -> Account Settings',
      'Add RTMS scopes to your app in Zoom Marketplace',
      'Ensure meeting host allows real-time media streaming',
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
