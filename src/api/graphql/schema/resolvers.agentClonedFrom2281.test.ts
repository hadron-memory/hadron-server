/**
 * #2281 — Agent.clonedFromAgentRef: the origin of a clone is shown only to a caller who can read the
 * source, through the shared nested-Agent gate, and an unreadable origin is indistinguishable from none.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { PrismaClient } from '../../../generated/prisma/index.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const A = resolvers.Agent as any;
const M = resolvers.Mutation as any;
const field = (parent: unknown, c: Context): Promise<string | null> => A.clonedFromAgentRef(parent, {}, c);
/** The source as `Agent.urn` emits it: the form the field must return. */
const emit = (a: { urn: string }) => A.urn(a, {}, { db, roles: ['READER'] } as Context);
const asUser = (userId: string): Context => ({ db, userId, roles: ['READER'] });

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminB: string; let memberA: string; let stranger: string;
let n: number;

async function user(h: string) {
  return (await db.user.create({ data: { id: generateId(), name: h, handle: `${h}-${n}`, email: `${h}-${n}@x.test` } })).id;
}
async function memoryFor(orgId: string, urn: string) {
  const id = generateId();
  await db.memory.create({ data: { id, organizationId: orgId, urn: `${urn}-system`, name: 'sys', class: 'system', acceptsUploads: false } as never });
  return id;
}
async function source(slug: string, visibility: 'PUBLIC' | 'ORGANIZATION' | 'PERSONAL', extra: Record<string, unknown> = {}) {
  const urn = `${orgA.urn}:${slug}`;
  return db.agent.create({
    data: { id: generateId(), organizationId: orgA.id, urn, name: slug, visibility, systemMemoryId: await memoryFor(orgA.id, urn), ...extra } as never,
  });
}
/** A clone row in org B. With `src`, the clone audit row binds it to the source's identity, as cloneAgent does. */
async function cloneRow(ref: string | null, src?: { id: string }) {
  const c = await db.agent.create({ data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:c-${generateId().slice(-6)}`, name: 'c', visibility: 'ORGANIZATION', clonedFromAgentRef: ref } as never });
  if (src) {
    await db.agentCloneAudit.create({ data: { id: generateId(), sourceAgentId: src.id, newAgentId: c.id, targetOrgId: orgB.id, nodeCount: 0, edgeCount: 0, skippedEdgeCount: 0, importCount: 0, linkCount: 0 } as never });
  }
  return c;
}

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1e6);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'A', urn: `cf-a-${n}.example` }, select: { id: true, urn: true } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'B', urn: `cf-b-${n}.example` }, select: { id: true, urn: true } });
  adminB = await user('ab'); memberA = await user('ma'); stranger = await user('st');
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: adminB, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: memberA, role: 'READER' } });
});

describe('Agent.clonedFromAgentRef', () => {
  it('is declared on type Agent as a nullable String', () => {
    expect(typeDefs).toMatch(/clonedFromAgentRef: String\n/);
  });

  it('shows the source URN to a caller who can read a PUBLIC source', async () => {
    const src = await source('pub', 'PUBLIC');
    const c = await cloneRow(src.urn, src);
    expect(await field(c, asUser(adminB))).toBe(await emit(src));
  });

  it('is null for a non-clone, and an unreadable source is indistinguishable from it', async () => {
    const src = await source('priv', 'ORGANIZATION');
    const clone = await cloneRow(src.urn, src);
    const nonClone = await cloneRow(null);
    const forOutsider = await field(clone, asUser(adminB));
    expect(forOutsider).toBeNull();
    expect(forOutsider).toEqual(await field(nonClone, asUser(adminB)));
    // The source's own org member can read it.
    expect(await field(clone, asUser(memberA))).toBe(await emit(src));
  });

  it('a source made non-public after the clone stops showing to a caller outside its org', async () => {
    const src = await source('flip', 'PUBLIC');
    const c = await cloneRow(src.urn, src);
    expect(await field(c, asUser(adminB))).toBe(await emit(src));
    await db.agent.update({ where: { id: src.id }, data: { visibility: 'PERSONAL', organizationId: null, ownerUserId: stranger } });
    expect(await field(c, asUser(adminB))).toBeNull();
  });

  it('a soft-deleted source is null, even for its own managers', async () => {
    const src = await source('gone', 'ORGANIZATION');
    const c = await cloneRow(src.urn, src);
    await db.agent.update({ where: { id: src.id }, data: { deletedAt: new Date() } });
    expect(await field(c, asUser(memberA))).toBeNull();
    expect(await field(c, asUser(adminB))).toBeNull();
  });

  it('a source renamed since the clone still resolves by identity, to its current URN', async () => {
    const src = await source('renamed', 'PUBLIC');
    const c = await cloneRow(src.urn, src);
    const now = `${orgA.urn}:renamed-v2`;
    await db.agent.update({ where: { id: src.id }, data: { urn: now, legacyUrn: src.urn } });
    expect(await field(c, asUser(adminB))).toBe(await emit({ urn: now }));
  });

  it('a replacement Agent that took the old URN is never authorized or shown', async () => {
    const src = await source('reused', 'ORGANIZATION');
    const c = await cloneRow(src.urn, src);
    // The original is retired and renamed; a PUBLIC stranger takes its URN.
    await db.agent.update({ where: { id: src.id }, data: { urn: `${orgA.urn}:reused-old`, deletedAt: new Date() } });
    await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, urn: src.urn, name: 'imposter', visibility: 'PUBLIC' } as never });
    expect(await field(c, asUser(adminB))).toBeNull();
    expect(await field(c, asUser(memberA))).toBeNull();
  });

  it('a clone with no audit row (identity unknown) is null even if the stored URN names a public Agent', async () => {
    const pub = await source('pub2', 'PUBLIC');
    expect(await field(await cloneRow(pub.urn), asUser(adminB))).toBeNull();
  });

  const addAudit = (src: { id: string }, c: { id: string }) =>
    db.agentCloneAudit.create({ data: { id: generateId(), sourceAgentId: src.id, newAgentId: c.id, targetOrgId: orgB.id, nodeCount: 0, edgeCount: 0, skippedEdgeCount: 0, importCount: 0, linkCount: 0 } as never });

  it.each([
    ['A,B', ['a', 'b']],
    ['A,A,B (a conflicting third row)', ['a', 'a', 'b']],
    ['A,B,A', ['a', 'b', 'a']],
    ['B,A,A', ['b', 'a', 'a']],
  ])('audit rows %s name two sources: fail closed', async (_l, order) => {
    const srcs = { a: await source('amba', 'PUBLIC'), b: await source('ambb', 'PUBLIC') };
    const c = await cloneRow(srcs.a.urn);
    for (const k of order) await addAudit(srcs[k as 'a' | 'b'], c);
    expect(await field(c, asUser(adminB))).toBeNull();
  });

  it('duplicate audit rows naming the SAME source are one identity and still resolve', async () => {
    const a = await source('dup', 'PUBLIC');
    const c = await cloneRow(a.urn, a);
    await addAudit(a, c);
    await addAudit(a, c);
    expect(await field(c, asUser(adminB))).toBe(await emit(a));
  });

  it('equals the admitted source Agent.urn as emitted, through a rename', async () => {
    const a = await source('canon', 'PUBLIC');
    const c = await cloneRow(a.urn, a);
    const renamed = `${orgA.urn}:canon-v2`;
    await db.agent.update({ where: { id: a.id }, data: { urn: renamed } });
    const fresh = await db.agent.findUniqueOrThrow({ where: { id: a.id } });
    const origin = await field(c, asUser(adminB));
    expect(origin).toBe(await A.urn(fresh, {}, asUser(adminB)));
    expect(origin).not.toBe(await emit(a));
  });

  it('a pure App key reads a PUBLIC source but not an uninstalled private one', async () => {
    const pub = await source('p2', 'PUBLIC');
    const priv = await source('q2', 'ORGANIZATION');
    const { app } = await createDbAppWithKey(db, `cf-app-${n}`, orgB.id);
    const ctx: Context = { db, appId: app.id, roles: ['READER'] };
    expect(await field(await cloneRow(pub.urn, pub), ctx)).toBe(await emit(pub));
    expect(await field(await cloneRow(priv.urn, priv), ctx)).toBeNull();
  });

  it('a pure App key reads an INSTALLED, licensed private source', async () => {
    const priv = await source('inst', 'ORGANIZATION');
    const { app } = await createDbAppWithKey(db, `cf-inst-${n}`, orgA.id);
    await createDbAppAgent(db, app.id, priv.id);
    const ctx: Context = { db, appId: app.id, roles: ['READER'] };
    expect(await field(await cloneRow(priv.urn, priv), ctx)).toBe(await emit(priv));
  });

  it('an impersonating admin or App context gets no platform-admin or install bypass', async () => {
    const owner = await user('ow');
    const personal = await db.agent.create({ data: { id: generateId(), ownerUserId: owner, urn: `cf-pers-${n}.example:p`, name: 'p', visibility: 'PERSONAL', systemMemoryId: await memoryFor(orgA.id, `cf-pers-${n}.example:p`) } as never });
    const c = await cloneRow(personal.urn, personal);
    const admin = await db.user.create({ data: { id: generateId(), name: 'adm', handle: `adm-${n}`, email: `adm-${n}@x.test`, roles: ['ADMIN'] } });
    const imp = { orgId: orgB.id, adminUserId: admin.id } as never;
    expect(await field(c, { db, userId: stranger, roles: ['ADMIN'], impersonation: imp })).toBeNull();
    const { app } = await createDbAppWithKey(db, `cf-imp-${n}`, orgA.id);
    await createDbAppAgent(db, app.id, personal.id);
    expect(await field(c, { db, appId: app.id, userId: stranger, roles: ['READER'], impersonation: imp })).toBeNull();
  });

  it('issues one SQL statement that groups and limits the audit identities in PostgreSQL', async () => {
    const a = await source('sql', 'PUBLIC');
    const c = await cloneRow(a.urn, a);
    for (let i = 0; i < 5; i++) await addAudit(a, c);
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    const sqls: string[] = [];
    (logged as any).$on('query', (e: { query: string }) => sqls.push(e.query));
    try {
      const out = await field(c, { db: logged as never, userId: adminB, roles: ['READER'] });
      expect(out).toBe(await emit(a));
    } finally {
      await logged.$disconnect();
    }
    const audit = sqls.filter((q) => q.includes('agent_clone_audits'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatch(/GROUP BY|DISTINCT/i);
    expect(audit[0]).toMatch(/LIMIT/i);
  });

  it('makes no lookup for a row that is not a clone', async () => {
    const spy = vi.spyOn(db.agentCloneAudit, 'groupBy');
    await field(await cloneRow(null), asUser(adminB));
    expect(spy).not.toHaveBeenCalled();
    const a = await source('ctl', 'PUBLIC');
    await field(await cloneRow(a.urn, a), asUser(adminB));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('is populated on the cloneAgent return value for the cloner', async () => {
    const src = await source('mut', 'PUBLIC');
    const out = await M.cloneAgent(null, { source: src.id, target: orgB.id }, asUser(adminB));
    expect(await field(out, asUser(adminB))).toBe(await emit(src));
  });
});
