/**
 * Keeps the latest text of each RTMS transcript sentence (transcript rewind).
 *
 * RTMS can send a sentence and later a correction for it. The correction carries
 * `attribute: 2` (`isUpdate: true`), the same `sentence_id`, and the full
 * replacement text, so it must replace the earlier line instead of appending.
 *
 * Sentences are keyed by (streamId, channelId or userId, sentenceId). Sentence IDs
 * are not unique across Phone channels, and 0 is a valid ID.
 */
export class TranscriptRevisionStore {
  #sentences = new Map();
  #order = 0;

  get size() {
    return this.#sentences.size;
  }

  /**
   * Add or replace a sentence from a `transcript` event.
   * @returns {{ action: 'new'|'updated'|'recovered'|'replaced', key: string, sentence: object }}
   *   `updated`: a revision replaced a known sentence.
   *   `recovered`: a revision arrived for an unknown sentence (for example after a reconnect).
   *   `replaced`: a non-revision packet reused a known sentence ID.
   */
  apply(event = {}) {
    const streamId = event.streamId ?? event.rtmsId ?? event.meetingId ?? null;
    const speaker = event.channelId ?? event.userId ?? null;
    const sentenceId = event.sentenceId ?? null;
    const isUpdate = event.isUpdate === true || Number(event.attribute) === 2;
    const sentence = {
      streamId,
      rtmsId: event.rtmsId ?? event.meetingId ?? null,
      channelId: event.channelId ?? null,
      userId: event.userId ?? null,
      userName: event.userName ?? null,
      sentenceId,
      text: String(event.text ?? ''),
      language: event.language ?? null,
      startTime: event.startTime ?? null,
      endTime: event.endTime ?? null,
      timestamp: event.timestamp ?? null,
      revision: 0
    };

    // Without a sentence ID there is nothing to revise; keep it as a new line.
    if (sentenceId == null) {
      const key = `${streamId}:${speaker}:#${this.#order}`;
      sentence.order = this.#order++;
      this.#sentences.set(key, sentence);
      return { action: 'new', key, sentence };
    }

    const key = `${streamId}:${speaker}:${sentenceId}`;
    const previous = this.#sentences.get(key);
    if (previous) {
      sentence.order = previous.order;
      sentence.revision = previous.revision + 1;
      // A revision may omit timing; keep the original position in that case.
      sentence.startTime ??= previous.startTime;
      sentence.endTime ??= previous.endTime;
    } else {
      sentence.order = this.#order++;
    }
    this.#sentences.set(key, sentence);

    if (isUpdate) {
      return { action: previous ? 'updated' : 'recovered', key, sentence };
    }
    return { action: previous ? 'replaced' : 'new', key, sentence };
  }

  get(key) {
    return this.#sentences.get(key);
  }

  /** Sentences ordered by start time, then arrival. Pass a streamId to filter. */
  sentences(streamId) {
    return Array.from(this.#sentences.values())
      .filter((sentence) => streamId === undefined || sentence.streamId === streamId)
      .sort((a, b) => (a.startTime ?? a.timestamp ?? 0) - (b.startTime ?? b.timestamp ?? 0) || a.order - b.order);
  }

  /** Remove every sentence, or only those of one stream (call on stream stop). */
  clear(streamId) {
    if (streamId === undefined) {
      this.#sentences.clear();
      return;
    }
    for (const [key, sentence] of this.#sentences) {
      if (sentence.streamId === streamId) this.#sentences.delete(key);
    }
  }
}
