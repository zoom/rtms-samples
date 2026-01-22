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
   * @param {number} requestedFlags - The requested media types flag (e.g. 32 for ALL)
   * @param {Object} serverUrls - The server_urls object from the handshake response
   * @returns {number} The effective flags to use for connection
   */
  static calculateEffectiveFlags(requestedFlags, serverUrls = {}) {
    // If not requesting "ALL" (32), return requested flags
    if (requestedFlags !== 32) {
      return requestedFlags;
    }

    // If requesting "ALL", calculate based on what the server actually provides
    let effectiveFlags = 0;
    for (const [type, flag] of Object.entries(TYPE_FLAGS)) {
      // Check if the specific media type URL exists in the server response
      if (serverUrls[type]) {
        effectiveFlags |= flag;
      }
    }
    
    return effectiveFlags;
  }
}
