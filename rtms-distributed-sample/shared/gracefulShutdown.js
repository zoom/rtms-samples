export function installGracefulShutdown({ name, server, cleanup, timeoutMs = 10000 }) {
  let shutdownPromise;

  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      console.log(`[${name}] ${signal} received; shutting down`);
      const timeout = setTimeout(() => {
        console.error(`[${name}] shutdown timed out after ${timeoutMs}ms`);
        process.exit(1);
      }, timeoutMs);
      timeout.unref();

      try {
        if (server?.listening) {
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
        await cleanup?.();
        process.exitCode = 0;
      } catch (error) {
        console.error(`[${name}] shutdown failed`, error);
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
      }
    })();

    return shutdownPromise;
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  return shutdown;
}
