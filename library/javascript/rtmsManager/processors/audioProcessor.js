export async function processAudio(buffer, userId, userName, timestamp, rtmsId, streamId, emit, rtmsType, audioFiller = null) {
  if (audioFiller) {
    audioFiller.processBuffer(buffer, timestamp);
  } else {
    emit('audio', buffer, userId, userName, timestamp, rtmsId, streamId, rtmsType);
  }
}
