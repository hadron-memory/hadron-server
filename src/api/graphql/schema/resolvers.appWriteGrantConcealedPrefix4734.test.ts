/**
 * #4734 (Holger's ruling on the issue, extending ruling 0222, hrn:node:hadronmemory.com:specs:cor:agt:010:01:18; the twin
 * of #3526 for READ grants): an App write grant row never shows a `prefix` or a `registerNodeUrn` without its `memoryUrn`.
 * Both name content inside the target memory (a node path, a node URN), so where the projection conceals the memory it
 * withholds them with the URN. A viewer who may see the memory keeps all three.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { GRANT_MEMORY_SELECT } from '../../../lib/appWriteGrant.js';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { safeCanonicalUrn } from './resolvers.helpers.js';
import { resolvers } from './resolvers.js';
import { project } from './resolvers.appWriteGrant.js';

// The URN helper is wrapped so one test can make it return null for a VISIBLE memory (it never does in production: strict-then-raw).
vi.mock('./resolvers.helpers.js', async (orig) => {
  const actual = await orig<typeof import('./resolvers.helpers.js')>();
  return { ...actual, safeCanonicalUrn: vi.fn(actual.safeCanonicalUrn) };
});
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
beforeEach(async () => { await cleanDb(db); });

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const PREFIX = 'secret:plans';
const REGISTER = 'concealed4734.test:mine:secret:plans:register';

async function fixture() {
  const org = await db.organization.create({ data: { name: 'Conceal Org', urn: 'concealed4734.test' } });
  const owner = await db.user.create({ data: { handle: 'conceal-owner' } });
  await db.orgMember.create({ data: { userId: owner.id, organizationId: org.id, role: 'ADMIN' } });
  const peer = await db.user.create({ data: { handle: 'conceal-peer' } });
  await db.orgMember.create({ data: { userId: peer.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Conceal App', urn: 'concealed4734.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: peer.id, role: 'owner' } });
  const personal = await db.memory.create({ data: { name: 'mine', urn: 'concealed4734.test:mine', class: 'personal', userId: owner.id, organizationId: org.id } as never });
  const shared = await db.memory.create({ data: { name: 'shared', urn: 'concealed4734.test:shared', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
  return { org, owner, peer, app, personal, shared };
}
type F = Awaited<ReturnType<typeof fixture>>;

const rowOn = (f: F, memoryId: string, extra: Record<string, unknown> = {}) =>
  db.appMemoryWriteGrant.create({ data: { appId: f.app.id, memoryId, prefix: PREFIX, registerNodeUrn: REGISTER, grantedBy: f.owner.id, ...extra } });
const actingAs = (u: { id: string }) => ({ db, userId: u.id, roles: [] as never[] });
const projectionInputs = async (f: F, memoryId: string) => ({
  memory: await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { ...GRANT_MEMORY_SELECT, urn: true } }),
  app: await db.app.findUniqueOrThrow({ where: { id: f.app.id }, select: { id: true, organizationId: true, ownerUserId: true } }),
});

describe('#4734 a concealed write-grant target shows neither prefix nor registerNodeUrn', () => {
  it('revoke by an App manager who cannot see the owner\'s personal memory: row listed, URN, prefix and register URN all null', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    const r = await M.revokeAppMemoryWriteGrant({}, { id: row.id }, actingAs(f.peer));
    expect(r).toMatchObject({ id: row.id, memoryUrn: null, prefix: null, registerNodeUrn: null });
    expect(r.revokedAt).toBeInstanceOf(Date);
  });

  it('the projection withholds the prefix whether or not the grant cites a register URN (and the register URN when it does)', async () => {
    const f = await fixture();
    const { memory, app } = await projectionInputs(f, f.personal.id);
    const full = await rowOn(f, f.personal.id);
    expect(project(full, memory, app, f.peer.id)).toMatchObject({ memoryUrn: null, prefix: null, registerNodeUrn: null });
    const bare = { ...full, registerNodeUrn: null };
    expect(project(bare, memory, app, f.peer.id)).toMatchObject({ memoryUrn: null, prefix: null, registerNodeUrn: null });
  });

  it('the concealed row keeps its non-content fields (id, grantedBy, createdAt), so the row still lists', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    const { memory, app } = await projectionInputs(f, f.personal.id);
    expect(project(row, memory, app, f.peer.id)).toMatchObject({ id: row.id, appId: f.app.id, grantedBy: f.owner.id, createdAt: row.createdAt });
  });
});

describe('#4734 every concealed shape and door, not only revoke', () => {
  const listAs = (f: F, u: { id: string }, includeRevoked: boolean) =>
    Q.appMemoryWriteGrants({}, { appRef: f.app.id, includeRevoked }, actingAs(u)) as Promise<any[]>;

  it('the list as a concealed viewer returns no row at all, live or revoked, with includeRevoked on and off', async () => {
    const f = await fixture();
    await rowOn(f, f.personal.id);
    await rowOn(f, f.personal.id, { prefix: 'old:plans', revokedAt: new Date(), revokedBy: f.owner.id });
    expect(await listAs(f, f.peer, false)).toEqual([]);
    expect(await listAs(f, f.peer, true)).toEqual([]);
    expect((await listAs(f, f.owner, true)).map((g) => [g.prefix, g.registerNodeUrn !== null]).sort()).toEqual([['old:plans', true], [PREFIX, true]].sort());
  });

  it('a null memory (no row to show) gives null/null/null, and a revoked concealed row too', async () => {
    const f = await fixture();
    const live = await rowOn(f, f.personal.id);
    const { app } = await projectionInputs(f, f.personal.id);
    expect(project(live, null, app, f.peer.id)).toMatchObject({ memoryUrn: null, prefix: null, registerNodeUrn: null });
    const revoked = { ...live, revokedAt: new Date(), revokedBy: f.owner.id };
    const { memory } = await projectionInputs(f, f.personal.id);
    expect(project(revoked, memory, app, f.peer.id)).toMatchObject({ memoryUrn: null, prefix: null, registerNodeUrn: null, revokedBy: f.owner.id });
  });

  it('a private-class memory is concealed from a non-owner exactly as a personal one, and shown to its owner', async () => {
    const f = await fixture();
    const priv = await db.memory.create({ data: { name: 'priv', urn: 'concealed4734.test:priv', class: 'private', userId: f.owner.id, organizationId: f.org.id } as never });
    const row = await rowOn(f, priv.id);
    const { memory, app } = await projectionInputs(f, priv.id);
    expect(project(row, memory, app, f.peer.id)).toMatchObject({ memoryUrn: null, prefix: null, registerNodeUrn: null });
    expect(project(row, memory, app, f.owner.id)).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER });
  });

  it('the null rule follows the COMPUTED URN, not the visibility: a visible memory whose URN cannot be computed shows no prefix, no register URN, no mark', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.shared.id);
    await db.memory.update({ where: { id: f.shared.id }, data: { isEncrypted: true } }); // a memory with a real refusal reason
    const { memory, app } = await projectionInputs(f, f.shared.id);
    expect(project(row, memory, app, f.peer.id)).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER, notEffective: true, notEffectiveReason: 'encrypted' });
    vi.mocked(safeCanonicalUrn).mockReturnValueOnce(null as never);
    expect(project(row, memory, app, f.peer.id)).toMatchObject({ memoryUrn: null, prefix: null, registerNodeUrn: null, notEffective: null, notEffectiveReason: null });
  });

  it('the prefix and register URN follow the computed URN: neither is ever present while the URN is null, for every viewer and class', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    const { memory, app } = await projectionInputs(f, f.personal.id);
    for (const viewer of [f.owner.id, f.peer.id, undefined]) {
      for (const m of [memory, null]) {
        const out = project(row, m, app, viewer);
        if (out.memoryUrn === null) expect([out.prefix, out.registerNodeUrn]).toEqual([null, null]);
        else expect([out.prefix, out.registerNodeUrn]).toEqual([PREFIX, REGISTER]);
      }
    }
  });
});

describe('#4734 through the real GraphQL schema (prefix is nullable, so a null reaches the client instead of an error)', () => {
  const schema = buildSchema(typeDefs);
  const fieldResolver = (p: any, a: any, c: any, i: any) =>
    typeof (resolvers as any)[i.parentType.name]?.[i.fieldName] === 'function' ? (resolvers as any)[i.parentType.name][i.fieldName](p, a, c, i) : defaultFieldResolver(p, a, c, i);
  const exec = (source: string, variableValues: Record<string, unknown>, contextValue: unknown) => graphql({ schema, source, variableValues, contextValue, fieldResolver });

  it('revoke by a manager who cannot see the memory answers null/null/null with no errors; the owner still gets all three', async () => {
    const f = await fixture();
    const concealed = await rowOn(f, f.personal.id);
    const mine = await rowOn(f, f.personal.id, { prefix: 'other:plans' });
    const q = 'mutation($id: ID!){ revokeAppMemoryWriteGrant(id: $id){ id memoryUrn prefix registerNodeUrn } }';
    const asPeer = await exec(q, { id: concealed.id }, actingAs(f.peer));
    expect(asPeer.errors).toBeUndefined();
    expect(asPeer.data!.revokeAppMemoryWriteGrant).toEqual({ id: concealed.id, memoryUrn: null, prefix: null, registerNodeUrn: null });
    const asOwner = await exec(q, { id: mine.id }, actingAs(f.owner));
    expect(asOwner.errors).toBeUndefined();
    expect(asOwner.data!.revokeAppMemoryWriteGrant).toMatchObject({ prefix: 'other:plans', registerNodeUrn: REGISTER });
  });
});

describe('#4734 CONTROLS: a viewer who may see the memory keeps URN, prefix and register URN', () => {
  it('the memory\'s own owner: revoke and list both show all three', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    const listed = await Q.appMemoryWriteGrants({}, { appRef: f.app.id, includeRevoked: false }, actingAs(f.owner)) as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER });
    expect(listed[0].memoryUrn).not.toBeNull();
    const r = await M.revokeAppMemoryWriteGrant({}, { id: row.id }, actingAs(f.owner));
    expect(r).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER });
    expect(r.memoryUrn).not.toBeNull();
  });

  it('a shared (org) memory: a peer App manager sees all three through list and the projection', async () => {
    const f = await fixture();
    await rowOn(f, f.shared.id);
    const listed = await Q.appMemoryWriteGrants({}, { appRef: f.app.id, includeRevoked: false }, actingAs(f.peer)) as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER });
    expect(listed[0].memoryUrn).not.toBeNull();
  });

  it('give on a shared memory returns the URN and the prefix, and a grant that cites no register URN shows null for that field', async () => {
    const f = await fixture();
    const made = await M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.shared.urn, prefix: 'notes:plans' }, actingAs(f.owner));
    expect(made.prefix).toBe('notes:plans');
    expect(made.registerNodeUrn ?? null).toBeNull();
    expect(made.memoryUrn).not.toBeNull();
  });
});
