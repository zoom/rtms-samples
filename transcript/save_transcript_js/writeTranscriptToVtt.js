import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const VTT_HEADER = 'WEBVTT\n\n';

function safePathSegment(value) {
  const input = String(value || 'unknown');
  const readable = input.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'unknown';
  const suffix = crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
  return `${readable}-${suffix}`;
}

function normalizeSingleLine(value, fallback = '') {
  return String(value ?? fallback)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeCueText(value) {
  return normalizeSingleLine(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTimestamp(milliseconds, separator) {
  const value = Math.max(0, Number(milliseconds) || 0);
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(value % 1000);
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, '0'))
    .join(':') + `${separator}${String(millis).padStart(3, '0')}`;
}

function toEpochMilliseconds(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return Date.now();
  if (value >= 1e15) return Math.floor(value / 1000);
  if (value >= 1e12) return Math.floor(value);
  if (value >= 1e9) return Math.floor(value * 1000);
  return Math.floor(value);
}

function normalizeEvent(event) {
  const streamId = normalizeSingleLine(event.streamId);
  const meetingId = normalizeSingleLine(event.meetingId);
  const text = normalizeSingleLine(event.text);
  if (!streamId) throw new Error('Transcript event is missing streamId');
  if (!meetingId) throw new Error('Transcript event is missing meetingId');
  if (!text) throw new Error('Transcript event has no text');

  const fallbackTime = toEpochMilliseconds(event.timestamp);
  const startTime = Number.isFinite(Number(event.startTime)) ? Number(event.startTime) : fallbackTime;
  const requestedEnd = Number.isFinite(Number(event.endTime)) ? Number(event.endTime) : startTime;
  const normalized = {
    streamId,
    meetingId,
    userId: event.userId ?? null,
    userName: normalizeSingleLine(event.userName, 'Unknown participant') || 'Unknown participant',
    text,
    startTime,
    endTime: Math.max(startTime, requestedEnd),
    timestamp: Number(event.timestamp) || fallbackTime * 1000
  };
  normalized.id = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return normalized;
}

function renderEvent(event, index, sessionStartTime) {
  const relativeStart = Math.max(0, event.startTime - sessionStartTime);
  const relativeEnd = Math.max(relativeStart, event.endTime - sessionStartTime);
  const speaker = escapeCueText(event.userName);
  const text = escapeCueText(event.text);
  const cue = `${speaker}: ${text}`;
  return {
    vtt: `${formatTimestamp(relativeStart, '.')} --> ${formatTimestamp(relativeEnd, '.')}\n${cue}\n\n`,
    srt: `${index}\n${formatTimestamp(relativeStart, ',')} --> ${formatTimestamp(relativeEnd, ',')}\n${cue}\n\n`,
    txt: `[${new Date(toEpochMilliseconds(event.timestamp)).toISOString()}] ${event.userName}: ${event.text}\n`
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

export class TranscriptStore {
  constructor({
    rootDir = path.resolve('recordings'),
    retentionDays = 30,
    cleanupIntervalMs = 6 * 60 * 60 * 1000,
    dedupWindowEvents = 10_000,
    now = () => Date.now(),
    logger = console
  } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.retentionDays = retentionDays;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.dedupWindowEvents = Math.max(1, dedupWindowEvents);
    this.now = now;
    this.logger = logger;
    this.sessions = new Map();
    this.cleanupTimer = null;
  }

  async start() {
    await fs.mkdir(this.rootDir, { recursive: true });
    await this.cleanup();
    await this.recoverExistingStreams();
    if (this.retentionDays > 0 && this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.cleanup().catch((error) => this.logger.error('[TranscriptStore] Cleanup failed:', error.message));
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  async recoverExistingStreams() {
    let recovered = 0;
    const meetingEntries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const meetingEntry of meetingEntries) {
      if (!meetingEntry.isDirectory()) continue;
      const meetingFolder = path.join(this.rootDir, meetingEntry.name);
      const streamEntries = await fs.readdir(meetingFolder, { withFileTypes: true });
      for (const streamEntry of streamEntries) {
        if (!streamEntry.isDirectory()) continue;
        const folder = path.join(meetingFolder, streamEntry.name);
        const events = await this.readEventLog(folder);
        if (events.length === 0) continue;
        const session = {
          streamId: events[0].streamId,
          meetingId: events[0].meetingId,
          folder,
          eventCount: events.length,
          sessionStartTime: events[0].startTime
        };
        await this.rebuildOutputs(session, events);
        await this.writeMetadata(session);
        recovered += 1;
      }
    }
    if (recovered > 0) this.logger.log(`[TranscriptStore] Recovered ${recovered} stream recording(s)`);
    return recovered;
  }

  async write(event) {
    const normalized = normalizeEvent(event);
    const session = await this.getSession(normalized);
    const operation = session.queue.then(() => this.appendEvent(session, normalized));
    session.queue = operation.catch(() => {});
    return operation;
  }

  async getSession(event) {
    const existing = this.sessions.get(event.streamId);
    if (existing) return existing;

    const initialization = this.initializeSession(event).catch((error) => {
      this.sessions.delete(event.streamId);
      throw error;
    });
    this.sessions.set(event.streamId, initialization);
    return initialization;
  }

  async initializeSession(event) {
    const folder = path.join(
      this.rootDir,
      safePathSegment(event.meetingId),
      safePathSegment(event.streamId)
    );
    await fs.mkdir(folder, { recursive: true });
    const events = await this.readEventLog(folder);
    const recentEvents = events.slice(-this.dedupWindowEvents);
    const session = {
      streamId: event.streamId,
      meetingId: event.meetingId,
      folder,
      queue: Promise.resolve(),
      recentIds: new Set(recentEvents.map((item) => item.id)),
      recentIdQueue: recentEvents.map((item) => item.id),
      eventCount: events.length,
      sessionStartTime: events[0]?.startTime ?? null,
      needsRebuild: false
    };
    await this.rebuildOutputs(session, events);
    await this.writeMetadata(session);
    return session;
  }

  async readEventLog(folder) {
    const logPath = path.join(folder, 'events.jsonl');
    let content;
    try {
      content = await fs.readFile(logPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const events = [];
    let invalidLineFound = false;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.id && event.streamId && event.meetingId) events.push(event);
        else invalidLineFound = true;
      } catch {
        invalidLineFound = true;
      }
    }
    if (invalidLineFound) {
      await writeAtomic(logPath, events.map((item) => JSON.stringify(item)).join('\n') + (events.length ? '\n' : ''));
      this.logger.warn(`[TranscriptStore] Removed an incomplete event-log record from ${logPath}`);
    }
    return events;
  }

  async appendEvent(session, event) {
    if (session.needsRebuild) {
      const recoveredEvents = await this.readEventLog(session.folder);
      await this.rebuildOutputs(session, recoveredEvents);
      session.needsRebuild = false;
    }
    if (session.recentIds.has(event.id)) return { written: false, duplicate: true };

    const logPath = path.join(session.folder, 'events.jsonl');
    try {
      await fs.appendFile(logPath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch (error) {
      session.needsRebuild = true;
      throw error;
    }
    session.eventCount += 1;
    session.sessionStartTime ??= event.startTime;
    this.rememberEvent(session, event.id);

    const rendered = renderEvent(event, session.eventCount, session.sessionStartTime);
    try {
      await Promise.all([
        fs.appendFile(path.join(session.folder, 'transcript.vtt'), rendered.vtt, 'utf8'),
        fs.appendFile(path.join(session.folder, 'transcript.srt'), rendered.srt, 'utf8'),
        fs.appendFile(path.join(session.folder, 'transcript.txt'), rendered.txt, 'utf8')
      ]);
      await this.writeMetadata(session);
      return { written: true, duplicate: false, folder: session.folder };
    } catch (error) {
      session.needsRebuild = true;
      throw error;
    }
  }

  rememberEvent(session, eventId) {
    session.recentIds.add(eventId);
    session.recentIdQueue.push(eventId);
    while (session.recentIdQueue.length > this.dedupWindowEvents) {
      session.recentIds.delete(session.recentIdQueue.shift());
    }
  }

  async rebuildOutputs(session, events) {
    const sessionStartTime = events[0]?.startTime ?? null;
    const output = events.reduce((result, event, index) => {
      const rendered = renderEvent(event, index + 1, sessionStartTime ?? event.startTime);
      result.vtt += rendered.vtt;
      result.srt += rendered.srt;
      result.txt += rendered.txt;
      return result;
    }, { vtt: VTT_HEADER, srt: '', txt: '' });

    await Promise.all([
      writeAtomic(path.join(session.folder, 'transcript.vtt'), output.vtt),
      writeAtomic(path.join(session.folder, 'transcript.srt'), output.srt),
      writeAtomic(path.join(session.folder, 'transcript.txt'), output.txt)
    ]);
    session.eventCount = events.length;
    session.sessionStartTime = sessionStartTime;
  }

  async writeMetadata(session) {
    const metadata = {
      meetingId: session.meetingId,
      streamId: session.streamId,
      eventCount: session.eventCount,
      updatedAt: new Date(this.now()).toISOString()
    };
    await writeAtomic(path.join(session.folder, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  async closeStream(streamId) {
    const sessionPromise = this.sessions.get(String(streamId || '').trim());
    if (!sessionPromise) return;
    const session = await sessionPromise;
    await session.queue;
    if (session.needsRebuild) {
      const events = await this.readEventLog(session.folder);
      await this.rebuildOutputs(session, events);
    }
    this.sessions.delete(session.streamId);
  }

  async flushAll() {
    const sessions = await Promise.all([...this.sessions.values()]);
    await Promise.all(sessions.map(async (session) => {
      await session.queue;
      if (session.needsRebuild) {
        const events = await this.readEventLog(session.folder);
        await this.rebuildOutputs(session, events);
      }
    }));
  }

  async cleanup() {
    if (this.retentionDays <= 0 || !(await pathExists(this.rootDir))) return 0;
    const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const activeFolders = new Set(
      (await Promise.all([...this.sessions.values()].map((session) => session.catch(() => null))))
        .filter(Boolean)
        .map((session) => session.folder)
    );
    let removed = 0;
    const meetingEntries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const meetingEntry of meetingEntries) {
      if (!meetingEntry.isDirectory()) continue;
      const meetingFolder = path.join(this.rootDir, meetingEntry.name);
      const streamEntries = await fs.readdir(meetingFolder, { withFileTypes: true });
      for (const streamEntry of streamEntries) {
        if (!streamEntry.isDirectory()) continue;
        const streamFolder = path.join(meetingFolder, streamEntry.name);
        if (activeFolders.has(streamFolder)) continue;
        const eventLogPath = path.join(streamFolder, 'events.jsonl');
        const metadataPath = path.join(streamFolder, 'metadata.json');
        const markerPath = await pathExists(eventLogPath)
          ? eventLogPath
          : (await pathExists(metadataPath) ? metadataPath : streamFolder);
        const stats = await fs.stat(markerPath);
        if (stats.mtimeMs < cutoff) {
          await fs.rm(streamFolder, { recursive: true, force: true });
          removed += 1;
        }
      }
      if ((await fs.readdir(meetingFolder)).length === 0) await fs.rmdir(meetingFolder);
    }
    if (removed > 0) this.logger.log(`[TranscriptStore] Removed ${removed} expired stream recording(s)`);
    return removed;
  }

  async stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    await this.flushAll();
  }
}
