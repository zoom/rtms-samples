/**
 * Transcript revisions, not append-only text.
 *
 * RTMS sends the first version of a sentence with `attribute: 1` and a correction with
 * `attribute: 2`, carrying the same `sentence_id` and the full replacement text. The writer
 * keeps one line per sentence; an update replaces that line and reports the change.
 */
export function createTranscriptStore() {
  const bySentenceId = new Map();
  const lines = [];

  function parse(packet) {
    const text = packet.bytes.toString('utf8');
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' ? value : { text };
    } catch {
      return { text };
    }
  }

  function add(packet) {
    const event = parse(packet);
    const id = packet.sentenceId ?? event.sentence_id ?? event.sentenceId ?? event.id ?? null;
    const channelId = packet.channelId ?? event.channel_id ?? null;
    const key = id !== null ? (channelId !== null ? `${channelId}:${id}` : String(id)) : null;
    const attribute = Number(packet.attribute ?? event.attribute ?? 1);
    const isRevision = attribute === 2 || String(event.type || '').toUpperCase() === 'UPDATE';
    const line = {
      ts: packet.timestamp,
      userId: packet.userId ?? null,
      userName: packet.userName ?? null,
      sentenceId: id,
      attribute: Number.isFinite(attribute) ? attribute : 1,
      text: String(event.text ?? event.content ?? event.transcript ?? event.data ?? '')
    };

    if (isRevision && key !== null && bySentenceId.has(key)) {
      const index = bySentenceId.get(key);
      lines[index] = line;
      return { changed: true, revised: true, line, index };
    }
    const index = lines.push(line) - 1;
    if (key !== null) bySentenceId.set(key, index);
    return { changed: true, revised: isRevision, line, index };
  }

  return {
    add,
    lines: () => [...lines],
    text: () => lines.map((line) => line.text).join(' ')
  };
}
