/**
 * #851: where the server tells its own HEALTHCHECK which port it actually bound.
 *
 * The image's `CMD` is `doppler run -- ...`, so `PORT` can be a Doppler secret that exists only in the server process's
 * environment; a `docker exec` health probe sees the image and container environment, not Doppler's. A probe that
 * trusted its own `PORT` would dial the default (4000) while the server listens on another port and report a healthy
 * container as unhealthy. So the server writes the bound port to a file at listen time and the probe reads it first
 * (`PORT`, then 4000, only when the file is absent). Best effort: a write failure never stops the server, and the file is
 * removed at start so a stale value from a previous run of the same container is never read.
 *
 * `HADRON_PORT_FILE` overrides the path (the probe reads the same variable); default `/tmp/hadron-server.port`.
 */
import { rmSync, writeFileSync } from 'node:fs';

export const DEFAULT_PORT_FILE = '/tmp/hadron-server.port';

export function portFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HADRON_PORT_FILE || DEFAULT_PORT_FILE;
}

/** Remove any port file left by a previous run. Never throws. */
export function clearPortFile(env: NodeJS.ProcessEnv = process.env): void {
  try { rmSync(portFilePath(env), { force: true }); } catch { /* best effort */ }
}

/** Record the port the server is listening on. Never throws; returns whether it was written. */
export function writePortFile(server: { address(): unknown }, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? (addr as { port?: number }).port : undefined;
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return false;
    writeFileSync(portFilePath(env), `${port}\n`, { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}
