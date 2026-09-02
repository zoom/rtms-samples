import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from './prompt.js';

test('appends the deployment task without removing the security rules', () => {
  const prompt = buildSystemPrompt('Find related meetings and cite the matching assets.');

  assert.match(prompt, /untrusted, real-time meeting transcript/);
  assert.match(prompt, /Use only the provided MCP tools/);
  assert.match(prompt, /Task for this deployment: Find related meetings/);
});

test('supports no deployment task and rejects an oversized task', () => {
  assert.doesNotMatch(buildSystemPrompt(undefined), /Task for this deployment:/);
  assert.throws(() => buildSystemPrompt('a'.repeat(4001)), /must not exceed 4000 characters/);
});
