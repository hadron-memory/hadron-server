import type { Server } from 'node:http';

/** Opt-in fixture cleanup; references are read again by the tail drain phase. */
export async function closeFixtureResources<C extends { close(): Promise<void> }>(resources: {
  client?: C;
  server?: Server;
}): Promise<void> {
  const client = resources.client;
  await client?.close();
  if (resources.client === client) resources.client = undefined;
  const server = resources.server;
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (resources.server === server) resources.server = undefined;
}
