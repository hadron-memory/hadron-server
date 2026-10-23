/**
 * #2281 — Agent.clonedFromAgentRef: the origin of a clone is shown only to a caller who can read the
 * source, through the shared nested-Agent gate, and an unreadable origin is indistinguishable from none.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const A = resolvers.Agent as any;
const M = resolvers.Mutation as any;
const field = (parent: unknown, c: Context): Promise<string | null> => A.clonedFromAgentRef(parent, {}, c);
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
const cloneRow = (ref: string | null) =>
  db.agent.create({ data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:c-${generateId().slice(-6)}`, name: 'c', visibility: 'ORGANIZATION', clonedFromAgentRef: ref } as never });

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
    const c = await cloneRow(src.urn);
    expect(await field(c, asUser(adminB))).toBe(src.urn);
  });

  it('is null for a non-clone, and an unreadable source is indistinguishable from it', async () => {
    const src = await source('priv', 'ORGANIZATION');
    const clone = await cloneRow(src.urn);
    const nonClone = await cloneRow(null);
    const forOutsider = await field(clone, asUser(adminB));
    expect(forOutsider).toBeNull();
    expect(forOutsider).toEqual(await field(nonClone, asUser(adminB)));
    // The source's own org member can read it.
    expect(await field(clone, asUser(memberA))).toBe(src.urn);
  });

  it('a source made non-public after the clone stops showing to a caller outside its org', async () => {
    const src = await source('flip', 'PUBLIC');
    const c = await cloneRow(src.urn);
    expect(await field(c, asUser(adminB))).toBe(src.urn);
    await db.agent.update({ where: { id: src.id }, data: { visibility: 'PERSONAL', organizationId: null, ownerUserId: stranger } });
    expect(await field(c, asUser(adminB))).toBeNull();
  });

  it('a soft-deleted source is null, even for its own managers', async () => {
    const src = await source('gone', 'ORGANIZATION');
    const c = await cloneRow(src.urn);
    await db.agent.update({ where: { id: src.id }, data: { deletedAt: new Date() } });
    expect(await field(c, asUser(memberA))).toBeNull();
    expect(await field(c, asUser(adminB))).toBeNull();
  });

  it('a source whose URN changed since the clone still resolves through legacyUrn, to its current URN', async () => {
    const oldUrn = `${orgA.urn}:old-shape`;
    const src = await source('renamed', 'PUBLIC', { legacyUrn: oldUrn });
    const c = await cloneRow(oldUrn);
    expect(await field(c, asUser(adminB))).toBe(src.urn);
  });

  it('a ref that resolves to nothing is null, not an error', async () => {
    const c = await cloneRow(`${orgA.urn}:never-existed`);
    expect(await field(c, asUser(adminB))).toBeNull();
  });

  it('a pure App key reads a PUBLIC source but not an uninstalled private one', async () => {
    const pub = await source('p2', 'PUBLIC');
    const priv = await source('q2', 'ORGANIZATION');
    const { app } = await createDbAppWithKey(db, `cf-app-${n}`, orgB.id);
    const ctx: Context = { db, appId: app.id, roles: ['READER'] };
    expect(await field(await cloneRow(pub.urn), ctx)).toBe(pub.urn);
    expect(await field(await cloneRow(priv.urn), ctx)).toBeNull();
  });

  it('makes no lookup for a row that is not a clone', async () => {
    const spy = vi.spyOn(db.agent, 'findFirst');
    await field(await cloneRow(null), asUser(adminB));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is populated on the cloneAgent return value for the cloner', async () => {
    const src = await source('mut', 'PUBLIC');
    const out = await M.cloneAgent(null, { source: src.id, target: orgB.id }, asUser(adminB));
    expect(out.clonedFromAgentRef).toBe(src.urn);
    expect(await field(out, asUser(adminB))).toBe(src.urn);
  });
});
