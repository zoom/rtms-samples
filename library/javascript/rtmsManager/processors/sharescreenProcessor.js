/**
 * Process screen share data and emit event object
 * @param {Object} eventData - Sharescreen event data
 * @param {Buffer} eventData.buffer - Screen share buffer (JPG/PNG frames)
 * @param {string} eventData.userId - User ID
 * @param {string} eventData.userName - User name
 * @param {number} eventData.timestamp - Timestamp
 * @param {string} eventData.meetingId - Meeting/Session UUID
 * @param {string} eventData.streamId - RTMS stream ID
 * @param {string} eventData.productType - Product type (meeting, videoSdk, webinar, etc.)
 * @param {Function} emit - Event emitter function
 */
export async function processSharescreen(eventData, emit) {
  // Emit event object with all fields
  emit('sharescreen', {
    type: 'sharescreen',
    buffer: eventData.buffer,
    userId: eventData.userId,
    userName: eventData.userName,
    timestamp: eventData.timestamp,
    meetingId: eventData.meetingId,
    streamId: eventData.streamId,
    productType: eventData.productType
  });
}
