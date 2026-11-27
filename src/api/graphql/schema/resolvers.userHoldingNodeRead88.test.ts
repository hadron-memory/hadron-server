/**
 * The node-side read gates for a per-user chat holding (hadron-internal#88, cor:cht:010:02, ruling 0226 and Holger's 2026-11-27 decision "User only", which supersedes ruling 0232 Q1): the
 * holding's nodes are read by its creator alone, whatever the caller's global role, on GraphQL and on MCP alike. Seeded through
 * a real startChat under a seed App, reshaped to the row the retired no-App route wrote (#5394); the platform admins are REAL
 * user rows, since a context-only role gives a false null.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { canReadMemory, canWriteToMemory, filterReadableMemoryIds } from '../../../mcp/access-control.js';
import { resolvers, type Context } from './resolvers.js';
import { getAccessibleMemoryIds, requireMemoryWriteAccess } from './resolvers.helpers.js';
import { foreignIdentityScopedMemoryFilter } from '../../../lib/auth/memoryOwnership.js';
import { isForeignUserHolding, isUserHolding } from '../../../lib/auth/userHolding.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const NEEDLE = 'needle88';
let orgId: string, otherOrgId: string, agentId: string, appId: string;
let holdingId: string, holdingUrn: string, nodeId: string, nodeLoc: string, plainId: string, plainUrn: string;
const u: Record<string, string> = {};
const ROLES: Record<string, string[]> = { platformadmin: ['ADMIN'], platformowner: ['OWNER'], orgadminplat: ['ADMIN'] };
const gql = (who: string): Context => ({ db, userId: u[who], roles: ROLES[who] ?? ['READER'] }) as Context;
const mcpAuth = (who: string) => ({ userId: u[who], roles: ROLES[who] ?? [], clientId: `user:${u[who]}` });
const mcp = (who: string) => createTestableMcpServer(mcpAuth(who) as never);

async function user(handle: string, orgRole?: 'READER' | 'CONTRIBUTOR' | 'ADMIN' | 'OWNER', org = orgId) {
  const id = (await db.user.create({ data: { handle, roles: (ROLES[handle] ?? ['READER']) as never } })).id;
  u[handle] = id;
  if (orgRole) await db.orgMember.create({ data: { organizationId: org, userId: id, role: orgRole } });
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { name: 'Holding88 org', urn: 'holding88.test' } })).id;
  otherOrgId = (await db.organization.create({ data: { name: 'Other88 org', urn: 'holdother88.test' } })).id;
  await user('creator', 'ADMIN');
  await user('member', 'READER');
  await user('orgadmin', 'ADMIN');
  await user('orgowner', 'OWNER');
  await user('foreigner', 'READER', otherOrgId);
  await user('outsider');
  await user('platformadmin');
  await user('platformowner');
  await user('orgadminplat', 'READER'); // a platform ADMIN who is also an org member
  const agent = await M.createAgent({}, { orgRef: orgId, name: 'Holding88 agent', visibility: 'ORGANIZATION' }, gql('creator'));
  agentId = agent.id;
  for (const row of [
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts:step', content: 'STAGE', data: {} },
  ]) await db.node.create({ data: { memoryId: agent.systemMemoryId, name: row.loc, nodeType: 'system', ...row } });
  await serveEveryAgent(db);
  // #5394: before, the holding came from a real no-App start (the Agent's manager started a chat with no installed App).
  // That route is retired, so a start with no App is refused, and the holding such a start left is made the way it left
  // it: a real start under a seed App, then the home reshaped to the retired route's row (knowledge, no App, no owner
  // column, ORGANIZATION), and the seed App removed. Holdings of this shape exist until #5394's deletion runs.
  await expect(M.startChat({}, { agentRef: agentId, scope: 'private', conversationName: 'flow' }, gql('creator')))
    .rejects.toMatchObject({ code: 'CHAT_APP_NOT_IDENTIFIED' });
  const seedApp = await db.app.create({ data: { name: 'Seed app', urn: 'holding88.test:seed', organizationId: orgId, appAgents: { create: { agentId } } } });
  const started = await M.startChat({}, { agentRef: agentId, appRef: seedApp.id, scope: 'private', conversationName: 'flow' }, gql('creator'));
  const root = await chatNodeByLocOrThrow(db, started.chatId);
  holdingId = root.memoryId;
  await db.memory.update({ where: { id: holdingId }, data: { class: 'knowledge', userId: null, appId: null, visibility: 'ORGANIZATION' } });
  await db.app.delete({ where: { id: seedApp.id } });
  nodeId = root.id;
  nodeLoc = root.loc;
  await db.node.update({ where: { id: nodeId }, data: { name: `${NEEDLE} private chat`, content: `${NEEDLE} secret content` } });
  const holding = await db.memory.findUniqueOrThrow({ where: { id: holdingId } });
  holdingUrn = holding.urn;
  // The fixture asserts its own shape, so these pins cannot go green on a different row.
  expect(holding).toMatchObject({ class: 'knowledge', ownerUserId: null, appId: null, userMemoryOfAgentId: agentId, createdBy: u.creator });
  plainId = (await db.memory.create({
    data: { id: generateId(), name: 'Plain', urn: 'holding88.test:plain', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION', createdBy: u.creator },
  })).id;
  plainUrn = 'holding88.test:plain';
  await db.node.create({ data: { id: generateId(), memoryId: plainId, loc: 'docs:entry', name: `${NEEDLE} plain`, content: `${NEEDLE} plain content` } });
  appId = (await db.app.create({ data: { name: 'Home app', urn: 'holding88.test:app', organizationId: orgId } })).id;
});

const missingUrn = 'holding88.test:never-existed';
const readsByIdGql = async (who: string) => !!(await Q.node({}, { ref: nodeId }, gql(who)));
const nodeByLocGql = async (who: string, memoryRef: string, loc = nodeLoc) => {
  try { return { node: !!(await Q.node({}, { ref: loc, memoryRef }, gql(who))) }; } catch (e: any) { return { code: e?.extensions?.code ?? 'error', message: String(e?.message ?? '').replace(/[0-9a-z]{32}|holding88\.test:[a-z0-9-]+/gi, '<REF>') }; }
};
const findGql = async (who: string, scoped: boolean) => {
  const out = await Q.findNodes({}, { query: NEEDLE, mode: 'keyword', limit: 50, ...(scoped ? { filter: { memoryRefs: [holdingId] } } : {}) }, gql(who));
  return out.hits.map((h: { node: { memoryId: string } }) => h.node.memoryId).filter((m: string) => m === holdingId).length;
};
const code88 = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e?.extensions?.code ?? e?.message ?? 'error'; } };
const norm = (text: string, ...refs: string[]) => refs.reduce((t, r) => t.split(r).join('<REF>'), text);

describe('a per-user chat holding is read on the node side by its creator alone (hadron-internal#88)', () => {
  it('the creator reads and lists it on GraphQL and MCP (controls)', async () => {
    expect(await readsByIdGql('creator')).toBe(true);
    expect(await nodeByLocGql('creator', holdingId)).toEqual({ node: true });
    expect(await findGql('creator', true)).toBeGreaterThan(0);
    expect(await mcp('creator').callToolText('hadron_list_nodes', { memoryUrn: `hrn:mem:${holdingUrn}`, depth: 2 })).toContain(nodeLoc.split(':').pop()!);
    expect(await mcp('creator').callToolText('hadron_find_nodes', { memoryUrn: `hrn:mem:${holdingUrn}`, query: NEEDLE, mode: 'keyword' })).toContain(NEEDLE);
    expect(await mcp('creator').callToolText('hadron_get_node', { urn: `hrn:node:${holdingUrn}:${nodeLoc}` })).toContain(`${NEEDLE} secret content`);
  });

  for (const who of ['platformadmin', 'platformowner', 'orgadminplat'] as const) {
    describe(`a platform ${who === 'platformowner' ? 'OWNER' : 'ADMIN'}${who === 'orgadminplat' ? ' who is an org member' : ''} (real user row)`, () => {
      it('GraphQL: node by id, node by loc+memoryRef and findNodes (scoped and unscoped) return nothing', async () => {
        expect(await readsByIdGql(who)).toBe(false);
        expect(await nodeByLocGql(who, holdingId)).toEqual(await nodeByLocGql(who, generateId()));
        expect(await nodeByLocGql(who, holdingUrn)).toEqual(await nodeByLocGql(who, missingUrn));
        expect((await nodeByLocGql(who, holdingUrn) as { message?: string }).message).toMatch(/nothing found|not found/i);
        expect(await findGql(who, true)).toBe(0);
        expect(await findGql(who, false)).toBe(0);
      });
      it('GraphQL: the node-access set leaves it out', async () => {
        expect(await getAccessibleMemoryIds(gql(who))).not.toContain(holdingId);
        expect(await getAccessibleMemoryIds(gql(who), holdingId)).toEqual([]);
      });
      it('MCP: hadron_list_nodes, hadron_find_nodes (scoped and unscoped) and hadron_get_node show nothing', async () => {
        const list = await mcp(who).callToolText('hadron_list_nodes', { memoryUrn: `hrn:mem:${holdingUrn}`, depth: 2 });
        const find = await mcp(who).callToolText('hadron_find_nodes', { memoryUrn: `hrn:mem:${holdingUrn}`, query: NEEDLE, mode: 'keyword' });
        const findAll = await mcp(who).callToolText('hadron_find_nodes', { query: NEEDLE, mode: 'keyword', allMemories: true });
        const get = await mcp(who).callToolText('hadron_get_node', { urn: `hrn:node:${holdingUrn}:${nodeLoc}` });
        for (const text of [list, find, findAll, get]) {
          expect(text).not.toContain(`${NEEDLE} private chat`);
          expect(text).not.toContain(`${NEEDLE} secret content`);
        }
        expect(list).not.toContain(nodeLoc.split(':').pop()!);
      });
      it('MCP: the point gate and the batch gate refuse it', async () => {
        expect(await canReadMemory(db, mcpAuth(who) as never, holdingId)).toBe(false);
        expect([...(await filterReadableMemoryIds(db, mcpAuth(who) as never, [holdingId, plainId]))]).toEqual([plainId]);
      });
      it('one answer: a non-creator is answered as for a memory that does not exist (GraphQL loc, MCP list and get)', async () => {
        expect(await nodeByLocGql(who, holdingUrn)).toEqual(await nodeByLocGql(who, missingUrn));
        const m = mcp(who);
        expect(norm(await m.callToolText('hadron_list_nodes', { memoryUrn: `hrn:mem:${holdingUrn}`, depth: 2 }), holdingUrn))
          .toBe(norm(await m.callToolText('hadron_list_nodes', { memoryUrn: `hrn:mem:${missingUrn}`, depth: 2 }), missingUrn));
        expect(norm(await m.callToolText('hadron_get_node', { urn: `hrn:node:${holdingUrn}:${nodeLoc}` }), holdingUrn, nodeLoc))
          .toBe(norm(await m.callToolText('hadron_get_node', { urn: `hrn:node:${missingUrn}:${nodeLoc}` }), missingUrn, nodeLoc));
      });
    });
  }

  it('a co-member, an org admin, an org owner, another-org member and an outsider stay refused on every surface', async () => {
    for (const who of ['member', 'orgadmin', 'orgowner', 'foreigner', 'outsider'] as const) {
      expect(await readsByIdGql(who), who).toBe(false);
      expect(await findGql(who, true), who).toBe(0);
      expect(await canReadMemory(db, mcpAuth(who) as never, holdingId), who).toBe(false);
      expect(await mcp(who).callToolText('hadron_get_node', { urn: `hrn:node:${holdingUrn}:${nodeLoc}` }), who).not.toContain(`${NEEDLE} secret content`);
    }
  });

  it('an impersonated session, an App key and a run principal do not read it on the node-read gates', async () => {
    const impersonated = { db, userId: u.creator, roles: [], impersonation: { orgId } } as unknown as Context;
    const appKey = { db, appId, organizationId: orgId, roles: [] } as unknown as Context;
    const run = { db, ...runAuthContext({ id: generateId(), appId, userId: u.creator, organizationId: orgId }) } as unknown as Context;
    for (const [label, c] of [['impersonated', impersonated], ['appKey', appKey], ['run', run]] as const) {
      expect(await getAccessibleMemoryIds(c, holdingId), `${label} node set`).toEqual([]);
      expect(await canReadMemory(db, c as never, holdingId), `${label} MCP gate`).toBe(false);
    }
  });

  it('an App link to the holding reaches nothing for a key or a run; a link to an ordinary memory still does', async () => {
    await db.appMemoryLink.createMany({ data: [
      { appId, memoryId: holdingId, attachedBy: u.creator },
      { appId, memoryId: plainId, attachedBy: u.creator },
    ] });
    const key = { db, appId, appKeyId: generateId(), roles: [] } as unknown as Context;
    const run = { db, ...runAuthContext({ id: generateId(), appId, userId: null, organizationId: orgId }) } as unknown as Context;
    for (const [label, c] of [['key', key], ['run', run]] as const) {
      expect(await canReadMemory(db, c as never, plainId), `${label} plain via MCP`).toBe(true);
      expect(await getAccessibleMemoryIds(c, plainId), `${label} plain via GraphQL`).toEqual([plainId]);
      expect(await canReadMemory(db, c as never, holdingId), `${label} holding via MCP`).toBe(false);
      expect(await getAccessibleMemoryIds(c, holdingId), `${label} holding via GraphQL`).toEqual([]);
    }
  });

  it('an App-bound personal home is unchanged: the creator reads it, a platform admin does not', async () => {
    const homeId = (await db.memory.create({
      data: { id: generateId(), name: 'Home', urn: 'holding88.test:home', organizationId: orgId, class: 'personal', userId: u.creator,
        appId, userMemoryOfAgentId: agentId, createdBy: u.creator },
    })).id;
    expect(await getAccessibleMemoryIds(gql('creator'), homeId)).toEqual([homeId]);
    expect(await getAccessibleMemoryIds(gql('platformadmin'), homeId)).toEqual([]);
  });

  it('an ordinary org knowledge memory stays readable by members and a platform admin as before', async () => {
    for (const who of ['member', 'orgadmin', 'platformadmin', 'platformowner'] as const) {
      expect(await getAccessibleMemoryIds(gql(who), plainId), who).toEqual([plainId]);
      expect(await canReadMemory(db, mcpAuth(who) as never, plainId), who).toBe(true);
      expect(await mcp(who).callToolText('hadron_get_node', { urn: `hrn:node:${plainUrn}:docs:entry` }), who).toContain(`${NEEDLE} plain content`);
    }
  });

  describe('the write doors do not read a holding back for a platform role (hadron-internal#88)', () => {
    const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e?.extensions?.code ?? e?.message ?? 'error'; } };
    for (const who of ['platformadmin', 'platformowner', 'orgadminplat'] as const) {
      it(`${who}: the write gates refuse it and GraphQL updateNode and a dry-run replace answer as for a missing target`, async () => {
        await expect(requireMemoryWriteAccess(gql(who), holdingId)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
        expect(await canWriteToMemory(db, mcpAuth(who) as never, holdingId)).toBe(false);
        const before = await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { name: true, content: true, description: true } });
        expect(await codeOf(M.updateNode({}, { input: { ref: nodeId, description: 'x88' } }, gql(who)))).toBe(await codeOf(M.updateNode({}, { input: { ref: generateId(), description: 'x88' } }, gql(who))));
        expect(await codeOf(M.updateNode({}, { input: { memoryRef: holdingId, loc: nodeLoc, description: 'x88' } }, gql(who))))
          .toBe(await codeOf(M.updateNode({}, { input: { memoryRef: missingUrn, loc: nodeLoc, description: 'x88' } }, gql(who))));
        const dry = (memoryRef: string) => M.searchReplaceInNodes({}, { input: { oldText: NEEDLE, newText: 'x', memoryRefs: [memoryRef], fields: ['content', 'name'], dryRun: true } }, gql(who));
        const outcome = (p: Promise<unknown>) => p.then((r: unknown) => ({ ok: JSON.stringify(r) }), (e: any) => ({ code: e?.extensions?.code ?? 'error' }));
        const dryOut = await outcome(dry(holdingId));
        expect(dryOut).toEqual(await outcome(dry(generateId())));
        expect(JSON.stringify(dryOut)).not.toContain(nodeLoc);
        expect(JSON.stringify(dryOut)).not.toContain(nodeId);
        expect(await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { name: true, content: true, description: true } })).toEqual(before);
      });
      it(`${who}: MCP hadron_update_node and a dry-run hadron_replace_text show nothing and write nothing`, async () => {
        const before = await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { name: true, content: true, description: true } });
        const m = mcp(who);
        const upd = await m.callToolText('hadron_update_node', { urn: `hrn:node:${holdingUrn}:${nodeLoc}`, description: 'x88' });
        const updMissing = await m.callToolText('hadron_update_node', { urn: `hrn:node:${missingUrn}:${nodeLoc}`, description: 'x88' });
        expect(norm(upd, holdingUrn, nodeLoc)).toBe(norm(updMissing, missingUrn, nodeLoc));
        const rep = await m.callToolText('hadron_replace_text', { oldText: NEEDLE, newText: 'x', memoryUrns: [`hrn:mem:${holdingUrn}`], fields: ['content', 'name'], dryRun: true });
        expect(rep).not.toContain(nodeLoc);
        expect(rep).not.toContain(`${NEEDLE} private chat`);
        expect(await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { name: true, content: true, description: true } })).toEqual(before);
      });
    }
    it('a platform admin with an App selected (the hybrid MCP-built context) is refused too, and still writes an ordinary memory', async () => {
      for (const who of ['platformadmin', 'platformowner'] as const) {
        const withApp = { ...gql(who), appId } as Context;
        await expect(requireMemoryWriteAccess(withApp, holdingId), who).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
        await expect(requireMemoryWriteAccess(withApp, plainId), who).resolves.toBeUndefined();
      }
    });
    it('the creator still writes the holding on GraphQL (control)', async () => {
      await expect(requireMemoryWriteAccess(gql('creator'), holdingId)).resolves.toBeUndefined();
    });
    it('the platform bypass still writes an ordinary org memory (control)', async () => {
      for (const who of ['platformadmin', 'platformowner'] as const) {
        await expect(requireMemoryWriteAccess(gql(who), plainId), who).resolves.toBeUndefined();
        expect(await canWriteToMemory(db, mcpAuth(who) as never, plainId), who).toBe(true);
      }
    });
  });

  describe('an automation read grant never serves a holding (hadron-internal#88, SECOND delta P1-1)', () => {
    const scheduleOn = () => db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId, name: 'S', cron: '* * * * *', entryNodeUrn: `hrn:node:${plainUrn}:docs:entry` } });
    const give = (who: string, memoryRef: string, triggerId: string) =>
      M.setAutomationReadGrant({}, { appRef: appId, triggerKind: 'SCHEDULE', triggerId, memoryRef, prefix: null }, gql(who));
    it('the library judge refuses a holding for any giver, and still judges an ordinary memory by its own rules', async () => {
      const { readGrantTargetRefusal, READ_GRANT_MEMORY_SELECT } = await import('../../../lib/automationReadGrant.js');
      const holding = await db.memory.findUniqueOrThrow({ where: { id: holdingId }, select: READ_GRANT_MEMORY_SELECT });
      const app = { id: appId, organizationId: orgId, ownerUserId: null };
      expect(await readGrantTargetRefusal(db, app, holding as never)).toBe('user-holding');
      const plain = await db.memory.findUniqueOrThrow({ where: { id: plainId }, select: READ_GRANT_MEMORY_SELECT });
      expect(await readGrantTargetRefusal(db, app, plain as never)).toBeNull();
    });
    for (const who of ['orgadmin', 'orgowner', 'platformadmin', 'platformowner', 'creator'] as const) {
      it(`${who}: giving a read grant on the holding is refused like a missing memory and writes no grant row`, async () => {
        const s = await scheduleOn();
        expect(await code88(give(who, holdingId, s.id))).toBe(await code88(give(who, generateId(), s.id)));
        expect(await code88(give(who, holdingId, s.id))).not.toBe('ok');
        expect(await db.appAutomationReadGrant.count({ where: { memoryId: holdingId } })).toBe(0);
        // The same giver CAN give the same grant on an ordinary memory (so the refusal is about the holding, not the giver).
        expect(await code88(give(who, plainId, s.id)), `${who} control`).toBe('ok');
      });
    }
    it('a grant row inserted on a holding reads nothing through the run (the live re-judge); the same row on an ordinary memory reads', async () => {
      const { runHoldsReadGrant } = await import('../../../lib/automationReadGrant.js');
      const { testRunAgentId } = await import('../../../test/runAgent.js');
      const s = await scheduleOn();
      const run = await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId: await testRunAgentId(db, orgId, appId), userId: null, triggerKind: 'SCHEDULE', triggerId: s.id, entryNodeUrn: s.entryNodeUrn } });
      const principal = { appId, userId: undefined } as never;
      for (const memoryId of [holdingId, plainId]) await db.appAutomationReadGrant.create({ data: { appId, triggerKind: 'SCHEDULE', triggerId: s.id, memoryId, prefix: null, grantedBy: u.creator } });
      expect(await runHoldsReadGrant(db, principal, run.id, plainId, 'docs:entry')).toBe(true);
      expect(await runHoldsReadGrant(db, principal, run.id, holdingId, nodeLoc)).toBe(false);
    });
  });

  describe('the memory MANAGEMENT doors are the creator\'s alone on a holding (SECOND delta P2-3; one gate, requireMemoryManageAccess)', () => {
    for (const who of ['orgadmin', 'orgowner', 'platformadmin', 'platformowner', 'orgadminplat'] as const) {
      it(`${who}: updateMemory (source, branches, description), setMemorySourceToken and pushMemoryToGit answer as for a missing memory and change nothing`, async () => {
        const before = await db.memory.findUniqueOrThrow({ where: { id: holdingId }, select: { source: true, writeBranch: true, description: true, name: true } });
        const upd = (ref: string) => code88(M.updateMemory({}, { ref, source: 'https://attacker.example/repo.git', writeBranch: 'main', description: 'x88' }, gql(who)));
        expect(await upd(holdingId)).toBe(await upd(generateId()));
        expect(await upd(holdingId)).not.toBe('ok');
        const tok = (ref: string) => code88(M.setMemorySourceToken({}, { ref, token: 'ghp_x88' }, gql(who)));
        expect(await tok(holdingId)).toBe(await tok(generateId()));
        expect(await tok(holdingId)).not.toBe('ok');
        const push = (ref: string) => code88(M.pushMemoryToGit({}, { ref }, gql(who)));
        expect(await push(holdingId)).toBe(await push(generateId()));
        expect(await push(holdingId)).not.toBe('ok');
        expect(await db.memory.findUniqueOrThrow({ where: { id: holdingId }, select: { source: true, writeBranch: true, description: true, name: true } })).toEqual(before);
      });
    }
    it('the shared gate refuses a run principal and an impersonated context carrying the creator id, and an App key; the creator and ordinary memories pass (M1, M4)', async () => {
      const { requireMemoryManageAccess } = await import('./resolvers.helpers.js');
      const row = await db.memory.findUniqueOrThrow({ where: { id: holdingId }, select: { class: true, userId: true, organizationId: true, ownerUserId: true, userMemoryOfAgentId: true, createdBy: true } });
      const plain = await db.memory.findUniqueOrThrow({ where: { id: plainId }, select: { class: true, userId: true, organizationId: true, ownerUserId: true, userMemoryOfAgentId: true, createdBy: true } });
      const run = { db, ...runAuthContext({ id: generateId(), appId, userId: u.creator, organizationId: orgId }) } as unknown as Context;
      const impersonated = { db, userId: u.creator, roles: [], impersonation: { orgId } } as unknown as Context;
      const appKey = { db, appId, organizationId: orgId, roles: [] } as unknown as Context;
      await expect(requireMemoryManageAccess(gql('creator'), row)).resolves.toBeUndefined();
      const outcomes: Record<string, string> = {};
      for (const [label, c] of [['run', run], ['impersonated', impersonated], ['appKey', appKey], ['orgadmin', gql('orgadmin')], ['platformadmin', gql('platformadmin')]] as const) {
        outcomes[label] = await requireMemoryManageAccess(c, row).then(() => 'ok', (e: any) => e?.extensions?.code ?? 'error');
      }
      expect(outcomes).toEqual({ run: 'FORBIDDEN', impersonated: 'FORBIDDEN', appKey: 'FORBIDDEN', orgadmin: 'FORBIDDEN', platformadmin: 'FORBIDDEN' });
      await expect(requireMemoryManageAccess(gql('orgadmin'), plain)).resolves.toBeUndefined();
      await expect(requireMemoryManageAccess(gql('platformadmin'), plain)).resolves.toBeUndefined();
    });
    it('the question-log gate checks the holding BEFORE its App-owner arm: an owner-role App member who is not the creator is refused on an App-attached marker row, and admitted on an ordinary App memory (Q1)', async () => {
      await db.appMember.create({ data: { appId, userId: u.member, role: 'owner' } });
      const mk = async (urn: string, marker: boolean) => (await db.memory.create({
        data: { id: generateId(), name: urn, urn: `holding88.test:${urn}`, organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION', appId,
          ...(marker ? { userMemoryOfAgentId: agentId, createdBy: u.creator } : {}) },
      })).id;
      const attachedHolding = await mk('apphold', true);
      const attachedPlain = await mk('appplain', false);
      const create = (memoryRef: string, who: string) => M.createQuestionLog({}, { memoryRef, loc: 'questions', defaultDeciders: [u[who]] }, gql(who));
      const refused = /FORBIDDEN|NOT_FOUND|nothing found/i;
      expect(await code88(create(attachedHolding, 'member'))).toMatch(refused);
      expect(await db.node.count({ where: { memoryId: attachedHolding, loc: { startsWith: 'questions' } } })).toBe(0);
      // The same App owner is not refused at the log gate on an ordinary App memory.
      expect(await code88(create(attachedPlain, 'member'))).not.toMatch(refused);
    });
    it('the creator still manages it, and an org admin still manages an ordinary org memory (controls)', async () => {
      expect(await code88(M.updateMemory({}, { ref: holdingId, description: 'creator88' }, gql('creator')))).toBe('ok');
      expect(await code88(M.updateMemory({}, { ref: plainId, description: 'admin88' }, gql('orgadmin')))).toBe('ok');
      expect(await code88(M.updateMemory({}, { ref: plainId, description: 'platform88' }, gql('platformadmin')))).toBe('ok');
    });
    it('an org admin can still delete a holding (the delete door has its own org-admin gate)', async () => {
      expect(await code88(M.deleteMemory({}, { ref: holdingId }, gql('orgadmin')))).toBe('ok');
    });
  });

  describe('the asset public-link door (hadron-internal#88, SECOND delta P2-2)', () => {
    const assetOf = async (memoryId: string) => {
      const id = generateId();
      await db.asset.create({ data: { id, memoryId, filename: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: `k-${id}`, scanStatus: 'CLEAN' } });
      return id;
    };
    const switchOn = (who: string, assetRef: string) => M.setAssetPublicLink({}, { assetRef, enabled: true }, gql(who));
    const codeOf2 = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e?.extensions?.code ?? e?.message ?? 'error'; } };
    for (const who of ['platformadmin', 'platformowner', 'orgadminplat', 'orgadmin', 'orgowner'] as const) {
      it(`${who}: cannot switch a public link on a holding's asset, and is answered as for a missing asset`, async () => {
        const asset = await assetOf(holdingId);
        expect(await codeOf2(switchOn(who, asset))).toBe(await codeOf2(switchOn(who, generateId())));
        expect((await db.asset.findUniqueOrThrow({ where: { id: asset } })).publicLinkEnabled).toBe(false);
      });
    }
    it('the creator switches a link on and off; a run principal carrying the creator id cannot switch one on (N1)', async () => {
      const asset = await assetOf(holdingId);
      expect(await codeOf2(switchOn('creator', asset))).toBe('ok');
      expect((await db.asset.findUniqueOrThrow({ where: { id: asset } })).publicLinkEnabled).toBe(true);
      expect(await codeOf2(M.setAssetPublicLink({}, { assetRef: asset, enabled: false }, gql('creator')))).toBe('ok');
      expect((await db.asset.findUniqueOrThrow({ where: { id: asset } })).publicLinkEnabled).toBe(false);
      const run = { db, ...runAuthContext({ id: generateId(), appId, userId: u.creator, organizationId: orgId }) } as unknown as Context;
      // The run is the creator's delegate, so it is refused as a non-manager rather than concealed as missing.
      expect(await codeOf2(M.setAssetPublicLink({}, { assetRef: asset, enabled: true }, run))).toMatch(/does not manage|not found|PERMISSION_DENIED|NOT_FOUND/i);
      expect((await db.asset.findUniqueOrThrow({ where: { id: asset } })).publicLinkEnabled).toBe(false);
    });
    it('an App-attached marker-carrying app-class row (a session memory) is already outside the link door', async () => {
      const sessionMemory = (await db.memory.create({
        data: { id: generateId(), name: 'Sess', urn: 'holding88.test:sess', organizationId: orgId, class: 'app', appId, userMemoryOfAgentId: agentId, createdBy: u.creator },
      })).id;
      const asset = await assetOf(sessionMemory);
      expect(await codeOf2(switchOn('creator', asset))).not.toBe('ok');
      expect(await codeOf2(switchOn('orgadmin', asset))).not.toBe('ok');
    });
    it('the same people still switch a link on an ordinary org memory asset (control)', async () => {
      for (const who of ['platformadmin', 'orgadmin'] as const) {
        const asset = await assetOf(plainId);
        expect(await codeOf2(switchOn(who, asset)), who).toBe('ok');
      }
    });
  });

  describe('creator controls for every surface, the other write refusals and the record gate on marker-carrying rows (BLIND delta, F3 and F4)', () => {
    it('the creator reaches the holding through the surfaces the platform-role pins close', async () => {
      expect(await findGql('creator', false)).toBeGreaterThan(0);
      expect(await mcp('creator').callToolText('hadron_find_nodes', { query: NEEDLE, mode: 'keyword', allMemories: true })).toContain(NEEDLE);
      expect(await code88(M.updateNode({}, { input: { ref: nodeId, description: 'creator88' } }, gql('creator')))).toBe('ok');
      expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).description).toBe('creator88');
      const dry = await M.searchReplaceInNodes({}, { input: { oldText: NEEDLE, newText: 'x', memoryRefs: [holdingId], fields: ['content', 'name'], dryRun: true } }, gql('creator'));
      expect(JSON.stringify(dry)).toContain(nodeLoc);
      const mcpDry = await mcp('creator').callToolText('hadron_replace_text', { oldText: NEEDLE, newText: 'x', memoryUrns: [`hrn:mem:${holdingUrn}`], fields: ['content', 'name'], dryRun: true });
      expect(mcpDry).toContain(nodeLoc);
    });
    it('a co-member, an org admin and an org owner are refused the write gate on a holding with the forbidden code', async () => {
      for (const who of ['member', 'orgadmin', 'orgowner', 'foreigner', 'outsider'] as const) {
        await expect(requireMemoryWriteAccess(gql(who), holdingId), who).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
        expect(await canWriteToMemory(db, mcpAuth(who) as never, holdingId), who).toBe(false);
      }
    });
    it('Query.memory answers the holding record to its creator only (the record gate, called through the resolver)', async () => {
      expect((await Q.memory({}, { ref: holdingId }, gql('creator')))?.id).toBe(holdingId);
      for (const who of ['member', 'orgadmin', 'orgowner', 'platformadmin', 'platformowner', 'outsider'] as const) {
        expect(await Q.memory({}, { ref: holdingId }, gql(who)), who).toBeNull();
      }
    });
    it('a marker-carrying PRIVATE row keeps its own strict-owner audience at the record gate (not the holding rule)', async () => {
      const privateId = (await db.memory.create({
        data: { id: generateId(), name: 'Private home', urn: 'holding88.test:priv', organizationId: orgId, class: 'private', userId: u.creator,
          appId, userMemoryOfAgentId: agentId, createdBy: u.creator },
      })).id;
      expect((await Q.memory({}, { ref: privateId }, gql('creator')))?.id).toBe(privateId);
      for (const who of ['member', 'orgadmin', 'platformadmin', 'platformowner'] as const) {
        expect(await Q.memory({}, { ref: privateId }, gql(who)), who).toBeNull();
      }
      const impersonated = { db, userId: u.creator, roles: [], impersonation: { orgId } } as unknown as Context;
      expect(await Q.memory({}, { ref: privateId }, impersonated)).toBeNull();
    });
  });

  describe('the contexts that cannot take a role shortcut, and the remaining refusals (BLIND delta, F2 and F4)', () => {
    it('a run principal and an impersonated context are built with no roles', async () => {
      expect(runAuthContext({ id: generateId(), appId, userId: u.creator, organizationId: orgId }).roles).toEqual([]);
    });
    it('an App key is refused the write gate on a holding with the forbidden code', async () => {
      const appKey = { db, appId, organizationId: orgId, roles: [] } as unknown as Context;
      await expect(requireMemoryWriteAccess(appKey, holdingId)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(await canWriteToMemory(db, appKey as never, holdingId)).toBe(false);
    });
    it('a marker-carrying PERSONAL row keeps its own strict-owner audience at the record gate', async () => {
      const personalId = (await db.memory.create({
        data: { id: generateId(), name: 'Personal home', urn: 'holding88.test:pers', organizationId: orgId, class: 'personal', userId: u.creator,
          appId, userMemoryOfAgentId: agentId, createdBy: u.creator },
      })).id;
      expect((await Q.memory({}, { ref: personalId }, gql('creator')))?.id).toBe(personalId);
      for (const who of ['member', 'orgadmin', 'platformadmin', 'platformowner'] as const) expect(await Q.memory({}, { ref: personalId }, gql(who)), who).toBeNull();
    });
  });

  describe('the platform-admin "see all" sets (the shared filter, which the browse, task-discovery and global-search paths use alone)', () => {
    it('foreignIdentityScopedMemoryFilter selects a holding for every viewer but its creator', async () => {
      const foreign = async (viewer: string) => (await db.memory.findMany({
        where: { id: { in: [holdingId, plainId] }, ...foreignIdentityScopedMemoryFilter(viewer) }, select: { id: true },
      })).map((m) => m.id);
      expect(await foreign(u.platformadmin)).toEqual([holdingId]);
      expect(await foreign(u.platformowner)).toEqual([holdingId]);
      expect(await foreign(u.member)).toEqual([holdingId]);
      expect(await foreign(u.creator)).toEqual([]);
    });
    it('a holding with no recorded creator is foreign to everybody (fails closed)', async () => {
      await db.memory.update({ where: { id: holdingId }, data: { createdBy: null } });
      const rows = await db.memory.findMany({ where: { id: holdingId, ...foreignIdentityScopedMemoryFilter(u.creator) }, select: { id: true } });
      expect(rows.map((r) => r.id)).toEqual([holdingId]);
    });
    it('GraphQL global search for a platform admin finds the plain node and nothing of the holding', async () => {
      for (const who of ['platformadmin', 'platformowner'] as const) {
        const gqlOut = await Q.globalSearch({}, { query: NEEDLE, entityTypes: ['node', 'memory'], fields: ['content', 'name'], limit: 50 }, gql(who));
        const gqlText = JSON.stringify(gqlOut);
        expect(gqlText, who).toContain(`${NEEDLE} plain`); // the search itself works for this admin, so the absences below mean something
        expect(gqlText, who).not.toContain(holdingId);
        expect(gqlText, who).not.toContain(`${NEEDLE} private chat`);
      }
    });
    it('global search for the creator still finds the holding (control)', async () => {
      const text = JSON.stringify(await Q.globalSearch({}, { query: NEEDLE, entityTypes: ['node'], fields: ['name'], limit: 50 }, gql('creator')));
      expect(text).toContain(`${NEEDLE} private chat`);
    });
  });
});

describe('the shared predicates, as pure functions (hadron-internal#88)', () => {
  const row = (over: Partial<{ class: string; userMemoryOfAgentId: string | null; createdBy: string | null }> = {}) =>
    ({ class: 'knowledge', userMemoryOfAgentId: 'agent', createdBy: 'creator', ...over });
  it('isUserHolding: knowledge and group with the marker; nothing without it; never personal, private, system or app', () => {
    expect(isUserHolding(row())).toBe(true);
    expect(isUserHolding(row({ class: 'group' }))).toBe(true);
    expect(isUserHolding(row({ userMemoryOfAgentId: null }))).toBe(false);
    for (const c of ['personal', 'private', 'system', 'app']) expect(isUserHolding(row({ class: c })), c).toBe(false);
  });
  it('isForeignUserHolding: anybody but the creator, a missing viewer and a missing creator included; the creator is not foreign', () => {
    expect(isForeignUserHolding(row(), 'creator')).toBe(false);
    expect(isForeignUserHolding(row(), 'someone-else')).toBe(true);
    expect(isForeignUserHolding(row(), null)).toBe(true);
    expect(isForeignUserHolding(row(), undefined)).toBe(true);
    expect(isForeignUserHolding(row({ createdBy: null }), 'creator')).toBe(true);
    expect(isForeignUserHolding(row({ userMemoryOfAgentId: null }), 'someone-else')).toBe(false);
  });
});
