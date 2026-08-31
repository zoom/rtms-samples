import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RecordingStore } from '../lib/recordingStore.js';

test('persists transcript offsets relative to the first media timestamp', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rtms-editor-'));
  const store = new RecordingStore(root);
  store.noteMedia('meeting/id', 'stream', 1780000000000);
  store.addTranscript({
    meetingId: 'meeting/id',
    streamId: 'stream',
    text: 'Important point',
    userName: 'Speaker',
    startTime: 1780000001500,
    endTime: 1780000003000,
  });

  const transcript = await store.finalize('meeting/id', 'stream');
  assert.equal(transcript.segments[0].startMs, 1500);
  assert.equal(transcript.segments[0].endMs, 3000);
});
