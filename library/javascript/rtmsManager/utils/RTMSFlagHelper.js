export const TYPE_FLAGS = {
  audio: 1,
  video: 2,
  sharescreen: 4,
  transcript: 8,
  chat: 16
};

export class RTMSFlagHelper {
  /**
   * Calculate effective media flags based on requested flags and available server URLs
   * @param {number} requestedFlags - Combined concrete media type flags
   * @param {Object|string} serverUrls - server_urls from the handshake response.
   *   Usually an object keyed by media type; V2 may also return one
   *   comma-separated string that serves every media type.
   * @returns {number} The effective flags to use for connection
   */
  static calculateEffectiveFlags(requestedFlags, serverUrls = {}) {
    if (typeof serverUrls === 'string') {
      return serverUrls.trim() ? (requestedFlags & 31) : 0;
    }
    if (!serverUrls || typeof serverUrls !== 'object') {
      return 0;
    }
    let effectiveFlags = 0;
    for (const [type, flag] of Object.entries(TYPE_FLAGS)) {
      if ((requestedFlags & flag) && serverUrls[type]) {
        effectiveFlags |= flag;
      }
    }
    
    return effectiveFlags;
  }
}
