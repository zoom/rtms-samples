import fs from 'fs/promises';
import path from 'path';

const SAFE_ID = /[^a-zA-Z0-9_-]/g;

export function sanitizeId(value) {
  return String(value || '').replace(SAFE_ID, '_');
}

export function recordingDirectory(root, meetingId, streamId) {
  return path.join(root, sanitizeId(meetingId), sanitizeId(streamId));
}

export class RecordingStore {
  constructor(root) {
    this.root = root;
    this.sessions = new Map();
  }

  noteMedia(meetingId, streamId, timestamp) {
    const session = this.#session(meetingId, streamId);
    const timestampMs = normalizeEpochMs(timestamp);
    if (timestampMs !== null && (session.mediaStartMs === null || timestampMs < session.mediaStartMs)) {
      session.mediaStartMs = timestampMs;
    }
  }

  addTranscript(event) {
    const session = this.#session(event.meetingId, event.streamId);
    session.transcript.push({
      text: String(event.text || '').trim(),
      userId: event.userId ?? null,
      userName: event.userName || 'Unknown participant',
      language: event.language || null,
      timestamp: event.timestamp ?? null,
      startTime: event.startTime ?? null,
      endTime: event.endTime ?? null,
    });
  }

  async finalize(meetingId, streamId) {
    const session = this.#session(meetingId, streamId);
    const directory = recordingDirectory(this.root, meetingId, streamId);
    await fs.mkdir(directory, { recursive: true });

    const transcript = session.transcript
      .filter((entry) => entry.text)
      .map((entry, index) => normalizeTranscriptEntry(entry, session.mediaStartMs, index));
    const document = {
      version: 1,
      meetingId,
      streamId,
      mediaStartMs: session.mediaStartMs,
      finalizedAt: new Date().toISOString(),
      segments: transcript,
    };

    await fs.writeFile(
      path.join(directory, 'transcript.json'),
      `${JSON.stringify(document, null, 2)}\n`
    );
    this.sessions.delete(meetingId);
    return document;
  }

  #session(meetingId, streamId) {
    if (!this.sessions.has(meetingId)) {
      this.sessions.set(meetingId, { streamId, mediaStartMs: null, transcript: [] });
    }
    return this.sessions.get(meetingId);
  }
}

export function normalizeEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 1e15) return Math.round(numeric / 1000);
  if (numeric >= 1e12) return Math.round(numeric);
  return Math.round(numeric);
}

function normalizeTranscriptEntry(entry, mediaStartMs, index) {
  const startEpochMs = normalizeEpochMs(entry.startTime);
  const endEpochMs = normalizeEpochMs(entry.endTime);
  const fallbackStart = index === 0 ? 0 : null;
  const startMs = mediaStartMs !== null && startEpochMs !== null
    ? Math.max(0, startEpochMs - mediaStartMs)
    : fallbackStart;
  const endMs = mediaStartMs !== null && endEpochMs !== null
    ? Math.max(startMs ?? 0, endEpochMs - mediaStartMs)
    : null;

  return {
    ...entry,
    startEpochMs,
    endEpochMs,
    startMs,
    endMs,
  };
}
