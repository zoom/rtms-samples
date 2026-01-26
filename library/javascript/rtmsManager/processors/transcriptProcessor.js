export function processTranscript(eventData, emit) {
  eventData.type = 'transcript';
  emit('transcript', eventData);
}
