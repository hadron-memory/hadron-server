/** #2372: frozen portal query through real HTTP admission; only the downstream resolver is synthetic. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../../server.js';
import { resolvers } from './schema/resolvers.js';
type Body = { errors?: Array<{ extensions: { code: string; limit: string; max: number } }> };
const readBody = async (response: Response): Promise<Body> => await response.json() as Body;
const query = readFileSync(new URL('./nodeFind2372.graphql', import.meta.url), 'utf8');
let server: Server;
let base: string;
let node: ReturnType<typeof vi.spyOn>;
let find: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  node = vi.spyOn(resolvers.Query, 'node').mockResolvedValue(null as never);
  find = vi.spyOn(resolvers.Query, 'findNodes').mockResolvedValue({ hits: [], passages: [], total: 0, reason: null, degraded: false } as never);
  server = httpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); vi.restoreAllMocks(); });
const post = (document: string, variables: Record<string, unknown> = {}) => fetch(`${base}/graphql`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: document, variables }),
});
describe('#2372 portal NodeFind admission', () => {
  it.each(['variable', 'literal'])('still refuses an abusive %s limit before the resolver', async (form) => {
    find.mockClear();
    const document = form === 'variable' ? query : query.replace('limit: $limit', 'limit: 2147483647').replace('$limit: Int', '');
    const response = await post(document, form === 'variable' ? { limit: 2147483647 } : {});
    expect(response.status).toBe(400);
    expect((await readBody(response)).errors?.[0]?.extensions).toMatchObject({ code: 'QUERY_TOO_COMPLEX', limit: 'cost', max: 25000 });
    expect(find).not.toHaveBeenCalled();
  });
  it('still refuses depth 13 before the resolver', async () => {
    node.mockClear();
    const chain = Array.from({ length: 12 }, (_, i) => i === 0 ? 'node(ref: "synthetic")' : i % 2 ? 'outgoingEdges' : 'target');
    const document = `{ ${chain.reduceRight((inner, field) => `${field} { ${inner} }`, 'id')} }`;
    const response = await post(document);
    expect(response.status).toBe(400);
    expect((await readBody(response)).errors?.[0]?.extensions).toMatchObject({ code: 'QUERY_TOO_COMPLEX', limit: 'depth', max: 12 });
    expect(node).not.toHaveBeenCalled();
  });
  it('admits the established SEARCH_LIMIT=500 projection and structured predicate', async () => {
    find.mockClear();
    const response = await fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, operationName: 'NodeFind', variables: { limit: 500, objectType: 'qa_widget', where: { path: ['score'], as: 'number', eq: 0 } } }) });
    const body = await readBody(response);
    expect(body.errors, 'established portal NodeFind must not fail QUERY_TOO_COMPLEX at limit 500').toBeUndefined();
    expect(response.status).toBe(200);
    expect(find).toHaveBeenCalledTimes(1);
  });
});
