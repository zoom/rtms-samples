import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { UUIDHelper } from '../../library/javascript/commonHelpers/filename/UUIDHelper.js';

export class MediaRecorder {
  constructor({ rootDir = path.resolve('recordings') } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.sessions = new Map();
    this.finalizedStreams = new Set();
    this.stopped = false;
  }

  writeAudio(event) {
    return this.writeChunk(event, 'audio');
  }

  writeVideo(event) {
    return this.writeChunk(event, 'video');
  }

  async writeChunk(event, type) {
    if (this.stopped || this.finalizedStreams.has(event.streamId)) {
      return false;
    }
    const session = this.getOrCreateSession(event);
    const operation = session.queue.then(async () => {
      await session.ready;
      if (session.error) throw session.error;
      const stream = this.getOrCreateWriteStream(session, type);
      if (!stream.write(event.buffer)) await once(stream, 'drain');
      if (session.error) throw session.error;
      return true;
    });
    session.queue = operation.catch(() => {});
    return operation;
  }

  getOrCreateSession(event) {
    const streamId = String(event.streamId || '').trim();
    const meetingId = String(event.meetingId || '').trim();
    if (!streamId || !meetingId) throw new Error('Media event is missing its stream or meeting ID');
    const existing = this.sessions.get(streamId);
    if (existing) return existing;

    const relativeDirectory = path.join(UUIDHelper.sanitize(meetingId), UUIDHelper.sanitize(streamId));
    const folder = path.join(this.rootDir, relativeDirectory);
    const session = {
      streamId,
      relativeDirectory,
      folder,
      queue: Promise.resolve(),
      ready: fsPromises.mkdir(folder, { recursive: true }),
      streams: new Map(),
      error: null
    };
    this.sessions.set(streamId, session);
    return session;
  }

  getOrCreateWriteStream(session, type) {
    const existing = session.streams.get(type);
    if (existing) return existing;
    const fileName = type === 'audio' ? 'mixed_audio.raw' : 'mixed_video.h264';
    const stream = fs.createWriteStream(path.join(session.folder, fileName), { flags: 'a' });
    stream.on('error', (error) => {
      session.error = error;
    });
    session.streams.set(type, stream);
    return stream;
  }

  directoryFor(meetingId, streamId) {
    return path.join(UUIDHelper.sanitize(meetingId), UUIDHelper.sanitize(streamId));
  }

  async finalize(streamId) {
    const normalizedStreamId = String(streamId || '').trim();
    this.finalizedStreams.add(normalizedStreamId);
    const session = this.sessions.get(normalizedStreamId);
    if (!session) return null;
    await session.queue;
    await session.ready;
    await Promise.all([...session.streams.values()].map(async (stream) => {
      stream.end();
      await finished(stream);
    }));
    this.sessions.delete(normalizedStreamId);
    if (session.error) throw session.error;
    return session.relativeDirectory;
  }

  getActiveDirectories() {
    return new Set([...this.sessions.values()].map((session) => session.relativeDirectory));
  }

  async stop() {
    this.stopped = true;
    return Promise.all([...this.sessions.keys()].map((streamId) => this.finalize(streamId)));
  }
}
