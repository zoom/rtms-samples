/**
 * Process audio data and emit event object
 * @param {Object} eventData - Audio event data
 * @param {Buffer} eventData.buffer - Audio buffer
 * @param {string} eventData.userId - User ID
 * @param {string} eventData.userName - User name
 * @param {number} eventData.timestamp - Timestamp
 * @param {string} eventData.meetingId - Meeting/Session UUID
 * @param {string} eventData.streamId - RTMS stream ID
 * @param {string} eventData.productType - Product type (meeting, videoSdk, webinar, etc.)
 * @param {Function} emit - Event emitter function
 * @param {Object} [audioFiller] - Optional audio filler for gap filling
 */
export function processAudio(eventData, emit, audioFiller = null) {
  if (audioFiller) {
    audioFiller.processBuffer(eventData.buffer, eventData.timestamp);
  } else {
    // Emit event object with all fields
    emit('audio', {
      type: 'audio',
      buffer: eventData.buffer,
      userId: eventData.userId,
      userName: eventData.userName,
      timestamp: eventData.timestamp,
      meetingId: eventData.meetingId,
      streamId: eventData.streamId,
      productType: eventData.productType
    });
  }
}
