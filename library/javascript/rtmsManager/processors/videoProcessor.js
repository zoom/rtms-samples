/**
 * Process video data and emit event object
 * @param {Object} eventData - Video event data
 * @param {Buffer} eventData.buffer - Video buffer (H264/JPG frames)
 * @param {string} eventData.userId - User ID
 * @param {string} eventData.userName - User name
 * @param {number} eventData.timestamp - Timestamp
 * @param {string} eventData.meetingId - Meeting/Session UUID
 * @param {string} eventData.streamId - RTMS stream ID
 * @param {string} eventData.productType - Product type (meeting, videoSdk, webinar, etc.)
 * @param {Function} emit - Event emitter function
 * @param {Object} [videoFiller] - Optional video filler for gap filling
 */
export async function processVideo(eventData, emit, videoFiller = null) {
  if (videoFiller) {
    videoFiller.processBuffer(eventData.buffer, eventData.timestamp);
  } else {
    // Emit event object with all fields
    emit('video', {
      type: 'video',
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
