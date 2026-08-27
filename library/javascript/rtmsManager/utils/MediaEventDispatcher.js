const DEFAULT_MEDIA_EVENTS = new Set(['audio', 'video', 'sharescreen']);

export class MediaEventDispatcher {
  constructor({
    emit,
    logger,
    enabled = true,
    maxQueueSize = 500,
    mediaEvents = DEFAULT_MEDIA_EVENTS
  }) {
    this.emit = emit;
    this.logger = logger;
    this.enabled = enabled;
    this.maxQueueSize = Math.max(1, Number(maxQueueSize) || 500);
    this.mediaEvents = mediaEvents;
    this.queue = [];
    this.scheduled = false;
    this.stopped = false;
    this.droppedEvents = 0;
  }

  dispatch(eventName, ...args) {
    if (!this.enabled || !this.mediaEvents.has(eventName)) {
      return this.emit(eventName, ...args);
    }

    if (this.stopped) return false;

    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.droppedEvents += 1;
      if (this.droppedEvents === 1 || this.droppedEvents % 100 === 0) {
        this.logger.warn(
          `[RTMSManager] Media event queue full; dropped ${this.droppedEvents} oldest event(s)`
        );
      }
    }

    this.queue.push({ eventName, args });
    this.schedule();
    return true;
  }

  schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => this.drainOne());
  }

  drainOne() {
    this.scheduled = false;
    if (this.stopped) return;

    const item = this.queue.shift();
    if (!item) return;

    try {
      this.emit(item.eventName, ...item.args);
    } catch (error) {
      this.logger.error(
        `[RTMSManager] ${item.eventName} listener failed: ${error?.message || String(error)}`
      );
    }

    if (this.queue.length > 0) this.schedule();
  }

  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }

  get size() {
    return this.queue.length;
  }
}
