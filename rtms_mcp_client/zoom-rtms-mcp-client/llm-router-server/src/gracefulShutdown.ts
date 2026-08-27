import type { Server } from 'node:http';

export function installGracefulShutdown(name: string, server: Server, cleanup?: () => Promise<void>) {
  let running: Promise<void> | undefined;
  const shutdown = (signal: string) => {
    if (running) return running;
    running = (async () => {
      console.log(`[${name}] ${signal} received; shutting down`);
      const timeout = setTimeout(() => process.exit(1), 10000);
      timeout.unref();
      try {
        await cleanup?.();
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        process.exitCode = 0;
      } catch (error) {
        console.error(`[${name}] shutdown failed`, error);
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
      }
    })();
    return running;
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
