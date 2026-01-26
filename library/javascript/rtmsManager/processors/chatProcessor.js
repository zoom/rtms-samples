/**
 * Process chat data and emit event object
 * @param {Object} eventData - Chat event data (DO NOT MUTATE - object is reused for performance)
 * @param {string} eventData.text - Chat message text
 * @param {string} eventData.userId - User ID
 * @param {string} eventData.userName - User name
 * @param {number} eventData.timestamp - Timestamp
 * @param {string} eventData.meetingId - Meeting/Session UUID
 * @param {string} eventData.streamId - RTMS stream ID
 * @param {string} eventData.productType - Product type (meeting, videoSdk, webinar, etc.)
 * @param {Function} emit - Event emitter function
 */
export function processChat(eventData, emit) {
  eventData.type = 'chat';
  emit('chat', eventData);
}
