import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMediaProcessor } from './MediaProcessingPipeline.js';

test('converts finalized PCM audio before upload', async (t) => {
  const recordingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rtms-media-pipeline-'));
  t.after(() => fs.rm(recordingsDir, { recursive: true, force: true }));

  const relativeDirectory = path.join('meeting', 'stream');
  const recordingDirectory = path.join(recordingsDir, relativeDirectory);
  await fs.mkdir(recordingDirectory, { recursive: true });
  await fs.writeFile(path.join(recordingDirectory, 'mixed_audio.raw'), Buffer.alloc(3_200));

  let uploadedDirectory;
  const processRecording = createMediaProcessor({
    recordingsDir,
    uploadDirectory: async (directory) => {
      uploadedDirectory = directory;
    }
  });

  await processRecording({ relativeDirectory });

  const output = await fs.stat(path.join(recordingDirectory, 'mixed_audio.wav'));
  assert.equal(uploadedDirectory, relativeDirectory);
  assert.ok(output.size > 44);
});
