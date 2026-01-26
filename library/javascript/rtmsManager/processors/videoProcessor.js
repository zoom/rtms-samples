/**
 * Process video data and emit event object
 * @param {Object} eventData - Video event data (DO NOT MUTATE - object is reused for performance)
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
export function processVideo(eventData, emit, videoFiller = null) {
  if (videoFiller) {
    videoFiller.processBuffer(eventData.buffer, eventData.timestamp);
  } else {
    // Reuse eventData object to reduce GC pressure (avoid creating duplicate object)
    eventData.type = 'video';
    emit('video', eventData);
  }
}
