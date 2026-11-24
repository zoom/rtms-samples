import assert from 'node:assert/strict';
import test from 'node:test';
import { openAIConfig, chatWithTranscript, clearOpenAIStream } from './chatWithOpenAI.js';

test('uses bounded provider defaults', () => {
  assert.ok(openAIConfig.maxInputCharacters > 0);
  assert.ok(openAIConfig.maxOutputTokens > 0);
  assert.ok(openAIConfig.maxRequestsPerStream > 0);
  assert.ok(openAIConfig.timeoutMs > 0);
});

test('rejects an empty transcript before calling the provider', async () => {
  await assert.rejects(
    chatWithTranscript('   ', 'stream-a'),
    (error) => error?.code === 'empty_input'
  );
  clearOpenAIStream('stream-a');
});
