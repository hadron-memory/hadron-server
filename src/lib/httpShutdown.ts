import type { Server } from 'node:http';

/**
 * #3797: the listener-close step of the graceful stop (`src/index.ts`, after the #3021 stopping drain window).
 * Resolves true when `close()` completed without error, i.e. every connection ended.
 */
export function closeHttpListenerForShutdown(httpServer: Server): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    httpServer.close((error) => resolve(!error));
  });
}
