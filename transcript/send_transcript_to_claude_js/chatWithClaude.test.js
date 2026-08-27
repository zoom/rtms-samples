import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeConfig, createClaudeService } from './chatWithClaude.js';

function createClient() {
  return {
    messages: {
      create: async ({ messages }) => ({
        content: [{ type: 'text', text: `reply-${messages.at(-1).content}` }],
        usage: { input_tokens: 2, output_tokens: 2 }
      })
    }
  };
}

test('keeps histories isolated by RTMS stream ID', async () => {
  const service = createClaudeService({ client: createClient() });
  await service.chatWithClaude('alpha', 'stream-a');
  await service.chatWithClaude('beta', 'stream-b');
  assert.deepEqual(service.getSessionHistory('stream-a').map((item) => item.content), ['alpha', 'reply-alpha']);
  assert.deepEqual(service.getSessionHistory('stream-b').map((item) => item.content), ['beta', 'reply-beta']);
});

test('bounds history and clears stopped streams', async () => {
  const service = createClaudeService({
    client: createClient(),
    config: { ...claudeConfig, maxHistoryMessages: 2, maxHistoryCharacters: 100 }
  });
  await service.chatWithClaude('one', 'stream-a');
  await service.chatWithClaude('two', 'stream-a');
  assert.equal(service.getSessionHistory('stream-a').length, 2);
  service.clearClaudeStream('stream-a');
  assert.deepEqual(service.getSessionHistory('stream-a'), []);
});
