import assert from 'node:assert/strict';
import test from 'node:test';
import { closeHttpServer, installGracefulShutdown } from '../gracefulShutdown.js';

test('closeHttpServer resolves when a server is not listening', async () => {
  await closeHttpServer({ listening: false });
});

test('shutdown is idempotent', async () => {
  let cleanupCalls = 0;
  const shutdown = installGracefulShutdown({
    name: 'test',
    cleanup: async () => {
      cleanupCalls += 1;
    }
  });

  await Promise.all([shutdown('test-1'), shutdown('test-2')]);
  assert.equal(cleanupCalls, 1);
});
