import test from 'node:test';
import assert from 'node:assert/strict';
import { runMediaDemo } from './offlineDemo.js';

test('offline media demo drives the canned stream through registry, subscription and media profile', () => {
  const result = runMediaDemo();
  const names = result.participants.participants.map((person) => person.names.at(-1).name);
  assert.deepEqual(names, ['Ana', 'Ben']);
  assert.deepEqual(result.sent.map((message) => [message.user_id, message.subscribe]), [[1, true], [2, true]]);
  assert.deepEqual(result.frames.map((frame) => frame.attributed), [true, false, true, false]);
  assert.deepEqual(result.audioSamples.map((sample) => sample.userId), [1, 2, null]);
  assert.equal(result.mediaParams.audio.codec, 1);
  assert.equal(result.mediaParams.video.data_opt, 4);
  assert.equal(result.mediaParams.audio.sample_rate, 1);
  assert.equal(result.mediaParams.video.resolution, 2);
  assert.ok(result.sdkTranslation.notes.some((note) => note.includes('resample')));
  assert.equal(result.subscription.current, 2);
});
