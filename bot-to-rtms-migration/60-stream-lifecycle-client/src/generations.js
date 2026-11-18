/**
 * One meeting can have several RTMS streams over its life: the app user leaves and returns,
 * the host stops and restarts, or a failed recovery needs a fresh start. Each stream has its
 * own rtms_stream_id. This index turns that into numbered generations and refuses to reuse
 * old state.
 *
 *   meeting key (tenant + product + meeting id)  ->  [ generation 1, generation 2, ... ]
 */
export function createGenerationIndex() {
  const meetings = new Map();

  function register(meetingKey, streamId) {
    const list = meetings.get(meetingKey) || [];
    const existing = list.find((g) => g.streamId === streamId);
    if (existing) return { ...existing, isNew: false };
    const open = list.find((g) => g.status === 'open');
    if (open) {
      // A new stream id while the old one is open means the old one is gone. Close it explicitly.
      open.status = 'superseded';
    }
    const entry = { generation: list.length + 1, streamId, previousStreamId: list.at(-1)?.streamId || null, status: 'open', openedAt: Date.now() };
    list.push(entry);
    meetings.set(meetingKey, list);
    return { ...entry, isNew: true };
  }

  function close(meetingKey, streamId, outcome = 'finalized') {
    const entry = (meetings.get(meetingKey) || []).find((g) => g.streamId === streamId);
    if (!entry) return false;
    entry.status = outcome;
    entry.closedAt = Date.now();
    return true;
  }

  const generations = (meetingKey) => (meetings.get(meetingKey) || []).map((g) => ({ ...g }));
  return { register, close, generations };
}
