/**
 * #2458 / cor:dmo:050:11 (R222): a worker's agent can be changed and its role follows it; name, slug and URN stay.
 * Manager-only, as themselves; the same checks as a cast (one shared helper); a COMPLETE change in one
 * transaction (boot-prompt pointer cleared, generated tickers swapped, one `worker.casting` event); effective at
 * the next bind, which stamps the session's agent AND role from the locked worker row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { resolvers, type Context } from './resolvers.js';
import { composeWorkerPrompt } from './resolvers.worker.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any, Q = resolvers.Query as any;
let org: any, app: any, oldAgent: any, newAgent: any, admin: any, staff: any, member: any, outsider: any, worker: any;
const ctx = (u = admin, extra: Partial<Context> = {}): Context => ({ db, userId: u.id, roles: ['READER'], ...extra });
const change = (agentRef: string = newAgent.id, c = ctx()) => M.changeWorkerAgent({}, { workerRef: worker.id, agentRef }, c);
const row = () => db.worker.findUniqueOrThrow({ where: { id: worker.id } }) as Promise<any>;
const events = () => db.agentTeamEvent.findMany({ where: { appId: app.id, type: 'worker.casting' } });
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
const bind = (u = admin) => M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: worker.id, force: true } }, ctx(u));

/** A changed-nothing snapshot: the worker row, its tickers and the casting events. */
const snapshot = async () => ({
  worker: await row(),
  tickers: await db.ticker.findMany({ where: { appId: app.id }, orderBy: { id: 'asc' } }),
  events: await events(),
});

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Casting', urn: `cast-${n}.example` } });
  const user = (i: number) => db.user.create({ data: { githubId: 92458000 + i, githubUsername: `cast-${n}-${i}`, roles: ['READER'] } });
  [admin, staff, member, outsider] = await Promise.all([0, 1, 2, 3].map(user));
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: staff.id, role: 'CONTRIBUTOR' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  oldAgent = await M.createAgent({}, { orgId: org.id, name: 'Security', personaRole: 'security-engineer', systemPrompt: 'OLD {{worker.name}} {{worker.role}}' }, ctx());
  newAgent = await M.createAgent({}, { orgId: org.id, name: 'Specs', personaRole: 'specs-engineer', systemPrompt: 'NEW {{worker.name}} {{worker.role}}' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: oldAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: newAgent.id } });
  for (const a of [oldAgent, newAgent]) {
    await M.createAgentTickerTemplate({}, { agentRef: a.id, input: { name: `${a.name} tick`, cadenceSeconds: 600 } }, ctx());
  }
  const made = await M.castWorker({}, { appRef: app.id, agentRef: oldAgent.id, name: 'Ruin' }, ctx());
  worker = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
});

describe('#2458 changeWorkerAgent: the change', () => {
  it('moves agent and role, keeps name/slug/URN, and the old URN still resolves', async () => {
    const before = await row();
    const urn = (await Q.worker({}, { ref: worker.id }, ctx())).urn;
    await change();
    const after = await row();
    expect(after).toMatchObject({ agentId: newAgent.id, role: 'specs-engineer', name: before.name, slug: before.slug, appId: before.appId });
    expect((await Q.worker({}, { ref: urn }, ctx())).id).toBe(worker.id);
  });

  it('writes exactly one worker.casting event with who and the old/new agent and role', async () => {
    await change();
    const [e, ...rest] = await events();
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ actorUserId: admin.id, subjectWorkerId: worker.id });
    expect(e.payload).toMatchObject({ fromAgentId: oldAgent.id, toAgentId: newAgent.id, fromRole: 'security-engineer', toRole: 'specs-engineer' });
  });

  it('clears the worker boot-prompt pointer and records the old one in the event', async () => {
    const pointed = generateId();
    await db.$executeRaw`UPDATE workers SET boot_prompt_node_id = ${pointed}, boot_prompt_urn = 'x:y:z' WHERE id = ${worker.id}`;
    await change();
    expect(await row()).toMatchObject({ bootPromptNodeId: null, bootPromptUrn: null });
    expect((await events())[0].payload).toMatchObject({ clearedBootPromptNodeId: pointed });
  });

  it('ends the old agent\'s generated tickers and instantiates the new agent\'s', async () => {
    const live = () => db.ticker.findMany({ where: { generatedForWorkerId: worker.id, deletedAt: null }, select: { name: true } });
    expect((await live()).map(t => t.name)).toEqual(['Security tick · Ruin']);
    await change();
    expect((await live()).map(t => t.name)).toEqual(['Specs tick · Ruin']);
  });

  it('a past session keeps the agent and role it ran under; the next bind gets the new ones and the new prompt', async () => {
    const past = await bind();
    expect(await db.session.findUniqueOrThrow({ where: { id: past.id } })).toMatchObject({ agentId: oldAgent.id, role: 'security-engineer' });
    await change();
    expect(await db.session.findUniqueOrThrow({ where: { id: past.id } })).toMatchObject({ agentId: oldAgent.id, role: 'security-engineer' });
    const next = await bind();
    expect(await db.session.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({ agentId: newAgent.id, role: 'specs-engineer' });
    expect((await composeWorkerPrompt(ctx(), await row())).text).toBe('NEW Ruin specs-engineer');
  });
});

describe('#2458 changeWorkerAgent: refusals change nothing', () => {
  it.each(['staff', 'member', 'outsider', 'key', 'impersonation', 'run', 'session'])('refuses %s', async kind => {
    const before = await snapshot();
    const c = kind === 'staff' ? ctx(staff) : kind === 'member' ? ctx(member) : kind === 'outsider' ? ctx(outsider)
      : kind === 'key' ? { db, appId: app.id, roles: [] } as Context
      : kind === 'impersonation' ? ctx(admin, { roles: [], impersonation: { sessionId: generateId(), actorUserId: outsider.id, orgId: org.id, expiresAt: new Date(Date.now() + 60000) } })
      : ctx();
    const call = () => change(newAgent.id, c);
    // A worker session is refused even when its holder manages the App (R113): the manager acts as themselves.
    const result = kind === 'session' ? runAsActor({ workerId: worker.id, agentId: oldAgent.id }, call)
      : kind === 'run' ? runAsActor({ workerId: null, agentId: oldAgent.id }, call) : call();
    await expect(result).rejects.toBeTruthy();
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a session-bound request even when the holder manages the App', async () => {
    const s = await bind();
    const before = await snapshot();
    expect(await code(change(newAgent.id, ctx(admin, { sessionId: s.id })))).toBe('FORBIDDEN');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an agent that is not installed, or deleted, as one answer', async () => {
    const stray = await M.createAgent({}, { orgId: org.id, name: 'Stray', personaRole: 'stray' }, ctx());
    const before = await snapshot();
    expect(await code(change(stray.id))).toBe('WORKER_AGENT_NOT_INSTALLED');
    await db.agent.update({ where: { id: newAgent.id }, data: { deletedAt: new Date() } });
    expect(await code(change(newAgent.id))).toBe('WORKER_AGENT_NOT_INSTALLED');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses an inactive same-org grant and a missing foreign grant', async () => {
    await db.agentOrgGrant.upsert({
      where: { orgId_agentId: { orgId: org.id, agentId: newAgent.id } },
      create: { orgId: org.id, agentId: newAgent.id, revokedAt: new Date() },
      update: { revokedAt: new Date() },
    });
    const before = await snapshot();
    expect(await code(change())).toBe('AGENT_ORG_GRANT_INACTIVE');
    expect(await snapshot()).toEqual(before);

    const other = await db.organization.create({ data: { name: 'Vendor', urn: `vendor-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
    const foreign = await M.createAgent({}, { orgId: other.id, name: 'Vendor', personaRole: 'vendor', visibility: 'PUBLIC' }, ctx(outsider));
    await db.appAgent.create({ data: { appId: app.id, agentId: foreign.id } });
    expect(await code(change(foreign.id))).toBe('AGENT_ORG_GRANT_REQUIRED');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses when the served compiled prompt includes from an Agent the org holds no grant for', async () => {
    const other = await db.organization.create({ data: { name: 'Lib', urn: `lib-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
    const lib = await M.createAgent({}, { orgId: other.id, name: 'Lib', personaRole: 'lib', visibility: 'PUBLIC' }, ctx(outsider));
    const libAgent = await db.agent.findUniqueOrThrow({ where: { id: lib.id } });
    const newRow = await db.agent.findUniqueOrThrow({ where: { id: newAgent.id } });
    expect(libAgent.systemMemoryId && newRow.systemMemoryId).toBeTruthy();
    const included = await db.node.create({ data: { id: generateId(), memoryId: libAgent.systemMemoryId!, loc: 'policies:shared', name: 'p', content: 'lib text' } });
    const source = await db.node.create({ data: { id: generateId(), memoryId: newRow.systemMemoryId!, loc: 'boot:source', name: 'src', content: 'src', role: 'boot-prompt' } });
    const compiled = await db.node.create({ data: { id: generateId(), memoryId: newRow.systemMemoryId!, loc: 'boot:compiled', name: 'c', content: 'compiled', role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } });
    const occ = (order: number, nodeId: string, kind: string, parent: number | null, depth: number) =>
      ({ order, depth, parent, kind, nodeId, revNo: 1, hash: sha256Hex(nodeId), selection: { rev: null, approved: false, signed: false } });
    await db.compiledPromptRevision.create({ data: {
      compiledNodeId: compiled.id, compiledRevNo: 1, contentHash: sha256Hex('compiled'), targetKind: 'AGENT', targetAgentId: newAgent.id,
      provenance: { version: 1, occurrences: [occ(0, source.id, 'source', null, 0), occ(1, included.id, 'include', 0, 1)] }, occurrenceCount: 2,
    } });
    await db.agent.update({ where: { id: newAgent.id }, data: { bootPromptNodeId: compiled.id, bootPromptUrn: `${newRow.urn}:boot:compiled` } });
    const before = await snapshot();
    expect(await code(change())).toBe('BOOT_PROMPT_GRANT_REQUIRED');
    expect(await snapshot()).toEqual(before);
    // With the grant held, the same change goes through.
    await db.agentOrgGrant.create({ data: { orgId: org.id, agentId: lib.id } });
    await change();
    expect((await row()).agentId).toBe(newAgent.id);
  });

  it('refuses the unchanged agent and a retired worker', async () => {
    const before = await snapshot();
    expect(await code(change(oldAgent.id))).toBe('WORKER_AGENT_UNCHANGED');
    expect(await snapshot()).toEqual(before);
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    const retired = await snapshot();
    expect(await code(change())).toBe('WORKER_RETIRED');
    expect(await snapshot()).toEqual(retired);
  });
});

describe('#2458 cast uses the same checks (R222: no role override)', () => {
  it('refuses agentRef with a role that is not the agent\'s; the agent\'s own role passes; role alone still selects', async () => {
    expect(await code(M.castWorker({}, { appRef: app.id, agentRef: newAgent.id, role: 'something-else', name: 'Bea' }, ctx()))).toBe('WORKER_ROLE_OVERRIDE_REFUSED');
    expect(await db.worker.count({ where: { appId: app.id, name: 'Bea' } })).toBe(0);
    await expect(M.castWorker({}, { appRef: app.id, agentRef: newAgent.id, role: 'SPECS-ENGINEER', name: 'Bea' }, ctx())).resolves.toMatchObject({ role: 'specs-engineer' });
    await expect(M.castWorker({}, { appRef: app.id, role: 'specs-engineer', name: 'Cid' }, ctx())).resolves.toMatchObject({ agentId: newAgent.id });
  });

  it('refuses a cast without the org grant (the cast-time grant check)', async () => {
    const other = await db.organization.create({ data: { name: 'Vendor2', urn: `vendor2-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
    const foreign = await M.createAgent({}, { orgId: other.id, name: 'Vendor', personaRole: 'vendor', visibility: 'PUBLIC' }, ctx(outsider));
    await db.appAgent.create({ data: { appId: app.id, agentId: foreign.id } });
    expect(await code(M.castWorker({}, { appRef: app.id, agentRef: foreign.id, name: 'Dee' }, ctx()))).toBe('AGENT_ORG_GRANT_REQUIRED');
    expect(await db.worker.count({ where: { appId: app.id, name: 'Dee' } })).toBe(0);
  });
});
