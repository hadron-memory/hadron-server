/**
 * #4106 — #4096's class at the write entries it did not cover: edge create/update, comment create/reply/edit and the
 * memory-level text of the three memory-create doors. Caller text with a NUL (or an unpaired surrogate) must be refused
 * typed (BAD_USER_INPUT, field named, value never echoed) before any write, on GraphQL and on the MCP tools.
 * Server-authored text stays a server fault (not tested here: nothing at these doors writes it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
afterEach(() => vi.restoreAllMocks());

const M = resolvers.Mutation as any;
const SECRET = 'SECRETVALUE';
const nul = `${SECRET}\0tail`;
const lone = `${SECRET}\ud800tail`;
let admin: any, org: any, memory: any, memoryUrn: string, n1: any, n2: any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['ADMIN'] as any, clientId: `user:${userId}` });
const mcp = () => createTestableMcpServer({ userId: admin.id, roles: ['ADMIN'] as any, clientId: `user:${admin.id}` });
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;

beforeEach(async () => {
  await cleanDb(db);
  admin = await db.user.create({ data: { githubId: 410601, githubUsername: 'admin4106', roles: ['ADMIN'] } });
  org = await db.organization.create({ data: { id: generateId(), name: 'org4106', urn: 'nul4106.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memoryUrn = `nul4106.test:mem-${generateId().slice(0, 8).toLowerCase()}`;
  memory = await db.memory.create({ data: { name: 'mem4106', urn: memoryUrn, class: 'knowledge', organizationId: org.id } });
  n1 = await M.createNode({}, { input: { memoryId: memory.id, loc: 'n1', name: 'N1', content: 'one' } }, ctx(admin.id));
  n2 = await M.createNode({}, { input: { memoryId: memory.id, loc: 'n2', name: 'N2', content: 'two' } }, ctx(admin.id));
});

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
const shape = (text: string, field: string) => {
  expect(text).toMatch(/\[bad_user_input\]/i);
  expect(text).toContain(field);
  expect(text).not.toContain(SECRET);
  expect(text).not.toMatch(/internal/i);
};
const edges = () => db.edge.count({ where: { memoryId: memory.id } });
const comments = () => db.node.count({ where: { memoryId: memory.id, nodeType: 'comment' } });

describe('#4106 createEdge / updateEdge', () => {
  const create = (extra: Record<string, unknown>) => M.createEdge({}, { sourceRef: n1.id, targetRef: n2.id, ...extra }, ctx(admin.id));
  for (const [field, patch] of [
    ['name', { name: nul }], ['description', { description: nul }],
    ['data', { data: { k: nul } }], ['data', { data: { [nul]: 1 } }],
    ['name', { name: lone }],
  ] as [string, Record<string, unknown>][]) {
    it(`createEdge refuses unstorable text in ${field} typed, writing no edge`, async () => {
      await refused(create(patch), field);
      expect(await edges()).toBe(0);
    });
  }
  it('loc and condition already refuse with their own typed codes, never a server fault (existing behaviour)', async () => {
    for (const patch of [{ loc: nul }, { condition: { k: nul } }]) {
      const e: any = await create(patch).catch((x: any) => x);
      expect(e.extensions?.code).toBeTruthy();
      expect(e.extensions.code).not.toBe('INTERNAL_SERVER_ERROR');
      expect(e.message).not.toContain(SECRET);
    }
    expect(await edges()).toBe(0);
  });
  it('updateEdge refuses it typed and leaves the edge untouched', async () => {
    const e = await create({ name: 'ok' });
    const snap = await db.edge.findUniqueOrThrow({ where: { id: e.id } });
    for (const [field, patch] of [['name', { name: nul }], ['description', { description: nul }], ['data', { data: { k: nul } }]] as [string, any][]) {
      await refused(M.updateEdge({}, { edgeRef: e.id, ...patch }, ctx(admin.id)), field);
    }
    expect(await db.edge.findUniqueOrThrow({ where: { id: e.id } })).toEqual(snap);
  });
  it('hadron_create_edge refuses it typed with the code, writing no edge', async () => {
    for (const [field, patch] of [['name', { name: nul }], ['description', { description: nul }]] as [string, any][]) {
      shape(await mcp().callToolText('hadron_create_edge', { sourceUrn: urn('n1'), targetUrn: urn('n2'), ...patch }), field);
    }
    expect(await edges()).toBe(0);
  });
  it('hadron_update_edge refuses it typed with the code', async () => {
    const e = await create({ name: 'ok' });
    shape(await mcp().callToolText('hadron_update_edge', { edgeRef: e.id, name: nul }), 'name');
    expect((await db.edge.findUniqueOrThrow({ where: { id: e.id } })).name).toBe('ok');
  });
  it('still stores ordinary text, a non-BMP pair and U+0001 (controls)', async () => {
    const e = await create({ name: 'a😀b', description: 'x\u0001y', data: { k: 'v' } });
    expect(e.name).toBe('a😀b');
  });
  it('keeps the write-access refusal ahead of the NUL refusal', async () => {
    const stranger = await db.user.create({ data: { githubId: 410602, githubUsername: 'stranger4106', roles: [] } });
    const e: any = await M.createEdge({}, { sourceRef: n1.id, targetRef: n2.id, name: nul }, { db, userId: stranger.id, roles: [], clientId: `user:${stranger.id}` }).catch((x: any) => x);
    expect(e.extensions?.code).not.toBe('BAD_USER_INPUT');
  });
});

describe('#4106 comments', () => {
  it('createComment refuses a NUL in body and quote typed, writing no comment', async () => {
    await refused(M.createComment({}, { targetRef: n1.id, body: nul }, ctx(admin.id)), 'body');
    await refused(M.createComment({}, { targetRef: n1.id, body: 'ok', quote: nul }, ctx(admin.id)), 'quote');
    await refused(M.createComment({}, { targetRef: n1.id, body: lone }, ctx(admin.id)), 'body');
    expect(await comments()).toBe(0);
  });
  it('replyToComment and editComment refuse it typed and leave the thread untouched', async () => {
    const c = await M.createComment({}, { targetRef: n1.id, body: 'first' }, ctx(admin.id));
    await refused(M.replyToComment({}, { commentRef: c.id, body: nul }, ctx(admin.id)), 'body');
    await refused(M.editComment({}, { commentRef: c.id, body: nul }, ctx(admin.id)), 'body');
    await refused(M.editComment({}, { commentRef: c.id, quote: nul }, ctx(admin.id)), 'quote');
    expect(await comments()).toBe(1);
  });
  it('the MCP comment tools refuse it typed with the code', async () => {
    shape(await mcp().callToolText('hadron_create_comment', { targetRef: n1.id, body: nul }), 'body');
    expect(await comments()).toBe(0);
    const c = await M.createComment({}, { targetRef: n1.id, body: 'first' }, ctx(admin.id));
    shape(await mcp().callToolText('hadron_reply_to_comment', { commentRef: c.id, body: nul }), 'body');
    shape(await mcp().callToolText('hadron_edit_comment', { commentRef: c.id, body: nul }), 'body');
    expect(await comments()).toBe(1);
  });
  it('still stores ordinary and non-BMP comment text (control)', async () => {
    const c = await M.createComment({}, { targetRef: n1.id, body: 'a😀b' }, ctx(admin.id));
    expect(c.body).toBe('a😀b');
  });
});

describe('#4106 memory-level text', () => {
  const memories = () => db.memory.count();
  let app: any, agent: any;
  beforeEach(async () => {
    app = await db.app.create({ data: { name: 'App4106', urn: 'u4106:app', ownerUserId: admin.id } });
    agent = await db.agent.create({ data: { name: 'Agent4106', urn: 'u4106:agent', ownerUserId: admin.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  });
  const base = () => memories();
  for (const [field, patch] of [
    ['name', { name: nul }], ['shortDescription', { shortDescription: nul }], ['description', { description: nul }],
    ['tags', { tags: ['ok', nul] }], ['description', { description: lone }],
  ] as [string, any][]) {
    it(`createAppMemory refuses unstorable text in ${field} typed, writing nothing`, async () => {
      const before = await base();
      await refused(M.createAppMemory({}, { appRef: app.id, name: 'Notes', ...patch }, ctx(admin.id)), field);
      expect(await memories()).toBe(before);
    });
    it(`createMemoryInApp refuses it in ${field} typed, writing nothing`, async () => {
      const before = await base();
      await refused(M.createMemoryInApp({}, { appRef: app.id, agentRef: agent.id, memoryClass: 'app', name: 'Notes', ...patch }, ctx(admin.id)), field);
      expect(await memories()).toBe(before);
    });
    it(`createMemory refuses it in ${field} typed, writing nothing`, async () => {
      const before = await base();
      await refused(M.createMemory({}, { orgId: org.id, memoryClass: 'knowledge', name: 'Notes', ...patch }, ctx(admin.id)), field);
      expect(await memories()).toBe(before);
    });
  }
  it('the MCP memory-create tools refuse it typed with the code', async () => {
    const before = await base();
    shape(await mcp().callToolText('hadron_create_memory', { name: 'Notes', org: org.id, description: nul }), 'description');
    shape(await mcp().callToolText('hadron_create_app_memory', { app: app.id, name: 'Notes', shortDescription: nul }), 'shortDescription');
    expect(await memories()).toBe(before);
  });
  it('still creates with ordinary text (control)', async () => {
    const m = await M.createAppMemory({}, { appRef: app.id, name: 'Notes 😀', description: 'a😀b' }, ctx(admin.id));
    expect(m.description).toBe('a😀b');
  });
});
