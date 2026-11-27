/**
 * The doors around a per-user chat holding that no earlier gate pinned (hadron-internal#89, cor:cht:010:02: a holding is read and managed by
 * the user it serves alone, whatever the caller's organisation or global role; ruling 0226 and the "User only" decision that superseded
 * ruling 0232 Q1). Covers the platform-role write shortcuts, mergeMemories, task discovery and run-by-reference, the subscription arm and
 * the copy-out and transfer doors (cloneMemory, transferMemoryOwnership). Seeded through a real startChat under a seed App, reshaped to the row the retired
 * no-App route wrote (#5394); every admin is a REAL user row, since a context-only role gives a false null.
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
import { isUserHolding } from '../../../lib/auth/userHolding.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const NEEDLE = 'needle89';
let orgId: string, otherOrgId: string, agentId: string, appId: string;
let holdingId: string, holdingUrn: string, nodeId: string, nodeLoc: string, plainId: string, plainUrn: string;
const u: Record<string, string> = {};
const ROLES: Record<string, string[]> = { platformadmin: ['ADMIN'], platformowner: ['OWNER'], orgadminplat: ['ADMIN'] };
const gql = (who: string): Context => ({ db, userId: u[who], roles: ROLES[who] ?? ['READER'] }) as Context;
const mcpAuth = (who: string) => ({ userId: u[who], roles: ROLES[who] ?? [], clientId: `user:${u[who]}` });

async function user(handle: string, orgRole?: 'READER' | 'CONTRIBUTOR' | 'ADMIN' | 'OWNER', org = orgId) {
  const id = (await db.user.create({ data: { handle, roles: (ROLES[handle] ?? ['READER']) as never } })).id;
  u[handle] = id;
  if (orgRole) await db.orgMember.create({ data: { organizationId: org, userId: id, role: orgRole } });
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { name: 'Holding89 org', urn: 'holding89.test' } })).id;
  otherOrgId = (await db.organization.create({ data: { name: 'Other89 org', urn: 'holdother89.test' } })).id;
  await user('creator', 'ADMIN');
  await user('member', 'READER');
  await user('orgadmin', 'ADMIN');
  await user('orgowner', 'OWNER');
  await user('foreigner', 'READER', otherOrgId);
  await user('outsider');
  await user('platformadmin');
  await user('platformowner');
  await user('orgadminplat', 'READER'); // a platform ADMIN who is also an org member
  const agent = await M.createAgent({}, { orgRef: orgId, name: 'Holding89 agent', visibility: 'ORGANIZATION' }, gql('creator'));
  agentId = agent.id;
  for (const row of [
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts:step', content: 'STAGE', data: {} },
  ]) await db.node.create({ data: { memoryId: agent.systemMemoryId, name: row.loc, nodeType: 'system', ...row } });
  await serveEveryAgent(db);
  // #5394: the holding used to come from a real no-App start (the Agent's manager started a chat with no installed App).
  // That route is retired, so a start with no App is refused, and the holding such a start left is made the way it left
  // it: a real start under a seed App, then the home reshaped to the retired route's row (knowledge, no App, no owner
  // column, ORGANIZATION), and the seed App removed. Holdings of this shape exist until #5394's deletion runs.
  await expect(M.startChat({}, { agentRef: agentId, scope: 'private', conversationName: 'flow' }, gql('creator')))
    .rejects.toMatchObject({ code: 'CHAT_APP_NOT_IDENTIFIED' });
  const seedApp = await db.app.create({ data: { name: 'Seed app', urn: 'holding89.test:seed', organizationId: orgId, appAgents: { create: { agentId } } } });
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
  expect(isUserHolding(holding)).toBe(true);
  expect(holding).toMatchObject({ class: 'knowledge', ownerUserId: null, appId: null, userMemoryOfAgentId: agentId, createdBy: u.creator });
  plainId = (await db.memory.create({
    data: { id: generateId(), name: 'Plain', urn: 'holding89.test:plain', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION', createdBy: u.creator },
  })).id;
  plainUrn = 'holding89.test:plain';
  await db.node.create({ data: { id: generateId(), memoryId: plainId, loc: 'docs:entry', name: `${NEEDLE} plain`, content: `${NEEDLE} plain content` } });
  appId = (await db.app.create({ data: { name: 'Home app', urn: 'holding89.test:app', organizationId: orgId } })).id;
});


const missingUrn = 'holding89.test:never-existed';
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e?.extensions?.code ?? e?.message ?? 'error'; } };
const norm = (text: string, ...refs: string[]) => refs.reduce((t, r) => t.split(r).join('<REF>'), text);
const run = (uid: string | null) => ({ db, ...runAuthContext({ id: generateId(), appId, userId: uid, organizationId: orgId }) }) as unknown as Context;
const imp = () => ({ db, userId: u.creator, roles: [], impersonation: { orgId } }) as unknown as Context;
const appKey = () => ({ db, appId, roles: [] }) as unknown as Context;
const mcpOf = (c: Context) => ({ userId: c.userId, roles: c.roles ?? [], clientId: (c as any).clientId ?? (c.userId ? `user:${c.userId}` : undefined), appId: (c as any).appId, sessionId: (c as any).sessionId, impersonation: (c as any).impersonation });
const nodeCount = (memoryId: string) => db.node.count({ where: { memoryId, deletedAt: null } });

describe('the write shortcuts and mergeMemories do not reach a per-user chat holding (hadron-internal#89)', () => {
  const ADMINS = ['platformadmin', 'platformowner', 'orgadminplat'] as const;

  it('control: the shortcuts are live on an ordinary org memory, so the refusals below are the holding rule', async () => {
    for (const who of ADMINS) {
      expect(await code(requireMemoryWriteAccess(gql(who), plainId))).toBe('ok');
      expect(await code(requireMemoryWriteAccess({ ...gql(who), appId } as Context, plainId))).toBe('ok');
      expect(await canWriteToMemory(db, mcpOf(gql(who)) as never, plainId)).toBe(true);
    }
    expect(await code(requireMemoryWriteAccess(gql('creator'), holdingId))).toBe('ok');
  });

  for (const who of ADMINS) {
    it(`a platform role (${who}, real user row) is refused by each of the three write shortcuts: JWT path, App-selected path, MCP gate`, async () => {
      expect(await code(requireMemoryWriteAccess(gql(who), holdingId))).toBe('FORBIDDEN'); // helpers JWT-path shortcut
      expect(await code(requireMemoryWriteAccess({ ...gql(who), appId } as Context, holdingId))).toBe('FORBIDDEN'); // App-selected shortcut
      expect(await code(requireMemoryWriteAccess({ ...gql(who), appId, sessionId: generateId() } as Context, holdingId))).toBe('FORBIDDEN');
      expect(await canWriteToMemory(db, mcpOf(gql(who)) as never, holdingId)).toBe(false); // MCP shortcut
      expect(await canWriteToMemory(db, { ...mcpOf(gql(who)), appId } as never, holdingId)).toBe(false);
    });
  }

  it('a run principal and an impersonated context carrying the creator id, and an App key, are refused by the GraphQL and MCP write gates', async () => {
    for (const [label, c] of [['runCreator', run(u.creator)], ['runNone', run(null)], ['impersonated', imp()], ['appKey', appKey()]] as const) {
      expect([label, await code(requireMemoryWriteAccess(c, holdingId))]).toEqual([label, 'FORBIDDEN']);
      expect([label, await canWriteToMemory(db, mcpOf(c) as never, holdingId)]).toEqual([label, false]);
    }
  });

  it('mergeMemories: every non-creator principal is answered as for a missing memory, in both directions, and nothing moves', async () => {
    const before = { holding: await nodeCount(holdingId), plain: await nodeCount(plainId) };
    const missing = generateId();
    const expected = await code(M.mergeMemories({}, { input: { source: missing, target: plainId } }, gql('platformadmin')));
    expect(expected).toMatch(/^MEMORY_NOT_FOUND/);
    const principals: Array<[string, Context]> = [
      ...(['orgadmin', 'orgowner', 'member', 'outsider', 'foreigner', ...ADMINS] as const).map((w) => [w, gql(w)] as [string, Context]),
      ['runCreator', run(u.creator)], ['runNone', run(null)], ['impersonated', imp()], ['appKey', appKey()],
    ];
    for (const [label, c] of principals) {
      for (const input of [
        { source: holdingId, target: plainId }, { source: plainId, target: holdingId },
        { source: holdingUrn, target: plainUrn, deleteSourceMem: true }, { source: plainUrn, target: holdingUrn, deleteSourceMem: true },
      ]) {
        expect([label, await code(M.mergeMemories({}, { input }, c))]).toEqual([label, expected]);
      }
    }
    expect({ holding: await nodeCount(holdingId), plain: await nodeCount(plainId) }).toEqual(before);
    expect(await db.memory.count({ where: { id: { in: [holdingId, plainId] }, deletedAt: null } })).toBe(2);
  });

  it('mergeMemories: the creator merges the holding into an ordinary memory (control)', async () => {
    const before = await nodeCount(plainId);
    expect(await code(M.mergeMemories({}, { input: { source: holdingId, target: plainId } }, gql('creator')))).toBe('ok');
    expect(await nodeCount(plainId)).toBeGreaterThan(before);
  });
});

describe('task discovery and run-by-reference never surface a per-user chat holding (hadron-internal#89)', () => {
  const ALIAS = 'chatalias89';
  beforeEach(async () => {
    await db.node.update({ where: { id: nodeId }, data: { isRunnable: true, alias: ALIAS, description: 'chatdesc89' } });
  });
  const LEAK = new RegExp(`${ALIAS}|chatdesc89|${NEEDLE}`);
  const principals = (): Array<[string, Context]> => [
    ['orgadmin', gql('orgadmin')], ['orgowner', gql('orgowner')], ['platformadmin', gql('platformadmin')], ['platformowner', gql('platformowner')],
    ['orgadminplat', gql('orgadminplat')], ['impersonated', imp()], ['runCreator', run(u.creator)], ['runNone', run(null)], ['appKey', appKey()],
  ];

  it('discovery by name, by hint and by URN shows no part of the holding to any principal, the creator included (it is not a task source)', async () => {
    const holding = await db.memory.findUniqueOrThrow({ where: { id: holdingId } });
    for (const [label, c] of [...principals(), ['creator', gql('creator')] as [string, Context]]) {
      const m = createTestableMcpServer(mcpOf(c) as never);
      for (const args of [{ task: ALIAS }, { task: 'go', memory: holding.name }, { task: ALIAS, memory: `hrn:mem:${holdingUrn}` }, { task: 'private chat' }]) {
        const text = await m.callToolText('hadron_run_task', args as never);
        expect([label, JSON.stringify(args), LEAK.test(text) || text.includes(holding.name) || text.includes(holdingId) || text.includes(holdingUrn)]).toEqual([label, JSON.stringify(args), false]);
      }
    }
  });

  it('the platform admin result is the "see all" set minus the holding: the unreadable memory is dropped in the candidate query, not named', async () => {
    const m = createTestableMcpServer(mcpOf(gql('platformadmin')) as never);
    const text = await m.callToolText('hadron_run_task', { task: ALIAS } as never);
    expect(text).toContain('Plain'); // the ordinary memory is still listed
    const holding = await db.memory.findUniqueOrThrow({ where: { id: holdingId } });
    expect(text).not.toContain(holding.name);
    expect(text).not.toContain(holdingUrn);
    const all = await db.memory.findMany({ where: { deletedAt: null, NOT: foreignIdentityScopedMemoryFilter(u.platformadmin) }, select: { id: true } });
    expect(all.map((r) => r.id)).not.toContain(holdingId);
    expect(all.map((r) => r.id)).toContain(plainId);
  });

  it('run by reference (hadron_run_task urn, hadron_run_action urn, GraphQL runTask) answers as for a missing node, for every non-creator', async () => {
    const urn = `hrn:node:${holdingUrn}:${nodeLoc}`;
    const missing = `hrn:node:${missingUrn}:${nodeLoc}`;
    for (const [label, c] of principals()) {
      const m = createTestableMcpServer(mcpOf(c) as never);
      for (const tool of ['hadron_run_task', 'hadron_run_action']) {
        const a = norm(await m.callToolText(tool, { urn } as never), holdingUrn, nodeLoc);
        const b = norm(await m.callToolText(tool, { urn: missing } as never), missingUrn, nodeLoc);
        expect([label, tool, a]).toEqual([label, tool, b]);
        expect(LEAK.test(a) || a.includes(holdingId)).toBe(false);
      }
      expect([label, await code(M.runTask({}, { nodeRef: urn }, c))]).toEqual([label, await code(M.runTask({}, { nodeRef: missing }, c))]);
    }
  });

  it('control: the creator is not answered as for a missing node by GraphQL runTask', async () => {
    const urn = `hrn:node:${holdingUrn}:${nodeLoc}`;
    const creatorCode = await code(M.runTask({}, { nodeRef: urn }, gql('creator')));
    expect(creatorCode).toBe('ok');
  });

  it('control: the creator reads the node by reference through run_action (the gate is the holding rule, not a broken fixture)', async () => {
    const text = await createTestableMcpServer(mcpOf(gql('creator')) as never).callToolText('hadron_run_action', { urn: `hrn:node:${holdingUrn}:${nodeLoc}` } as never);
    expect(text).toContain(`${NEEDLE} secret content`);
  });
});

describe('the subscription arm of the access map (hadron-internal#89)', () => {
  it('a live subscription row on a holding grants its subscriber organization nothing (subscribedMemoryWhere keeps per-user holdings out)', async () => {
    await db.memorySubscription.create({ data: { memoryId: holdingId, organizationId: otherOrgId, role: 'CONTRIBUTOR', activated: true } });
    await db.memorySubscription.create({ data: { memoryId: plainId, organizationId: otherOrgId, role: 'CONTRIBUTOR', activated: true } });
    // control: the same subscription reaches the ordinary memory, so the arm is live and the holding is the only difference.
    expect(await canReadMemory(db, mcpAuth('foreigner') as never, plainId)).toBe(true);
    for (const who of ['foreigner', 'orgadmin', 'member'] as const) {
      expect([who, await canReadMemory(db, mcpAuth(who) as never, holdingId)]).toEqual([who, false]);
      expect([who, await canWriteToMemory(db, mcpAuth(who) as never, holdingId)]).toEqual([who, false]);
      expect([who, [...(await filterReadableMemoryIds(db, mcpAuth(who) as never, [holdingId]))]]).toEqual([who, []]);
      const ids = await getAccessibleMemoryIds(gql(who));
      expect([who, ids]).not.toEqual([who, null]);
      expect([who, ids]).toEqual([who, expect.not.arrayContaining([holdingId])]);
      expect([who, await code(requireMemoryWriteAccess(gql(who), holdingId))]).toEqual([who, 'FORBIDDEN']);
    }
    expect(await getAccessibleMemoryIds(gql('foreigner'))).toContain(plainId);
    expect(await Q.node({}, { ref: nodeId }, gql('foreigner'))).toBeNull();
  });
});


describe('copy-out and transfer doors do not carry a per-user chat holding to a non-creator (hadron-internal#89)', () => {
  const NOT_FOUND = /^MEMORY_NOT_FOUND/;
  const nonCreators = (): Array<[string, Context]> => [
    ['orgadmin', gql('orgadmin')], ['orgowner', gql('orgowner')], ['platformadmin', gql('platformadmin')], ['platformowner', gql('platformowner')],
    ['orgadminplat', gql('orgadminplat')], ['runCreator', run(u.creator)], ['impersonated', imp()],
    ['member', gql('member')], ['foreigner', gql('foreigner')], ['outsider', gql('outsider')], ['runNone', run(null)], ['appKey', appKey()],
  ];
  const before = async () => db.memory.findUniqueOrThrow({ where: { id: holdingId }, select: { organizationId: true, userId: true, ownerUserId: true, urn: true, class: true, createdBy: true, userMemoryOfAgentId: true, visibility: true, deletedAt: true } });

  it('control: an ordinary org memory is cloned and transferred (preview) by an org admin, so the refusals below are the holding rule', async () => {
    expect(await code(M.cloneMemory({}, { ref: plainId, targetUrn: 'holding89.test::plain-copy' }, gql('orgadmin')))).toBe('ok');
    expect(await code(M.transferMemoryOwnership({}, { memoryRef: plainId, userRef: u.orgadmin, dryRun: true }, gql('orgadmin')))).toBe('ok');
    expect(await code(M.transferMemoryOwnership({}, { memoryRef: plainId, userRef: u.platformadmin, dryRun: true }, gql('platformadmin')))).toBe('ok');
  });

  it('control: the creator clones the holding and the copy carries its nodes', async () => {
    const out = await M.cloneMemory({}, { ref: holdingId, targetUrn: 'holding89.test::creator-copy' }, gql('creator'));
    expect(await db.node.count({ where: { memoryId: out.id, content: { contains: NEEDLE } } })).toBeGreaterThan(0);
    // Stated limit: the creator's own copy is an ordinary memory of the org, not a holding (the clone does not carry the marker).
    const copy = await db.memory.findUniqueOrThrow({ where: { id: out.id }, select: { class: true, userMemoryOfAgentId: true, createdBy: true, visibility: true } });
    expect(copy).toEqual({ class: 'knowledge', userMemoryOfAgentId: null, createdBy: u.creator, visibility: 'ORGANIZATION' });
    // Consequence of that limit, recorded: the org's members can read the creator's copy (the creator's own act; spec question on hadron-internal#89).
    expect(await canReadMemory(db, mcpAuth('member') as never, out.id)).toBe(true);
    expect(await code(M.transferMemoryOwnership({}, { memoryRef: holdingId, userRef: u.creator, dryRun: true }, gql('creator')))).toBe('ok');
  });

  it('cloneMemory answers every non-creator as for a missing memory and creates nothing', async () => {
    const mems = await db.memory.count();
    const missing = await code(M.cloneMemory({}, { ref: generateId(), targetUrn: 'holding89.test::never' }, gql('platformadmin')));
    expect(missing).toMatch(NOT_FOUND);
    let n = 0;
    for (const [label, c] of nonCreators()) {
      for (const ref of [holdingId, holdingUrn]) expect([label, await code(M.cloneMemory({}, { ref, targetUrn: `holding89.test::stolen${n++}` }, c))]).toEqual([label, missing]);
    }
    expect(await db.memory.count()).toBe(mems);
  });

  it('transferMemoryOwnership (preview and real) answers every non-creator as for a missing memory and moves nothing', async () => {
    const row = await before();
    const missing = await code(M.transferMemoryOwnership({}, { memoryRef: generateId(), userRef: u.platformadmin, dryRun: true }, gql('platformadmin')));
    expect(missing).toMatch(NOT_FOUND);
    for (const [label, c] of nonCreators()) {
      for (const dryRun of [true, false]) {
        expect([label, dryRun, await code(M.transferMemoryOwnership({}, { memoryRef: holdingId, userRef: c.userId ?? u.platformadmin, dryRun }, c))]).toEqual([label, dryRun, missing]);
        expect([label, dryRun, await code(M.transferMemoryOwnership({}, { memoryRef: holdingId, orgRef: otherOrgId, dryRun }, c))]).toEqual([label, dryRun, missing]);
        expect([label, dryRun, await code(M.transferMemoryOwnership({}, { memoryRef: holdingUrn, userRef: u.platformadmin, dryRun }, c))]).toEqual([label, dryRun, missing]);
        // An invalid target must not tell a holding from a missing memory: the source gate runs first.
        expect([label, dryRun, await code(M.transferMemoryOwnership({}, { memoryRef: holdingId, orgRef: generateId(), dryRun }, c))]).toEqual([label, dryRun, missing]);
      }
    }
    expect(await before()).toEqual(row);
  });

  it('a real transfer by the creator moves nothing in any shape (refused by the Agent-scope dependents check, the class and same-owner checks, not by the holding rule): the dry run says ok, the real call is refused by an existing check, and the row is unchanged', async () => {
    // The creator also administers the other organisation, so the destination gate is not what refuses the cross-org shapes.
    await db.orgMember.create({ data: { organizationId: otherOrgId, userId: u.creator, role: 'ADMIN' } });
    const row = await before();
    const shapes: Array<[string, Record<string, unknown>]> = [
      ['user private', { userRef: u.creator, targetClass: 'private' }], ['user personal', { userRef: u.creator, targetClass: 'personal' }],
      ['user no class', { userRef: u.creator }], ['same org', { orgRef: orgId }], ['same org knowledge', { orgRef: orgId, targetClass: 'knowledge' }],
      ['other org', { orgRef: otherOrgId }], ['other org knowledge', { orgRef: otherOrgId, targetClass: 'knowledge' }],
      ['other org private', { orgRef: otherOrgId, targetClass: 'private' }], ['another user', { userRef: u.member, targetClass: 'private' }],
    ];
    const outcomes: Record<string, string> = {};
    for (const [label, args] of shapes) {
      outcomes[label] = await code(M.transferMemoryOwnership({}, { memoryRef: holdingId, ...args, dryRun: false }, gql('creator')));
      expect([label, await before()]).toEqual([label, row]);
    }
    expect(outcomes).toEqual({ 'user private': 'MEMORY_TRANSFER_DEPENDENTS', 'user personal': 'MEMORY_TRANSFER_DEPENDENTS', 'user no class': 'MEMORY_TRANSFER_CLASS_REQUIRED', 'same org': 'MEMORY_TRANSFER_SAME_OWNER', 'same org knowledge': 'MEMORY_TRANSFER_SAME_OWNER', 'other org': 'MEMORY_TRANSFER_DEPENDENTS', 'other org knowledge': 'MEMORY_TRANSFER_DEPENDENTS', 'other org private': 'MEMORY_TRANSFER_CLASS_REQUIRED', 'another user': 'FORBIDDEN' });
    for (const who of ['orgadmin', 'platformadmin', 'member'] as const) expect([who, await Q.node({}, { ref: nodeId }, gql(who))]).toEqual([who, null]);
  });
});
