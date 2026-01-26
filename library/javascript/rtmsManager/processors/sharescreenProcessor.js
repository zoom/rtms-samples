/**
 * Process screen share data and emit event object
 * @param {Object} eventData - Sharescreen event data (DO NOT MUTATE - object is reused for performance)
 * @param {Buffer} eventData.buffer - Screen share buffer (JPG/PNG frames)
 * @param {string} eventData.userId - User ID
 * @param {string} eventData.userName - User name
 * @param {number} eventData.timestamp - Timestamp
 * @param {string} eventData.meetingId - Meeting/Session UUID
 * @param {string} eventData.streamId - RTMS stream ID
 * @param {string} eventData.productType - Product type (meeting, videoSdk, webinar, etc.)
 * @param {Function} emit - Event emitter function
 */
export function processSharescreen(eventData, emit) {
  eventData.type = 'sharescreen';
  emit('sharescreen', eventData);
}
