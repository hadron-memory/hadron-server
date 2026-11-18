/**
 * #2917 / cor:agt:040:08: changeWorkerAgent provisions the target Agent's missing SAME-organisation grants (own and
 * included) in its deciding transaction and judges the licence again after the write, so a revoked row that wins a
 * race refuses instead of becoming a success. Every pin goes through the real changeWorkerAgent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { sha256Hex } from '../../../lib/bootCompile/provenance.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// A deterministic post-provision failure: the cast event is written after the grants, so a throw here must undo them.
const fail = vi.hoisted(() => ({ castEvent: false }));
vi.mock('../../../lib/agentTasks/events.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../../lib/agentTasks/events.js')>();
  return { ...real, appendWorkerCastingEvent: (...a: Parameters<typeof real.appendWorkerCastingEvent>) => {
    if (fail.castEvent) throw new Error('injected casting-event failure');
    return real.appendWorkerCastingEvent(...a);
  } };
});

const M = resolvers.Mutation as any;
let org: any, app: any, admin: any, outsider: any, base: any, main: any, libA: any, libB: any, worker: any;
const ctx = (u = admin): Context => ({ db, userId: u.id, roles: ['READER'] });
const change = (agent = main) => M.changeWorkerAgent({}, { workerRef: worker.id, agentRef: agent.id }, ctx());
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
const grant = (agentId: string) => db.agentOrgGrant.findUnique({ where: { orgId_agentId: { orgId: org.id, agentId } } });
const grants = () => db.agentOrgGrant.findMany({ where: { orgId: org.id }, orderBy: { agentId: 'asc' } });
const side = async () => ({
  grants: await grants(),
  worker: await db.worker.findUniqueOrThrow({ where: { id: worker.id } }),
  events: await db.agentTeamEvent.count({ where: { appId: app.id } }),
  tickers: await db.ticker.count({ where: { appId: app.id } }),
});

/** Compile `target`'s boot prompt provenance so it includes one node from each of `from`'s system memories. */
async function includeFrom(target: any, from: any[]) {
  const t = await db.agent.findUniqueOrThrow({ where: { id: target.id } });
  const source = await db.node.create({ data: { id: generateId(), memoryId: t.systemMemoryId!, loc: `boot:source:${generateId()}`, name: 'src', content: 'src', role: 'boot-prompt' } });
  const compiled = await db.node.create({ data: { id: generateId(), memoryId: t.systemMemoryId!, loc: `boot:compiled:${generateId()}`, name: 'c', content: 'compiled', role: 'boot-prompt', nodeType: 'compiled-boot-prompt' } });
  const occ = (order: number, nodeId: string, kind: string, parent: number | null, depth: number) =>
    ({ order, depth, parent, kind, nodeId, revNo: 1, hash: sha256Hex(nodeId), selection: { rev: null, approved: false, signed: false } });
  const occs = [occ(0, source.id, 'source', null, 0)];
  for (const [i, a] of from.entries()) {
    const row = await db.agent.findUniqueOrThrow({ where: { id: a.id } });
    const n = await db.node.create({ data: { id: generateId(), memoryId: row.systemMemoryId!, loc: `policies:p${i}:${generateId()}`, name: 'p', content: `text ${i}` } });
    occs.push(occ(i + 1, n.id, 'include', 0, 1));
  }
  await db.compiledPromptRevision.create({ data: {
    compiledNodeId: compiled.id, compiledRevNo: 1, contentHash: sha256Hex('compiled'), targetKind: 'AGENT', targetAgentId: target.id,
    provenance: { version: 1, occurrences: occs }, occurrenceCount: occs.length,
  } });
  await db.agent.update({ where: { id: target.id }, data: { bootPromptNodeId: compiled.id, bootPromptUrn: `${t.urn}:boot:compiled` } });
}

beforeEach(async () => {
  fail.castEvent = false;
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Chg', urn: `chg-${n}.example` } });
  const user = (i: number) => db.user.create({ data: { githubId: 92917000 + i, githubUsername: `chg-${n}-${i}`, roles: ['READER'] } });
  [admin, outsider] = await Promise.all([0, 1].map(user));
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  for (const [k, role] of [['Base', 'base-role'], ['Main', 'main-role'], ['LibA', 'lib-a'], ['LibB', 'lib-b']]) {
    const a = await M.createAgent({}, { orgId: org.id, name: k, personaRole: role }, ctx());
    await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
    if (k === 'Base') base = a; else if (k === 'Main') main = a; else if (k === 'LibA') libA = a; else libB = a;
  }
  await includeFrom(main, [libA, libB]);
  await db.agentOrgGrant.deleteMany({ where: { orgId: org.id } });
  worker = await M.castWorker({}, { appRef: app.id, agentRef: base.id, name: 'Ada' }, ctx());
  await db.agentOrgGrant.deleteMany({ where: { orgId: org.id, agentId: { not: base.id } } });
});

describe('#2917 changeWorkerAgent provisions missing same-org grants', () => {
  it('creates the target\'s own grant and every included Agent\'s, active, with the change', async () => {
    await change();
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toMatchObject({ agentId: main.id, role: 'main-role' });
    for (const a of [main, libA, libB]) expect(await grant(a.id)).toMatchObject({ revokedAt: null, activatedAt: expect.any(Date) });
  });

  it('leaves an existing active grant untouched and still provisions the missing ones', async () => {
    const created = await db.agentOrgGrant.create({ data: { orgId: org.id, agentId: libA.id, activatedAt: new Date('2026-01-01T00:00:00Z') } });
    await change();
    expect(await grant(libA.id)).toEqual(created);
    expect(await grant(main.id)).not.toBeNull();
    expect(await grant(libB.id)).not.toBeNull();
  });
});

describe('#2917 a change that does not complete leaves no grant', () => {
  it('a failure after the grants were provisioned rolls them back with the rest', async () => {
    fail.castEvent = true;
    const before = await side();
    expect(await code(change())).toBe('injected casting-event failure');
    expect(await side()).toEqual(before);
    fail.castEvent = false;
    await change();
    expect(await grants()).toHaveLength(4);
  });
});

describe('#2917 what a change still refuses', () => {
  it.each(['own', 'included'])('a revoked same-org grant (%s) refuses and stays revoked', async which => {
    const revoked = which === 'own' ? main : libA;
    const row = await db.agentOrgGrant.create({ data: { orgId: org.id, agentId: revoked.id, activatedAt: new Date(), revokedAt: new Date() } });
    const before = await side();
    expect(await code(change())).toBe(which === 'own' ? 'AGENT_ORG_GRANT_INACTIVE' : 'BOOT_PROMPT_GRANT_REQUIRED');
    expect(await side()).toEqual(before);
    expect(await grant(revoked.id)).toEqual(row);
  });

  it('a missing grant for a foreign PUBLIC Agent still refuses, and no foreign grant is made', async () => {
    const other = await db.organization.create({ data: { name: 'Vendor', urn: `vendor-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
    const foreign = await M.createAgent({}, { orgId: other.id, name: 'Vendor', personaRole: 'vendor', visibility: 'PUBLIC' }, ctx(outsider));
    await db.appAgent.create({ data: { appId: app.id, agentId: foreign.id } });
    const before = await side();
    expect(await code(change(foreign))).toBe('AGENT_ORG_GRANT_REQUIRED');
    expect(await side()).toEqual(before);
  });

  it('an include from a concealed foreign Agent refuses without naming it, and provisions nothing', async () => {
    const other = await db.organization.create({ data: { name: 'Secret', urn: `secret-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
    const hidden = await M.createAgent({}, { orgId: other.id, name: 'Hidden', personaRole: 'hidden' }, ctx(outsider));
    await db.compiledPromptRevision.deleteMany({});
    await includeFrom(main, [libA, hidden]);
    const before = await side();
    expect(await code(change())).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    expect(await side()).toEqual(before);
  });
});

describe('#2917 a revoked row that wins the race is never turned into a success', () => {
  /** Hold a side transaction that has inserted a revoked row uncommitted, as a concurrent revoke would. */
  async function raceWith(agentId: string) {
    let held!: () => void, release!: () => void;
    const isHeld = new Promise<void>(r => (held = r)), gate = new Promise<void>(r => (release = r));
    const writer = db.$transaction(async tx => {
      await tx.agentOrgGrant.create({ data: { orgId: org.id, agentId, activatedAt: new Date(), revokedAt: new Date() } });
      held(); await gate;
    }, { timeout: 30_000 });
    await isHeld;
    const outcome = code(change());
    for (let i = 0; ; i++) {
      const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (n > 0) break;
      if (i > 60) throw new Error('the change never waited on the uncommitted grant row');
      await new Promise(r => setTimeout(r, 25));
    }
    release();
    await writer;
    return outcome;
  }

  it.each([['own', 'AGENT_ORG_GRANT_INACTIVE'], ['included', 'BOOT_PROMPT_GRANT_REQUIRED']])('%s grant', async (which, expected) => {
    const target = which === 'own' ? main : libA;
    const before = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const events = await db.agentTeamEvent.count({ where: { appId: app.id } });
    expect(await raceWith(target.id)).toBe(expected);
    expect(await db.worker.findUniqueOrThrow({ where: { id: worker.id } })).toEqual(before);
    expect((await grant(target.id))!.revokedAt).not.toBeNull();
    expect(await db.agentTeamEvent.count({ where: { appId: app.id } })).toBe(events);
  });
});
