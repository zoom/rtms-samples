import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TranscriptStore } from './writeTranscriptToVtt.js';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rtms-transcript-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(overrides = {}) {
  return {
    streamId: 'stream-a',
    meetingId: 'meeting-a',
    userId: 1,
    userName: 'Alice',
    text: 'Hello',
    startTime: 1_000,
    endTime: 2_000,
    timestamp: 1_800_000_000_000_000,
    ...overrides
  };
}

test('isolates counters and timing state for concurrent streams', async (t) => {
  const rootDir = await temporaryDirectory(t);
  const store = new TranscriptStore({ rootDir, retentionDays: 0 });
  await store.start();
  const [first, second] = await Promise.all([
    store.write(transcript()),
    store.write(transcript({ streamId: 'stream-b', meetingId: 'meeting-b', startTime: 8_000, endTime: 9_000 }))
  ]);

  const [firstSrt, secondSrt] = await Promise.all([
    fs.readFile(path.join(first.folder, 'transcript.srt'), 'utf8'),
    fs.readFile(path.join(second.folder, 'transcript.srt'), 'utf8')
  ]);
  assert.match(firstSrt, /^1\n00:00:00,000 --> 00:00:01,000/m);
  assert.match(secondSrt, /^1\n00:00:00,000 --> 00:00:01,000/m);
  assert.notEqual(first.folder, second.folder);
  await store.stop();
});

test('escapes subtitle content and deduplicates replayed events', async (t) => {
  const rootDir = await temporaryDirectory(t);
  const store = new TranscriptStore({ rootDir, retentionDays: 0 });
  await store.start();
  const event = transcript({ userName: 'Alice <admin>', text: 'A & B\n--> injected' });
  const first = await store.write(event);
  const duplicate = await store.write(event);
  const [vtt, srt, eventLog] = await Promise.all([
    fs.readFile(path.join(first.folder, 'transcript.vtt'), 'utf8'),
    fs.readFile(path.join(first.folder, 'transcript.srt'), 'utf8'),
    fs.readFile(path.join(first.folder, 'events.jsonl'), 'utf8')
  ]);

  assert.equal(duplicate.duplicate, true);
  assert.match(vtt, /Alice &lt;admin&gt;: A &amp; B --&gt; injected/);
  assert.match(srt, /Alice &lt;admin&gt;: A &amp; B --&gt; injected/);
  assert.equal(eventLog.trim().split('\n').length, 1);
  await store.stop();
});

test('recovers counters and deduplication from the canonical event log', async (t) => {
  const rootDir = await temporaryDirectory(t);
  const firstStore = new TranscriptStore({ rootDir, retentionDays: 0 });
  await firstStore.start();
  const firstEvent = transcript();
  const firstResult = await firstStore.write(firstEvent);
  await firstStore.stop();

  await fs.writeFile(path.join(firstResult.folder, 'transcript.srt'), 'corrupt output', 'utf8');
  const recoveredStore = new TranscriptStore({ rootDir, retentionDays: 0 });
  await recoveredStore.start();
  const startupRecoveredSrt = await fs.readFile(path.join(firstResult.folder, 'transcript.srt'), 'utf8');
  assert.doesNotMatch(startupRecoveredSrt, /corrupt output/);
  assert.equal((await recoveredStore.write(firstEvent)).duplicate, true);
  await recoveredStore.write(transcript({ text: 'Second', startTime: 2_000, endTime: 3_000, timestamp: 1_800_000_001_000_000 }));

  const recoveredSrt = await fs.readFile(path.join(firstResult.folder, 'transcript.srt'), 'utf8');
  assert.match(recoveredSrt, /^1\n/m);
  assert.match(recoveredSrt, /\n2\n00:00:01,000 --> 00:00:02,000/m);
  await recoveredStore.stop();
});

test('removes inactive stream folders older than the retention period', async (t) => {
  const rootDir = await temporaryDirectory(t);
  const streamFolder = path.join(rootDir, 'meeting', 'stream');
  await fs.mkdir(streamFolder, { recursive: true });
  const metadataPath = path.join(streamFolder, 'metadata.json');
  await fs.writeFile(metadataPath, '{}');
  const oldTime = new Date('2026-01-01T00:00:00Z');
  await fs.utimes(metadataPath, oldTime, oldTime);

  const store = new TranscriptStore({
    rootDir,
    retentionDays: 1,
    cleanupIntervalMs: 0,
    now: () => new Date('2026-01-03T00:00:00Z').getTime(),
    logger: { log() {}, warn() {}, error() {} }
  });
  await store.start();
  await assert.rejects(fs.access(streamFolder), { code: 'ENOENT' });
  await store.stop();
});
