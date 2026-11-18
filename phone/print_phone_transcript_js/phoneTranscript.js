/**
 * Keeps the latest text of each Zoom Phone transcript sentence.
 *
 * Phone RTMS sends attribute 1 for a new sentence and attribute 2 with the full
 * replacement text for the same (channel_id, sentence_id). Sentence IDs are not
 * unique across channels, and 0 is a valid ID.
 */
export class PhoneTranscript {
  #sentences = new Map();

  get size() {
    return this.#sentences.size;
  }

  apply(event) {
    const sentenceId = event.sentenceId ?? null;
    const sentence = {
      channelId: event.channelId ?? event.userId ?? null,
      sentenceId,
      speaker: event.userName ?? null,
      text: String(event.text ?? ''),
      language: event.language ?? null,
      startTime: event.startTime ?? null,
      endTime: event.endTime ?? null,
      timestamp: event.timestamp ?? null
    };

    // Without a sentence ID there is nothing to revise; keep it as a new line.
    if (sentenceId == null) {
      this.#sentences.set(Symbol('sentence'), sentence);
      return { action: 'new', sentence };
    }

    const key = `${sentence.channelId}:${sentenceId}`;
    const existed = this.#sentences.has(key);
    this.#sentences.set(key, sentence);

    if (event.isUpdate) {
      // An update for an unknown sentence can follow a reconnect; keep it.
      return { action: existed ? 'updated' : 'recovered', sentence };
    }
    return { action: existed ? 'replaced' : 'new', sentence };
  }

  /** Sentences ordered by audio start time. */
  sentences() {
    return Array.from(this.#sentences.values())
      .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
  }
}
