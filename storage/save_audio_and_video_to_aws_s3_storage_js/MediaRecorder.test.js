import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MediaRecorder } from './MediaRecorder.js';

test('flushes and isolates media by stream', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rtms-recorder-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const recorder = new MediaRecorder({ rootDir });

  await Promise.all([
    recorder.writeAudio({ meetingId: 'meeting-a', streamId: 'stream-a', buffer: Buffer.from('audio-a') }),
    recorder.writeVideo({ meetingId: 'meeting-a', streamId: 'stream-a', buffer: Buffer.from('video-a') }),
    recorder.writeAudio({ meetingId: 'meeting-b', streamId: 'stream-b', buffer: Buffer.from('audio-b') })
  ]);
  const firstDirectory = await recorder.finalize('stream-a');
  const secondDirectory = await recorder.finalize('stream-b');

  assert.equal(await fs.readFile(path.join(rootDir, firstDirectory, 'mixed_audio.raw'), 'utf8'), 'audio-a');
  assert.equal(await fs.readFile(path.join(rootDir, firstDirectory, 'mixed_video.h264'), 'utf8'), 'video-a');
  assert.equal(await fs.readFile(path.join(rootDir, secondDirectory, 'mixed_audio.raw'), 'utf8'), 'audio-b');
  assert.notEqual(firstDirectory, secondDirectory);
});
