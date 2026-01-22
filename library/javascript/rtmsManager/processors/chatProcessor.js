export async function processChat(data, userId, userName, timestamp, rtmsId, streamId, emit, rtmsType) {
  emit('chat', data, userId, userName, timestamp, rtmsId, streamId, rtmsType);
}
