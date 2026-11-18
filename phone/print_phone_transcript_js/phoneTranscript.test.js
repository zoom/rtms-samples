import assert from 'node:assert/strict';
import test from 'node:test';
import { PhoneTranscript } from './phoneTranscript.js';

test('revisions replace the sentence keyed by channel and sentence ID', () => {
  const transcript = new PhoneTranscript();
  assert.equal(transcript.apply({ channelId: 'a', sentenceId: 0, text: 'Thanks', startTime: 1 }).action, 'new');
  assert.equal(transcript.apply({ channelId: 'a', sentenceId: 0, text: 'Thanks for calling.', isUpdate: true, startTime: 1 }).action, 'updated');
  assert.equal(transcript.apply({ channelId: 'b', sentenceId: 0, text: 'Hi', startTime: 2 }).action, 'new');

  assert.equal(transcript.size, 2);
  assert.deepEqual(transcript.sentences().map((s) => s.text), ['Thanks for calling.', 'Hi']);
});

test('an update for an unknown sentence is recovered, not dropped', () => {
  const transcript = new PhoneTranscript();
  const result = transcript.apply({ channelId: 'a', sentenceId: 19, text: 'Let me check.', isUpdate: true });
  assert.equal(result.action, 'recovered');
  assert.equal(transcript.size, 1);
});
