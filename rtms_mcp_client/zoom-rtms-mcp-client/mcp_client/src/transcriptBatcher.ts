type Batch = { text: string; timer: NodeJS.Timeout };

export class TranscriptBatcher {
  private readonly batches = new Map<string, Batch>();

  constructor(private readonly config: {
    windowMs: number;
    maxCharacters: number;
    onFlush: (streamId: string, text: string) => Promise<void>;
  }) {}

  add(streamId: string, text: string): void {
    const cleanText = text.trim();
    if (!cleanText) return;
    const existing = this.batches.get(streamId);
    if (existing) {
      existing.text = `${existing.text} ${cleanText}`.slice(0, this.config.maxCharacters);
      if (existing.text.length >= this.config.maxCharacters) void this.flush(streamId);
      return;
    }

    const timer = setTimeout(() => void this.flush(streamId), this.config.windowMs);
    timer.unref?.();
    this.batches.set(streamId, { text: cleanText.slice(0, this.config.maxCharacters), timer });
  }

  async flush(streamId: string): Promise<void> {
    const batch = this.batches.get(streamId);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(streamId);
    await this.config.onFlush(streamId, batch.text);
  }

  discard(streamId: string): void {
    const batch = this.batches.get(streamId);
    if (batch) clearTimeout(batch.timer);
    this.batches.delete(streamId);
  }

  stop(): void {
    for (const streamId of this.batches.keys()) this.discard(streamId);
  }
}
