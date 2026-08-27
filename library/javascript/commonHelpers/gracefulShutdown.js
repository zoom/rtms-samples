const DEFAULT_TIMEOUT_MS = 10_000;

export function closeHttpServer(server) {
  if (!server?.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function closeWebSocket(socket) {
  if (!socket || socket.readyState === 3) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => resolve();
    socket.once?.('close', finish);
    socket.once?.('error', finish);
    try {
      socket.close();
    } catch {
      resolve();
    }
  });
}

export function installGracefulShutdown({
  name = 'Application',
  cleanup,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (typeof cleanup !== 'function') {
    throw new TypeError('installGracefulShutdown requires a cleanup function');
  }

  let shutdownPromise = null;

  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      console.log(`[${name}] ${signal} received; shutting down`);
      const deadline = setTimeout(() => {
        console.error(`[${name}] Shutdown exceeded ${timeoutMs}ms; forcing exit`);
        process.exit(1);
      }, timeoutMs);
      deadline.unref();

      try {
        await cleanup(signal);
        process.exitCode = 0;
      } catch (error) {
        process.exitCode = 1;
        console.error(`[${name}] Shutdown failed:`, error);
      } finally {
        clearTimeout(deadline);
      }
    })();

    return shutdownPromise;
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  return shutdown;
}
