import assert from 'node:assert/strict';
import test from 'node:test';

test('importing FileLogger does not install process termination handlers', async () => {
  const sigintListeners = process.listenerCount('SIGINT');
  const sigtermListeners = process.listenerCount('SIGTERM');

  await import('../utils/FileLogger.js');

  assert.equal(process.listenerCount('SIGINT'), sigintListeners);
  assert.equal(process.listenerCount('SIGTERM'), sigtermListeners);
});
