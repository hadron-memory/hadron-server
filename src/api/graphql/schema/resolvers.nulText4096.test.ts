/**
 * #4096 — caller text with a NUL (U+0000) reaches Postgres and fails 22021, surfacing as INTERNAL_SERVER_ERROR.
 * The refusal is typed (BAD_USER_INPUT, field named, value not echoed) at each write ENTRY that takes caller text, before
 * any write — never in the shared `mapChatSeqConflict` wrapper, whose clone/extract sites write server-copied text
 * (cor:api:260:01; precedent #2730/#2759 for the engineering convention).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
afterEach(() => vi.restoreAllMocks());

const M = resolvers.Mutation as any;
const SECRET = 'SECRETVALUE';
const nul = `${SECRET}\0tail`;
let admin: any, outsider: any, memory: any, memoryUrn: string, app: any, org: any;
const rolesOf = (userId: string) => (userId === outsider?.id ? [] : ['ADMIN']) as any;
const ctx = (userId: string): Context => ({ db, userId, roles: rolesOf(userId), clientId: `user:${userId}` });
const mcp = (userId: string) => createTestableMcpServer({ userId, roles: ['ADMIN'] as any, clientId: `user:${userId}` });

beforeEach(async () => {
  await cleanDb(db);
  admin = await db.user.create({ data: { githubId: 409601, githubUsername: 'admin4096', roles: ['ADMIN'] } });
  outsider = await db.user.create({ data: { githubId: 409602, githubUsername: 'outsider4096', roles: [] } });
  org = await db.organization.create({ data: { id: generateId(), name: 'org4096', urn: 'nul4096.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memoryUrn = `nul4096.test:mem-${generateId().slice(0, 8).toLowerCase()}`;
  memory = await db.memory.create({ data: { name: 'mem4096', urn: memoryUrn, class: 'private', userId: admin.id, ownerUserId: admin.id } });
});

const nodes = () => db.node.count({ where: { memoryId: memory.id } });
const refused = (p: Promise<unknown>, field: string) =>
  p.then(
    () => { throw new Error('expected a refusal'); },
    (e: any) => {
      expect(e.extensions?.code).toBe('BAD_USER_INPUT');
      expect(e.message).toContain(field);
      expect(e.message).not.toContain(SECRET);
      expect(JSON.stringify(e.extensions ?? {})).not.toContain(SECRET);
    },
  );

describe('#4096 GraphQL node writes', () => {
  const fields: [string, Record<string, unknown>][] = [
    ['content', { content: nul }],
    ['name', { name: nul }],
    ['description', { description: nul }],
    ['abstract', { abstract: nul }],
    ['tags', { tags: ['ok', nul] }],
  ];
  for (const [field, patch] of fields) {
    it(`createNode refuses a NUL in ${field} typed, naming the field, with no row written`, async () => {
      await refused(M.createNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N', ...patch } }, ctx(admin.id)), field);
      expect(await nodes()).toBe(0);
    });
  }
  for (const [field, patch] of fields) {
    it(`updateNode refuses a NUL in ${field} typed and leaves the node untouched`, async () => {
      await M.createNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N', content: 'before' } }, ctx(admin.id));
      await refused(M.updateNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N', ...patch } }, ctx(admin.id)), field);
      expect((await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'n1' } })).content).toBe('before');
    });
  }
  it('keeps the authorization refusal ahead of the NUL refusal', async () => {
    const e: any = await M.createNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N', content: nul } }, ctx(outsider.id)).catch((x: any) => x);
    expect(e.extensions?.code).not.toBe('BAD_USER_INPUT');
    expect(e.name).toBe('MemoryNotFoundError');
  });
  for (const [field, patch] of [['content', { content: 'a\ud800b' }], ['name', { name: 'a\udc00b' }], ['tags', { tags: ['a\ud83d'] }]] as [string, any][]) {
    it(`createNode refuses an unpaired surrogate in ${field} the same way (lone surrogates fail the same write)`, async () => {
      await refused(M.createNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N', ...patch } }, ctx(admin.id)), field);
      expect(await nodes()).toBe(0);
    });
  }
  it('still stores a valid non-BMP pair (control)', async () => {
    const node = await M.createNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N 😀', content: 'a😀b' } }, ctx(admin.id));
    expect(node.content).toBe('a😀b');
  });
  it('still stores a U+0001 control character (control)', async () => {
    const node = await M.createNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N', content: 'a\u0001b' } }, ctx(admin.id));
    expect(node.content).toBe('a\u0001b');
  });
});

describe('#4096 MCP node tools (parity: typed refusal with the code, no row written)', () => {
  const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
  const shape = (text: string, field: string) => {
    expect(text).toMatch(/\[bad_user_input\]/i);
    expect(text).toContain(field);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/internal/i);
  };
  for (const [field, patch] of [['content', { content: nul }], ['name', { name: nul }], ['description', { description: nul }], ['abstract', { abstract: nul }], ['tags', { tags: ['ok', nul] }]] as [string, any][]) {
    it(`hadron_create_node refuses a NUL in ${field}`, async () => {
      const text = await mcp(admin.id).callToolText('hadron_create_node', { urn: urn('n1'), name: 'N', ...patch });
      shape(text, field);
      expect(await nodes()).toBe(0);
    });
    it(`hadron_update_node refuses a NUL in ${field}`, async () => {
      await M.createNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N', content: 'before' } }, ctx(admin.id));
      const text = await mcp(admin.id).callToolText('hadron_update_node', { urn: urn('n1'), ...patch });
      shape(text, field);
      expect((await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'n1' } })).content).toBe('before');
    });
  }
  it('hadron_create_node refuses an unpaired surrogate in content', async () => {
    const text = await mcp(admin.id).callToolText('hadron_create_node', { urn: urn('n1'), name: 'N', content: 'a\ud800b' });
    shape(text, 'content');
    expect(await nodes()).toBe(0);
  });
  for (const [field, patch] of [['name', { name: nul }], ['description', { description: nul }], ['tags', { tags: ['ok', nul] }]] as [string, any][]) {
    it(`hadron_create_parent_node refuses a NUL in ${field}`, async () => {
      const text = await mcp(admin.id).callToolText('hadron_create_parent_node', { urn: urn('p1'), ...patch });
      shape(text, field);
      expect(await nodes()).toBe(0);
    });
  }
});

describe('#4096 team-chat append', () => {
  let shared: any;
  beforeEach(async () => {
    app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: 'nul4096.test:team' } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: 'nul4096.test:team', visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'member' } });
    shared = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'nul4096.test:team-shared', name: 'shared', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
    await ensureChannelWithRoot(db, { memoryId: shared.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id });
  });
  it('createTeamChatMessage refuses a NUL in body typed, before anything is appended', async () => {
    const before = await db.node.count({ where: { memoryId: shared.id } });
    await refused(teamChatMutations.createTeamChatMessage({}, { appRef: app.id, body: nul, replyToSeq: null, sessionRef: null }, ctx(admin.id)), 'body');
    expect(await db.node.count({ where: { memoryId: shared.id } })).toBe(before);
  });
  it('createChannelMessage (the Channel-addressed door) refuses it the same way; MCP carries no chat tools (#3082)', async () => {
    const channel = await db.channel.findFirstOrThrow({ where: { memoryId: shared.id } });
    const before = await db.node.count({ where: { memoryId: shared.id } });
    await refused(M.createChannelMessage({}, { channelRef: channel.id, body: nul, replyToSeq: null, sessionRef: null }, ctx(admin.id)), 'body');
    expect(await db.node.count({ where: { memoryId: shared.id } })).toBe(before);
  });
});

describe('#4096 the shared wrapper stays untyped (server-copied text is a server fault)', () => {
  it('mapChatSeqConflict rethrows a 22021 unchanged', async () => {
    const { mapChatSeqConflict } = await import('../../../lib/prismaErrors.js');
    const fault = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
    await expect(mapChatSeqConflict(() => Promise.reject(fault))).rejects.toBe(fault);
  });
});
