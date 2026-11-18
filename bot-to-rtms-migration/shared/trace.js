import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TRACE_SCHEMA_VERSION = 1;

/**
 * Append-only event trace: one JSON object per line.
 *
 * This is a demo trace, not a datastore. The 50, 61 and 62 samples append to it and
 * the reporting dashboard reads it. In production send the same events to your own logging or
 * analytics pipeline. Do not put secrets or raw media in a trace line.
 */
export function createTrace(file, { now = () => Date.now() } = {}) {
  let ready = false;
  return {
    file,
    append(type, fields = {}) {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true });
        ready = true;
      }
      const tsMs = now();
      const line = { v: TRACE_SCHEMA_VERSION, ts: new Date(tsMs).toISOString(), tsMs, type, ...fields };
      appendFileSync(file, `${JSON.stringify(line)}\n`);
      return line;
    },
    read() {
      return readTrace(file);
    }
  };
}

/** Read a trace file. Malformed lines are counted and skipped, never thrown. */
export function readTrace(file) {
  if (!existsSync(file)) return { events: [], malformed: 0 };
  const events = [];
  let malformed = 0;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') events.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
}

/** In-memory sink with the same append() shape, for tests and dry runs. */
export function createMemoryTrace(now = () => Date.now()) {
  const events = [];
  return {
    events,
    append(type, fields = {}) {
      const tsMs = now();
      const line = { v: TRACE_SCHEMA_VERSION, ts: new Date(tsMs).toISOString(), tsMs, type, ...fields };
      events.push(line);
      return line;
    },
    read() {
      return { events: [...events], malformed: 0 };
    }
  };
}
