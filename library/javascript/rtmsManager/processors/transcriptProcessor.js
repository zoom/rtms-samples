export async function processTranscript(eventData, emit) {
  emit('transcript', {
    type: 'transcript',
    text: eventData.text,
    userId: eventData.userId,
    userName: eventData.userName,
    timestamp: eventData.timestamp,
    meetingId: eventData.meetingId,
    streamId: eventData.streamId,
    productType: eventData.productType,
    startTime: eventData.startTime,
    endTime: eventData.endTime,
    language: eventData.language,
    attribute: eventData.attribute
  });
}
