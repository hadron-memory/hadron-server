/**
 * #3519 (ruling 0226 + 0232, cor:cht:010:02, cor:api:000, cor:acl:010:01): the no-App knowledge holding that
 * `startChat` creates for a user with no App installing the chatbot is read by the user it serves, on MCP as on
 * GraphQL. MCP refused that user (no creator arm in `canReadMemoryRow`). The build adds ONE arm there; this file pins it.
 *
 * H is created by the real `startChat`. Rows built by hand are labelled SYNTHETIC: each asserts that this MCP arm
 * grants nothing for that shape, not that the shape is unreachable. GraphQL is asserted only for the legal H shapes
 * it already serves on the checked base. Writes and the access map are pinned unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { runAuthContext } from '../lib/auth/runPrincipal.js';
import { hadronReadNode } from '../lib/runner/tools/nodeTools.js';
import { canReadMemory, canWriteToMemory, filterReadableMemoryIds, getMemoryAccess } from './access-control.js';
import { createTestableMcpServer } from './server.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import type { AuthContext } from '../middleware/auth.js';
import type { RunToolContext } from '../lib/runner/tools/types.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any;
const LOC = 'chat:entry';
let f: Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const suffix = generateId().toLowerCase();
  const orgO = await db.organization.create({ data: { name: 'Agent org', urn: `agentorg-${suffix}.example` } });
  const elsewhere = await db.organization.create({ data: { name: 'Elsewhere', urn: `else-${suffix}.example` } });
  const user = async (h: string, roles: ('ADMIN' | 'READER')[] = ['READER']) =>
    db.user.create({ data: { id: generateId(), handle: `${h}-${suffix}`, roles } as never });
  const creatorOut = await user('creator-out'); // not in the Agent's org
  const creatorIn = await user('creator-in'); // a member of the Agent's org
  const contributor = await user('contributor');
  const orgAdmin = await user('orgadmin');
  const outsider = await user('outsider');
  const platformAdmin = await user('platform', ['ADMIN']);
  await db.orgMember.createMany({ data: [
    { organizationId: orgO.id, userId: creatorIn.id, role: 'READER' },
    { organizationId: orgO.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    { organizationId: orgO.id, userId: orgAdmin.id, role: 'ADMIN' },
  ] });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgO.id, name: 'Holder', urn: `${orgO.urn}:holder`, visibility: 'PUBLIC' } as never });

  // A servable conversation in the Agent's own system memory, as startChat needs.
  const sys = await db.memory.create({ data: { id: generateId(), urn: `${orgO.urn}:sys`, name: 'sys', organizationId: orgO.id, class: 'system' } as never });
  await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: sys.id } as never });
  for (const [loc, data, content] of [
    ['conversations', null, null],
    ['conversations:c', { stageOrder: ['s'], isSetup: false }, null],
    ['conversations:c:s', { promptRef: 'prompts:c:s' }, null],
    ['prompts', null, null], ['prompts:c', null, null], ['prompts:c:s', null, 'Hi.'],
  ] as const) {
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc, name: loc.split(':').pop()!, nodeType: 'system', data: data as never, content } });
  }
  await serveAgentBootPrompt(db, agent.id, 'Hi.');

  // H: the REAL startChat, no App installs the Agent.
  const startAs = async (u: { id: string }) => {
    // #4046: create the real standalone holding under lawful manager reach, then
    // restore the original membership before any MCP/GraphQL holding-access assertion.
    const key = { organizationId_userId: { organizationId: orgO.id, userId: u.id } };
    const prior = await db.orgMember.findUnique({ where: key });
    await db.orgMember.upsert({ where: key,
      create: { organizationId: orgO.id, userId: u.id, role: 'ADMIN' }, update: { role: 'ADMIN' } });
    try {
      await resolvers.Mutation.startChat({}, { agentId: agent.id }, { db, userId: u.id, roles: ['READER'] } as never);
    } finally {
      if (prior) await db.orgMember.update({ where: key, data: { role: prior.role } });
      else await db.orgMember.delete({ where: key });
    }
    const h = await db.memory.findFirstOrThrow({ where: { userMemoryOfAgentId: agent.id, createdBy: u.id } });
    await db.node.create({ data: { memoryId: h.id, loc: LOC, name: `needle3519 ${h.id}`, content: `secret ${h.id}`, nodeType: 'record' } });
    return h;
  };
  const hOut = await startAs(creatorOut);
  const hIn = await startAs(creatorIn);
  for (const h of [hOut, hIn]) {
    expect(h).toMatchObject({ class: 'knowledge', appId: null, userId: null, ownerUserId: null, userMemoryOfAgentId: agent.id });
  }

  const { app, appKey } = await createDbAppWithKey(db, 'unrelated3519', elsewhere.id);
  const session = await db.session.create({ data: { id: generateId(), appId: app.id, userId: creatorOut.id } as never });
  const synthetic = async (slug: string, extra: Record<string, unknown>) => {
    const m = await db.memory.create({ data: {
      name: slug, urn: `${orgO.urn}:${slug}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: orgO.id,
      userMemoryOfAgentId: agent.id, createdBy: creatorOut.id, ...extra,
    } as never });
    await db.node.create({ data: { memoryId: m.id, loc: LOC, name: `needle3519 ${slug}`, content: `secret ${slug}`, nodeType: 'record' } });
    return m;
  };
  const appSet = await synthetic('appset', { appId: app.id });
  const groupRow = await synthetic('grouprow', { class: 'group', visibility: 'GROUP' });
  const nonHolding = await synthetic('nonholding', { userMemoryOfAgentId: null });
  const anonCreated = await synthetic('anoncreated', { createdBy: app.id });
  const personal = await db.memory.create({ data: {
    name: 'personal', urn: `${orgO.urn}:personal`, class: 'personal', organizationId: orgO.id, userId: creatorOut.id, createdBy: creatorOut.id,
  } as never });
  await db.node.create({ data: { memoryId: personal.id, loc: LOC, name: 'needle3519 personal', content: 'secret personal', nodeType: 'record' } });
  const otherUsersMemory = await synthetic('foreign', { createdBy: outsider.id });

  const ctx = (u: { id: string }, extra: Partial<AuthContext> = {}): AuthContext =>
    ({ userId: u.id, roles: ['READER'], ...extra }) as AuthContext;
  const run = await db.appRun.create({ data: {
    id: generateId(), organizationId: elsewhere.id, appId: app.id, userId: creatorOut.id, triggerKind: 'SCHEDULE',
    triggerId: (await db.agentSchedule.create({ data: { id: generateId(), organizationId: elsewhere.id, appId: app.id, name: 'S', cron: '* * * * *', entryNodeUrn: `hrn:node:${hOut.urn}:${LOC}` } })).id,
    entryNodeUrn: `hrn:node:${hOut.urn}:${LOC}`,
  } as never });
  const runPrincipal = runAuthContext(run);
  const runTool: RunToolContext = { db, run, principal: { db, ...runPrincipal } as never, log: () => undefined };
  return { orgO, agent, creatorOut, creatorIn, contributor, orgAdmin, outsider, platformAdmin, hOut, hIn, app, appKey, session,
    appSet, groupRow, nonHolding, anonCreated, personal, otherUsersMemory, ctx, runPrincipal, runTool };
}
const urn = (m: { urn: string }, loc = LOC) => `hrn:node:${m.urn}:${loc}`;
const unknownUrn = () => `hrn:node:${f.orgO.urn}:nosuchmemory:${LOC}`;
beforeEach(async () => { await cleanDb(db); f = await fixture(); }, 60_000);

describe('#3519 the no-App holding is read by its user over MCP', () => {
  describe('RED: the creator reads H (cells 1-3)', () => {
    it.each([
      ['1 creator outside the Agent org', () => ({ who: f.creatorOut, h: f.hOut, extra: {} })],
      ['2 creator inside the Agent org', () => ({ who: f.creatorIn, h: f.hIn, extra: {} })],
      ['3 creator with an unrelated active App (hybrid selection)', () => ({ who: f.creatorOut, h: f.hOut, extra: { appId: f.app.id } })],
    ] as const)('%s: gate, batch and the real MCP tools admit', async (_n, make) => {
      const { who, h, extra } = make();
      const auth = f.ctx(who, extra);
      expect(await canReadMemory(db, auth, h.id)).toBe(true);
      expect([...(await filterReadableMemoryIds(db, auth, [h.id, f.hIn.id, f.hOut.id, f.otherUsersMemory.id]))]).toEqual([h.id]);
      const mcp = createTestableMcpServer(auth);
      expect(await mcp.callToolText('hadron_get_node', { urn: urn(h) })).toContain(`secret ${h.id}`);
      expect(await mcp.callToolText('hadron_find_nodes', { query: 'needle3519', mode: 'keyword', memoryUrn: `hrn:mem:${h.urn}` })).toContain(`needle3519 ${h.id}`);
    }, 30_000);
    it('GraphQL already serves cells 1 and 2 (parity, green on the base)', async () => {
      expect(await Q.node({}, { ref: urn(f.hOut) }, { db, ...f.ctx(f.creatorOut) })).toMatchObject({ content: `secret ${f.hOut.id}` });
      expect(await Q.node({}, { ref: urn(f.hIn) }, { db, ...f.ctx(f.creatorIn) })).toMatchObject({ content: `secret ${f.hIn.id}` });
    });
  });

  describe('controls: nothing else is admitted, each refusal identical to an unknown ref (cells 4, 5, 8-11)', () => {
    const refused = async (auth: AuthContext, m: { id: string; urn: string }) => {
      expect(await canReadMemory(db, auth, m.id)).toBe(false);
      expect([...(await filterReadableMemoryIds(db, auth, [m.id]))]).toEqual([]);
      const mcp = createTestableMcpServer(auth);
      const hidden = await mcp.callToolText('hadron_get_node', { urn: urn(m) });
      const missing = await mcp.callToolText('hadron_get_node', { urn: unknownUrn() });
      expect(hidden).not.toContain('secret');
      expect(hidden.replaceAll(m.urn, 'X')).toBe(missing.replaceAll(`${f.orgO.urn}:nosuchmemory`, 'X'));
    };
    it('4 a non-creator org CONTRIBUTOR and org ADMIN', async () => {
      await refused(f.ctx(f.contributor), f.hIn);
      await refused(f.ctx(f.orgAdmin), f.hIn);
      expect(await Q.node({}, { ref: urn(f.hIn) }, { db, ...f.ctx(f.orgAdmin) })).toBeNull();
    }, 30_000);
    it('5 an outsider', async () => { await refused(f.ctx(f.outsider), f.hOut); }, 30_000);
    it('creator B does not read creator A\'s holding', async () => { await refused(f.ctx(f.creatorIn), f.hOut); }, 30_000);
    it('7 impersonation of the creator: the gate refuses (layered; MCP also refuses at init)', async () => {
      const auth = f.ctx(f.creatorOut, { impersonation: { actorUserId: f.platformAdmin.id } as never });
      expect(await canReadMemory(db, auth, f.hOut.id)).toBe(false);
      expect([...(await filterReadableMemoryIds(db, auth, [f.hOut.id]))]).toEqual([]);
    });
    it('8a/8b/9 a bound worker session (init, per request) and a refused named binding get no arm', async () => {
      for (const extra of [
        { sessionId: f.session.id },
        { requestSession: { sessionId: f.session.id, refused: false } },
        { requestSession: { refused: true } },
        { sessionBindingRefused: true },
      ] as Partial<AuthContext>[]) {
        const auth = f.ctx(f.creatorOut, extra);
        expect(await canReadMemory(db, auth, f.hOut.id), JSON.stringify(extra)).toBe(false);
        expect([...(await filterReadableMemoryIds(db, auth, [f.hOut.id]))], JSON.stringify(extra)).toEqual([]);
      }
    });
    it('10 an AppRun on behalf of the creator: the gate and the run read path refuse', async () => {
      const auth = { db, ...f.runPrincipal } as AuthContext;
      expect(await canReadMemory(db, auth, f.hOut.id)).toBe(false);
      let err: unknown = null;
      try { await hadronReadNode.execute(f.runTool, { urn: urn(f.hOut) }); } catch (e) { err = e; }
      expect(err).not.toBeNull();
    });
    it('11 a pure App key and a session-bound App key', async () => {
      await refused({ appId: f.app.id, appKeyId: f.appKey.id, roles: [] } as unknown as AuthContext, f.hOut);
      await refused({ appId: f.app.id, appKeyId: f.appKey.id, sessionId: f.session.id, roles: [] } as unknown as AuthContext, f.hOut);
    }, 30_000);
    it('an App key carrying a user id (hybrid shape with appKeyId) gets no arm', async () => {
      await refused(f.ctx(f.creatorOut, { appId: f.app.id, appKeyId: f.appKey.id }), f.hOut);
    }, 30_000);
  });

  describe('platform bypass and positive control', () => {
    it('6 the platform ADMIN who is not the creator still reads H (unchanged, ruling 0232 Q1)', async () => {
      const auth = f.ctx(f.platformAdmin, { roles: ['ADMIN'] });
      expect(await canReadMemory(db, auth, f.hOut.id)).toBe(true);
    });
    it('12 the owner reads their own personal memory (unchanged)', async () => {
      expect(await canReadMemory(db, f.ctx(f.creatorOut), f.personal.id)).toBe(true);
      expect(await canReadMemory(db, f.ctx(f.outsider), f.personal.id)).toBe(false);
    });
  });

  describe('SYNTHETIC rows: this MCP arm grants nothing (cells 13-16)', () => {
    it.each(['appSet', 'groupRow', 'nonHolding', 'anonCreated', 'otherUsersMemory'] as const)('%s is not admitted to the creator by the arm', async name => {
      const m = f[name];
      // creator of every row but otherUsersMemory is creatorOut
      expect(await canReadMemory(db, f.ctx(f.creatorOut), m.id)).toBe(false);
      expect([...(await filterReadableMemoryIds(db, f.ctx(f.creatorOut), [m.id]))]).toEqual([]);
    });
    it('16 a holding whose createdBy is an App id is not admitted to a pure key or to a user of that App', async () => {
      const keyAuth = { appId: f.app.id, appKeyId: f.appKey.id, roles: [] } as unknown as AuthContext;
      expect(await canReadMemory(db, keyAuth, f.anonCreated.id)).toBe(false);
      expect(await canReadMemory(db, f.ctx(f.outsider, { appId: f.app.id }), f.anonCreated.id)).toBe(false);
    });
  });

  describe('explicit-id and scoped retrieval keep only admitted memories (cell 17)', () => {
    it('hadron_get_nodes and hadron_find_nodes over a mixed set return H only, and a refused member refuses the set', async () => {
      const mcp = createTestableMcpServer(f.ctx(f.creatorOut));
      const mixed = await mcp.callToolText('hadron_find_nodes', {
        query: 'needle3519', mode: 'keyword', memoryUrns: [`hrn:mem:${f.hOut.urn}`, `hrn:mem:${f.hIn.urn}`],
      });
      expect(mixed).toContain('Memory not found');
      expect(mixed).not.toContain(`needle3519 ${f.hOut.id}`);
      expect(mixed).not.toContain(`needle3519 ${f.hIn.id}`);
      const gotNodes = await mcp.callToolText('hadron_get_nodes', { refs: [urn(f.hOut), urn(f.hIn)] });
      expect(gotNodes).toContain(`secret ${f.hOut.id}`);
      expect(gotNodes).not.toContain(`secret ${f.hIn.id}`);
    }, 30_000);
  });

  describe('no widening (cell 18)', () => {
    it('writes stay refused and the access map never carries H', async () => {
      const auth = f.ctx(f.creatorOut);
      expect(await canWriteToMemory(db, auth, f.hOut.id)).toBe(false);
      expect((await getMemoryAccess(db, auth)).has(f.hOut.id)).toBe(false);
      const mcp = createTestableMcpServer(auth);
      const before = await mcp.callToolText('hadron_update_node', { urn: urn(f.hOut), content: 'changed' });
      expect(await db.node.findFirst({ where: { memoryId: f.hOut.id, loc: LOC } })).toMatchObject({ content: `secret ${f.hOut.id}` });
      expect(before).not.toContain('Updated');
    }, 30_000);
    it('a refused read leaves no memory, node or edge behind', async () => {
      const counts = async () => ({ m: await db.memory.count(), n: await db.node.count(), e: await db.edge.count() });
      const before = await counts();
      await createTestableMcpServer(f.ctx(f.outsider)).callToolText('hadron_get_node', { urn: urn(f.hOut) });
      expect(await counts()).toEqual(before);
    }, 30_000);
  });
});
