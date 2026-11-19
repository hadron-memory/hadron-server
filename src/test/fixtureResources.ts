import type { Server } from 'node:http';

/** Opt-in fixture cleanup; references are read again by the tail drain phase. */
export async function closeFixtureResources<C extends { close(): Promise<void> }>(resources: {
  client?: C;
  server?: Server;
}): Promise<void> {
  const client = resources.client, server = resources.server;
  const errors: unknown[] = [];
  try {
    await client?.close();
    if (resources.client === client) resources.client = undefined;
  } catch (error) { errors.push(error); }
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => {
        // Node reports this when setup never listened or the body already
        // stopped its server. There is no live resource left to retry.
        if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
        else reject(error);
      }));
    }
    if (resources.server === server) resources.server = undefined;
  } catch (error) { errors.push(error); }
  if (errors.length) throw errors[0];
}
