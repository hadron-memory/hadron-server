import type { Server } from 'node:http';
import { closeMcpTransportsForShutdown } from '../mcp/server.js';
import { errorToken, type StepOutcome } from './shutdownSteps.js';

/**
 * #3797: the listener-close step of the graceful stop (`src/index.ts`, after the #3021 stopping drain window).
 * Resolves true when `close()` completed without error, i.e. every connection ended.
 */
export async function closeHttpListenerForShutdown(httpServer: Server): Promise<boolean> {
  return (await closeHttpListenerOutcome(httpServer)) === 'ok';
}

/** #3845: the same close, saying how it failed: `ok`, or `close_error:<code or error name>` (never the message). */
export async function closeHttpListenerOutcome(httpServer: Server): Promise<StepOutcome> {
  // Held MCP streams first (synchronously), then the listener: `close()` waits for every connection to end, and a
  // held `GET /mcp` stream never would.
  const transports = closeMcpTransportsForShutdown().catch(() => 0);
  let reaper: NodeJS.Timeout | undefined;
  const closed = new Promise<StepOutcome>((resolve) => {
    httpServer.close((error) => resolve(error ? `close_error:${errorToken(error)}` : 'ok'));
    // Node >= 19 `close()` reaps the connections that are idle AT THAT MOMENT. A request still in flight then (a
    // POST /mcp the helper let finish) leaves a keep-alive socket behind when it ends, which `close()` never
    // revisits: it would hold the stop to the keep-alive timeout. So keep reaping idle sockets until `close()` is done.
    reaper = setInterval(() => httpServer.closeIdleConnections(), 100);
    reaper.unref();
  });
  try {
    const [, ok] = await Promise.all([transports, closed]);
    return ok;
  } finally {
    clearInterval(reaper);
  }
}
