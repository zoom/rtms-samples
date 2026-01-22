export async function processVideo(buffer, userId, userName, timestamp, rtmsId, streamId, emit, rtmsType, videoFiller = null) {
  if (videoFiller) {
    videoFiller.processBuffer(buffer, timestamp);
  } else {
    emit('video', buffer, userId, userName, timestamp, rtmsId, streamId, rtmsType);
  }
}
