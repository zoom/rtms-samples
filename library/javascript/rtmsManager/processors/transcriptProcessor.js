export async function processTranscript(data, userId, userName, timestamp, rtmsId, streamId, emit, rtmsType, start_time, end_time, language, attribute) {
  emit('transcript', data, userId, userName, timestamp, rtmsId, streamId, rtmsType, start_time, end_time, language, attribute);
}
