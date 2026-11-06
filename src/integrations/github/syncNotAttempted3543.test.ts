/** #3543 / cor:int:010:01: no attempt is a refusal, never a stale success. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema } from 'graphql';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import * as syncModule from './syncGraphFromGithub.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { startup } from '../../controller/startup.js';
import { getInstallationToken } from './githubApp.js';

vi.mock('./githubApp.js', () => ({ getInstallationToken: vi.fn(async () => { throw new Error('must not contact GitHub'); }), toHttpsUrl: vi.fn((s: string) => s) }));
const server = new ApolloServer<Context>({ typeDefs, resolvers });
let memory: MemoryWithOrg;
let ownerId: string;
let readerId: string;
let before: unknown;
const ctx = (userId = ownerId): Context => ({ db, userId, roles: ['READER'] });
const snapshot = async () => ({ memory: await db.memory.findUniqueOrThrow({ where: { id: memory.id } }), nodes: await db.node.findMany({ where: { memoryId: memory.id } }) });
const graphQL = async (userId = ownerId) => {
  const res = await server.executeOperation({ query: 'mutation($id:ID!){syncMemory(id:$id){id syncStatus lastSyncReport}}', variables: { id: memory.id } }, { contextValue: ctx(userId) });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  return res.body.singleResult;
};
const mcp = (userId = ownerId) => createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });
beforeEach(async () => {
  await cleanDb(db);
  const created = await createDbOrgAndGraph(db, { orgName: 'not-attempted', graphName: 'fixture' });
  const owner = await db.user.create({ data: { handle: 'not-attempted-owner' } });
  const reader = await db.user.create({ data: { handle: 'not-attempted-reader' } });
  ownerId = owner.id; readerId = reader.id;
  await db.orgMember.createMany({ data: [{ organizationId: created.org.id, userId: ownerId, role: 'OWNER' }, { organizationId: created.org.id, userId: readerId, role: 'READER' }] });
  memory = await db.memory.update({ where: { id: created.graph.id }, data: { source: null, syncStatus: 'OK', syncError: null, lastSyncedAt: new Date('2026-01-01T00:00:00Z'), lastSyncReport: JSON.stringify({ version: 1, outcome: 'partial', entries: [] }) }, include: { organization: true } });
  vi.mocked(getInstallationToken).mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup(reason: string) {
  if (reason === 'NO_INSTALLATION') memory = await db.memory.update({ where: { id: memory.id }, data: { source: 'https://github.com/fixture/not-attempted' }, include: { organization: true } });
  before = await snapshot();
}
describe('#3543 no attempt', () => {
  it.each(['NO_SOURCE', 'NO_INSTALLATION'])('shared sync returns a distinct %s outcome without writes', async reason => {
    await setup(reason);
    expect(await syncGraphFromGithub(memory)).toMatchObject({ notAttemptedReason: reason });
    expect(await snapshot()).toEqual(before);
    expect(getInstallationToken).not.toHaveBeenCalled();
  });
  it.each(['NO_SOURCE', 'NO_INSTALLATION'])('GraphQL and MCP refuse with the same code/reason for %s, preserving stale metadata', async reason => {
    await setup(reason);
    const result = await graphQL();
    expect(result.errors?.[0]?.extensions).toMatchObject({ code: 'SYNC_NOT_ATTEMPTED', reason });
    expect(result.data).toBeNull();
    const tool = await mcp().callTool('hadron_sync_graph', { memoryUrn: `hrn:mem:${memory.urn}` });
    expect(tool).toMatchObject({ isError: true });
    const text = tool.content.map(c => c.text).join('\n');
    expect(text).toContain('[SYNC_NOT_ATTEMPTED]');
    expect(text).toContain(reason);
    expect(text).not.toContain('Synced');
    expect(await snapshot()).toEqual(before);
    expect(getInstallationToken).not.toHaveBeenCalled();
  });
  it.each(['NO_SOURCE', 'NO_INSTALLATION'])('manage access still precedes %s', async reason => {
    await setup(reason);
    const result = await graphQL(readerId);
    expect(result.errors).toHaveLength(1);
    expect(JSON.stringify(result.errors)).not.toContain('SYNC_NOT_ATTEMPTED');
    expect(await mcp(readerId).callToolText('hadron_sync_graph', { memoryUrn: `hrn:mem:${memory.urn}` })).not.toContain('SYNC_NOT_ATTEMPTED');
    expect(await snapshot()).toEqual(before);
  });
  it.each(['NO_SOURCE', 'NO_INSTALLATION'])('encrypted refusal precedes %s unchanged', async reason => {
    await setup(reason);
    memory = await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true }, include: { organization: true } });
    before = await snapshot();
    expect((await graphQL()).errors?.[0]?.extensions.code).toBe('ENCRYPTED_GIT_SYNC_UNAVAILABLE');
    expect(await mcp().callToolText('hadron_sync_graph', { memoryUrn: `hrn:mem:${memory.urn}` })).toContain('[ENCRYPTED_GIT_SYNC_UNAVAILABLE]');
    expect(await snapshot()).toEqual(before);
  });
  it('startup treats no installation as nothing to do, not success or failure', async () => {
    await setup('NO_INSTALLATION');
    vi.stubEnv('DISABLE_STARTUP_SYNC', 'false');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await startup()).toBe('ran');
    expect(log.mock.calls.flat().join('\n')).not.toMatch(/\[OK\]|\[FAIL\]/);
    expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });
  it('a user-owned DB-only memory also refuses NO_SOURCE without writes', async () => {
    memory = await db.memory.create({ data: { name: 'user-only', urn: 'not-attempted:user-only', class: 'private', userId: ownerId, ownerUserId: ownerId } , include: { organization: true } });
    before = await snapshot();
    expect((await graphQL()).errors?.[0]?.extensions).toMatchObject({ code: 'SYNC_NOT_ATTEMPTED', reason: 'NO_SOURCE' });
    expect(await snapshot()).toEqual(before);
  });
  it('the signed push webhook treats no installation as nothing to do, without failure logs or writes', async () => {
    await setup('NO_INSTALLATION');
    const { createServer } = await import('../../server.js');
    const { createServer: httpServer } = await import('node:http');
    const { createHmac } = await import('node:crypto');
    const actual = syncModule.syncGraphFromGithub;
    let finished: ReturnType<typeof actual> | undefined;
    const sync = vi.spyOn(syncModule, 'syncGraphFromGithub').mockImplementation(g => (finished = actual(g)));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'not-attempted-fixture-secret');
    const http = httpServer(await createServer());
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
      const address = http.address() as { port: number };
      const body = JSON.stringify({ ref: 'refs/heads/main', repository: { default_branch: 'main', full_name: 'fixture/not-attempted' } });
      const signature = `sha256=${createHmac('sha256', 'not-attempted-fixture-secret').update(body).digest('hex')}`;
      const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': signature }, body });
      expect(response.status).toBe(200);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(await finished).toMatchObject({ notAttemptedReason: 'NO_INSTALLATION' });
      expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(getInstallationToken).not.toHaveBeenCalled();
    } finally { await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())); }
  }, 30_000);
  it('SDL documents the typed refusal and reasons', () => {
    const text = buildSchema(typeDefs).getMutationType()!.getFields().syncMemory!.description;
    expect(text).toContain('SYNC_NOT_ATTEMPTED');
    expect(text).toContain('NO_SOURCE'); expect(text).toContain('NO_INSTALLATION');
  });
});
