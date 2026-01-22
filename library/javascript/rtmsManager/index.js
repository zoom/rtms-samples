/**
 * RTMSManager v2.0.0 - Developer-friendly Zoom RTMS SDK
 * 
 * @example
 * ```javascript
 * import { RTMSManager } from 'rtms-manager-dev';
 * 
 * await RTMSManager.init({
 *   credentials: {
 *     meeting: { clientId: '...', clientSecret: '...', secretToken: '...' }
 *   },
 *   mediaTypes: RTMSManager.MEDIA.AUDIO | RTMSManager.MEDIA.TRANSCRIPT
 * });
 * 
 * RTMSManager.on('audio', ({ buffer, userName }) => {
 *   console.log(`Audio from ${userName}: ${buffer.length} bytes`);
 * });
 * 
 * RTMSManager.on('error', (error) => {
 *   console.error(error.toString()); // Pretty-printed error with causes and fixes
 * });
 * ```
 */

// Main class
export { RTMSManager } from './RTMSManager.js';

// Error class
export { RTMSError, ZOOM_STATUS_CODES, SDK_ERROR_CODES } from './utils/RTMSError.js';

// Utilities
export { FileLogger } from './utils/FileLogger.js';
export { RTMSConfigHelper } from './utils/RTMSConfigHelper.js';
export { RTMS_MEDIA_PARAMS } from './utils/rtmsMediaParams.js';
export { RTMSFlagHelper, TYPE_FLAGS } from './utils/RTMSFlagHelper.js';

// Lookup helpers
export {
  getRtmsSessionState,
  getRtmsStreamState,
  getRtmsStopReason,
  getRtmsStatusCode,
  getHandshakeResponse
} from './utils/rtmsEventLookupHelper.js';

// Connection manager
export { ActiveConnectionManager } from './ActiveConnectionManager.js';

// Message handlers
export { RTMSMessageHandler } from './RTMSMessageHandler.js';

// Default export
export { RTMSManager as default } from './RTMSManager.js';
