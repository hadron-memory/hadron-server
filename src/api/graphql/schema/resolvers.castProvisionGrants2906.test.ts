/**
 * #2906 / cor:agt:040:08: a cast provisions a missing SAME-organisation grant (the Agent's own and each included
 * Agent's), in the cast transaction, and never reactivates a revoked one. Every pin goes through the real castWorker.
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
  return { ...real, appendWorkerCastEvent: (...a: Parameters<typeof real.appendWorkerCastEvent>) => {
    if (fail.castEvent) throw new Error('injected cast-event failure');
    return real.appendWorkerCastEvent(...a);
  } };
});

const M = resolvers.Mutation as any, Q = resolvers.Query as any;
let org: any, app: any, admin: any, outsider: any, main: any, libA: any, libB: any;
const ctx = (u = admin): Context => ({ db, userId: u.id, roles: ['READER'] });
const cast = (name: string, agent = main) => M.castWorker({}, { appRef: app.id, agentRef: agent.id, name }, ctx());
const code = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e: any) { return e?.extensions?.code ?? e?.message; } };
const grant = (agentId: string, orgId = org.id) => db.agentOrgGrant.findUnique({ where: { orgId_agentId: { orgId, agentId } } });
const grants = () => db.agentOrgGrant.findMany({ where: { orgId: org.id }, orderBy: { agentId: 'asc' } });
const side = async () => ({
  grants: await grants(),
  workers: await db.worker.count({ where: { appId: app.id } }),
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
  org = await db.organization.create({ data: { name: 'Prov', urn: `prov-${n}.example` } });
  const user = (i: number) => db.user.create({ data: { githubId: 92906000 + i, githubUsername: `prov-${n}-${i}`, roles: ['READER'] } });
  [admin, outsider] = await Promise.all([0, 1].map(user));
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  main = await M.createAgent({}, { orgId: org.id, name: 'Main', personaRole: 'main-role' }, ctx());
  libA = await M.createAgent({}, { orgId: org.id, name: 'LibA', personaRole: 'lib-a' }, ctx());
  libB = await M.createAgent({}, { orgId: org.id, name: 'LibB', personaRole: 'lib-b' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: main.id } });
  await includeFrom(main, [libA, libB]);
  await db.agentOrgGrant.deleteMany({ where: { orgId: org.id } });
});

describe('#2906 cast provisions missing same-org grants', () => {
  it('creates the Agent\'s own grant and every included Agent\'s, active, with the Worker', async () => {
    const w = await cast('Ada');
    expect(await db.worker.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ agentId: main.id, name: 'Ada' });
    for (const a of [main, libA, libB]) expect(await grant(a.id)).toMatchObject({ revokedAt: null, activatedAt: expect.any(Date) });
  });

  it('leaves an existing active grant untouched and still provisions the missing ones', async () => {
    const created = await db.agentOrgGrant.create({ data: { orgId: org.id, agentId: libA.id, activatedAt: new Date('2026-01-01T00:00:00Z') } });
    await cast('Ada');
    expect(await grant(libA.id)).toEqual(created);
    expect(await grant(main.id)).not.toBeNull();
    expect(await grant(libB.id)).not.toBeNull();
    await cast('Bea');
    expect(await grants()).toHaveLength(3);
  });

  it('the preview provisions nothing', async () => {
    await Q.castWorkerPreview({}, { appRef: app.id, agentRef: main.id, name: 'Ada' }, ctx());
    expect(await grants()).toEqual([]);
  });
});

describe('#2906 a cast that does not complete leaves no grant', () => {
  it('a failure after the grants were provisioned rolls them back with everything else', async () => {
    fail.castEvent = true;
    const before = await side();
    expect(await code(cast('Ada'))).toBe('injected cast-event failure');
    expect(await side()).toEqual(before);
    fail.castEvent = false;
    await cast('Ada');
    expect(await grants()).toHaveLength(3);
  });

  it('a taken name provisions nothing', async () => {
    await db.agentOrgGrant.createMany({ data: [{ orgId: org.id, agentId: main.id, activatedAt: new Date() }] });
    await cast('Ada');
    await db.agentOrgGrant.deleteMany({ where: { orgId: org.id, agentId: { in: [libA.id, libB.id] } } });
    const before = await side();
    expect(await code(cast('Ada'))).toBe('WORKER_NAME_TAKEN');
    expect(await side()).toEqual(before);
  });

  it('a name that is only confusable with a taken one provisions nothing', async () => {
    await db.agentOrgGrant.create({ data: { orgId: org.id, agentId: main.id, activatedAt: new Date() } });
    await cast('Ada');
    await db.agentOrgGrant.deleteMany({ where: { orgId: org.id, agentId: { in: [libA.id, libB.id] } } });
    const before = await side();
    expect(await code(cast('Ad\u0430'))).toBe('WORKER_NAME_CONFUSABLE');
    expect(await side()).toEqual(before);
  });
});

describe('#2906 what a cast still refuses', () => {
  it.each(['own', 'included'])('a revoked same-org grant (%s) refuses and stays revoked', async which => {
    const revoked = which === 'own' ? main : libA;
    const row = await db.agentOrgGrant.create({ data: { orgId: org.id, agentId: revoked.id, activatedAt: new Date(), revokedAt: new Date() } });
    const before = await side();
    expect(await code(cast('Ada'))).toBe(which === 'own' ? 'AGENT_ORG_GRANT_INACTIVE' : 'BOOT_PROMPT_GRANT_REQUIRED');
    expect(await side()).toEqual(before);
    expect(await grant(revoked.id)).toEqual(row);
  });

  it('a missing grant for a foreign PUBLIC Agent still refuses, and no foreign grant is made', async () => {
    const other = await db.organization.create({ data: { name: 'Vendor', urn: `vendor-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
    const foreign = await M.createAgent({}, { orgId: other.id, name: 'Vendor', personaRole: 'vendor', visibility: 'PUBLIC' }, ctx(outsider));
    await db.appAgent.create({ data: { appId: app.id, agentId: foreign.id } });
    const before = await side();
    expect(await code(cast('Ada', foreign))).toBe('AGENT_ORG_GRANT_REQUIRED');
    expect(await side()).toEqual(before);
  });

  it('an include from a concealed foreign Agent refuses without naming it, and provisions nothing', async () => {
    const other = await db.organization.create({ data: { name: 'Secret', urn: `secret-${generateId().toLowerCase()}.example` } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: outsider.id, role: 'ADMIN' } });
    const hidden = await M.createAgent({}, { orgId: other.id, name: 'Hidden', personaRole: 'hidden' }, ctx(outsider));
    await db.compiledPromptRevision.deleteMany({});
    await includeFrom(main, [libA, hidden]);
    const before = await side();
    expect(await code(cast('Ada'))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    expect(await side()).toEqual(before);
  });

  it('a user-owned App gets no synthetic org grant', async () => {
    const mine = await db.app.create({ data: { ownerUserId: admin.id, name: 'Mine', urn: `hrn:app:test:mine-${generateId()}` } });
    const own = await M.createAgent({}, { name: 'Own', personaRole: 'own-role' }, ctx());
    await db.appAgent.create({ data: { appId: mine.id, agentId: own.id } });
    await M.castWorker({}, { appRef: mine.id, agentRef: own.id, name: 'Hal' }, ctx());
    expect(await db.agentOrgGrant.count()).toBe(0);
  });
});

describe('#2906 a revoked row that wins the race is never turned into a success', () => {
  /** Hold a side transaction that has inserted `row` uncommitted, as a concurrent revoke-after-first-provision would. */
  async function raceWith(agentId: string, name: string) {
    let held!: () => void, release!: () => void;
    const isHeld = new Promise<void>(r => (held = r)), gate = new Promise<void>(r => (release = r));
    const writer = db.$transaction(async tx => {
      await tx.agentOrgGrant.create({ data: { orgId: org.id, agentId, activatedAt: new Date(), revokedAt: new Date() } });
      held(); await gate;
    }, { timeout: 30_000 });
    await isHeld;
    const outcome = code(cast(name));
    for (let i = 0; ; i++) {
      const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (n > 0) break;
      if (i > 60) throw new Error('the cast never waited on the uncommitted grant row');
      await new Promise(r => setTimeout(r, 25));
    }
    release();
    await writer;
    return outcome;
  }

  it.each([['own', 'AGENT_ORG_GRANT_INACTIVE'], ['included', 'BOOT_PROMPT_GRANT_REQUIRED']])('%s grant', async (which, expected) => {
    const target = which === 'own' ? main : libA;
    expect(await raceWith(target.id, 'Ada')).toBe(expected);
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
    expect((await grant(target.id))!.revokedAt).not.toBeNull();
    expect(await db.agentTeamEvent.count({ where: { appId: app.id } })).toBe(0);
  });
});
