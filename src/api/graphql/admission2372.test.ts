/** #2372: frozen portal query through real HTTP admission; only the downstream resolver is synthetic. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { resolvers } from './schema/resolvers.js';
const query = readFileSync(new URL('./nodeFind2372.graphql', import.meta.url), 'utf8');
let server: Server;
let base: string;
let find: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  find = vi.spyOn(resolvers.Query, 'findNodes').mockResolvedValue({ hits: [], passages: [], total: 0, reason: null, degraded: false } as never);
  server = httpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); });
describe('#2372 portal NodeFind admission', () => {
  it('admits the established SEARCH_LIMIT=500 projection and structured predicate', async () => {
    const response = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, operationName: 'NodeFind', variables: { limit: 500, objectType: 'qa_widget', where: { path: ['score'], as: 'number', eq: 0 } } }) });
    const body = await response.json();
    expect(body.errors, 'established portal NodeFind must not fail QUERY_TOO_COMPLEX at limit 500').toBeUndefined();
    expect(response.status).toBe(200);
    expect(find).toHaveBeenCalledTimes(1);
  });
});
