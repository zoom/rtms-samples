/**
 * Process chat data and emit event object
 * @param {Object} eventData - Chat event data
 * @param {string} eventData.text - Chat message text
 * @param {string} eventData.userId - User ID
 * @param {string} eventData.userName - User name
 * @param {number} eventData.timestamp - Timestamp
 * @param {string} eventData.meetingId - Meeting/Session UUID
 * @param {string} eventData.streamId - RTMS stream ID
 * @param {string} eventData.productType - Product type (meeting, videoSdk, webinar, etc.)
 * @param {Function} emit - Event emitter function
 */
export async function processChat(eventData, emit) {
  // Emit event object with all fields
  emit('chat', {
    type: 'chat',
    text: eventData.text,
    userId: eventData.userId,
    userName: eventData.userName,
    timestamp: eventData.timestamp,
    meetingId: eventData.meetingId,
    streamId: eventData.streamId,
    productType: eventData.productType
  });
}
