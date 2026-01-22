export async function processSharescreen(buffer, userId, userName, timestamp, rtmsId, streamId, emit, rtmsType) {
  emit('sharescreen', buffer, userId, userName, timestamp, rtmsId, streamId, rtmsType);
}
