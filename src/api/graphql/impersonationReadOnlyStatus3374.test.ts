/** #3374 / ruling0205: the existing central mutation refusal is HTTP403, not a server fault. */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../server.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { signJwt } from '../../auth/jwt.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let server: Server;
let base: string;
let countSql: string;
let adminToken: string;
let token: string;
let targetId: string;
let sessionId: string;
const blockedField = 'createOrganization(name: "must-not-execute", urn: "imp-status-blocked") { id }';
const refusalMessage = 'This is a read-only impersonation session; mutations are disabled.';

async function ask(query: string, bearer: string | undefined = token, operationName?: string) {
  const response = await fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ query, ...(operationName ? { operationName } : {}) }),
  });
  return { status: response.status, json: await response.json() as any };
}
const counts = () => db.$queryRawUnsafe<Array<{ name: string; n: bigint }>>(countSql);

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The isolated worker owns this database. Count ALL base tables, including events/audit,
  // rather than assuming which persistence seam a new resolver might use.
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  countSql = tables.map(({ tablename }) =>
    `SELECT '${tablename.replaceAll("'", "''")}'::text AS name, count(*)::bigint AS n FROM "${tablename.replaceAll('"', '""')}"`,
  ).join(' UNION ALL ') + ' ORDER BY name';
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'imp-status', urn: `imp-status-${generateId()}` } });
  const admin = await db.user.create({ data: { handle: 'imp-status-admin', roles: ['ADMIN'] } });
  const target = await db.user.create({ data: { handle: 'imp-status-target', roles: ['READER'] } });
  targetId = target.id;
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: target.id, role: 'CONTRIBUTOR' },
  ] });
  adminToken = await signJwt({ sub: admin.id, roles: ['ADMIN'] });
  const started = await ask(`mutation { startImpersonation(orgRef:"${org.id}", userRef:"${target.id}") { token session { id } } }`, adminToken);
  expect(started.status).toBe(200);
  expect(started.json.errors).toBeUndefined();
  token = started.json.data.startImpersonation.token;
  sessionId = started.json.data.startImpersonation.session.id;
});

describe('#3374 blocked operations at the actual HTTP/Apollo boundary', () => {
  it.each([
    ['anonymous mutation', `mutation { ${blockedField} }`, undefined],
    ['named mutation', `mutation Denied { ${blockedField} }`, undefined],
    ['alias', `mutation { hidden: ${blockedField} }`, undefined],
    ['fragment', `mutation { ...Fields } fragment Fields on Mutation { ${blockedField} }`, undefined],
    ['inline fragment', `mutation { ... on Mutation { ${blockedField} } }`, undefined],
    ['operationName chooses mutation', `query Read { me { id } } mutation Denied { ${blockedField} }`, 'Denied'],
    ['allowed field before blocked field', `mutation { stopImpersonation { id } ${blockedField} }`, undefined],
    ['blocked field before allowed field', `mutation { ${blockedField} stopImpersonation { id } }`, undefined],
  ] as const)('%s returns403 + exact typed refusal with no writes/events/audit', async (_label, query, operationName) => {
    const before = await counts();
    const result = await ask(query, token, operationName);
    expect(result.status).toBe(403);
    expect(result.json.errors).toHaveLength(1);
    expect(result.json.errors[0].message).toBe(refusalMessage);
    expect(result.json.errors[0].extensions.code).toBe('IMPERSONATION_READ_ONLY');
    expect(result.json.errors[0].extensions.blockedFields).toEqual(['createOrganization']);
    expect(result.json.data).toBeUndefined();
    expect(await counts()).toEqual(before);
    expect(await db.impersonationSession.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ endedAt: null });
  });
});

describe('#3374 unchanged controls', () => {
  it('the allowlist stays exactly stopImpersonation and __typename', async () => {
    const source = readFileSync(new URL('./impersonationReadOnlyPlugin.ts', import.meta.url), 'utf8');
    const values = /const ALLOWED_MUTATION_FIELDS = new Set\(\[([^\]]+)\]\)/.exec(source)?.[1];
    expect(values?.match(/'([^']+)'/g)?.map(value => value.slice(1, -1))).toEqual(['stopImpersonation', '__typename']);
    expect((await ask('mutation { __typename }')).json).toEqual({ data: { __typename: 'Mutation' } });
  });
  it('stopImpersonation still succeeds at200', async () => {
    const result = await ask('mutation { stopImpersonation { id endedAt } }');
    expect(result.status).toBe(200);
    expect(result.json.errors).toBeUndefined();
    expect(result.json.data.stopImpersonation.id).toBe(sessionId);
    expect(result.json.data.stopImpersonation.endedAt).not.toBeNull();
  });
  it('query selection with operationName still reads the impersonated member at200', async () => {
    const before = await counts();
    const result = await ask(`query Read { me { id } } mutation Denied { ${blockedField} }`, token, 'Read');
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ data: { me: { id: targetId } } });
    expect(await counts()).toEqual(before);
  });
  it.each(['mutation {', 'mutation { noSuchMutation3374 }'])('parse/validation still answers400 before the plugin: %s', async query => {
    const before = await counts();
    const result = await ask(query);
    expect(result.status).toBe(400);
    expect(result.json.errors[0].extensions.code).not.toBe('IMPERSONATION_READ_ONLY');
    expect(await counts()).toEqual(before);
  });
  it('an anonymous request is not classified as impersonation', async () => {
    const result = await ask(`mutation { ${blockedField} }`, '');
    expect(result.status).not.toBe(403);
    expect(result.json.errors[0].extensions.code).not.toBe('IMPERSONATION_READ_ONLY');
  });
  it('a nonimpersonated credential still executes the mutation', async () => {
    const before = await db.organization.count();
    const result = await ask(`mutation { ${blockedField} }`, adminToken);
    expect(result.status).toBe(200);
    expect(result.json.errors).toBeUndefined();
    expect(await db.organization.count()).toBe(before + 1);
  });
  it('unsupported HTTP batching remains rejected without executing even allowed mutations', async () => {
    const before = await counts();
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify([{ query: 'mutation { stopImpersonation { id } }' }, { query: `mutation { ${blockedField} }` }]),
    });
    expect(response.status).toBe(400);
    expect(await counts()).toEqual(before);
    expect(await db.impersonationSession.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ endedAt: null });
  });
  it('MCP keeps refusing the impersonation credential at401', async () => {
    const before = await counts();
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'imp-status-test', version: '1' } } }),
    });
    expect(response.status).toBe(401);
    expect(await counts()).toEqual(before);
  });
});
