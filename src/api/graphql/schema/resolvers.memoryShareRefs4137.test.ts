/**
 * #4137 (Entity refs S1, Refs #775 chunk B) — the six memory share/member
 * mutations take refs. Every pin runs through GraphQL (`graphql()` over the real
 * SDL), because a direct resolver call bypasses argument validation and would
 * pass with the old argument names still in the SDL.
 *
 *   - createMemoryShare / updateMemoryShareRole: `memoryId` → `memoryRef`.
 *   - the three share mutations drop `granteeId` (`granteeRef` only).
 *   - the three member mutations drop `memoryId` / `userId` (`memoryRef` /
 *     `userRef` only).
 *
 * The gate order is the security property (cor:api:140:02, the canonical
 * existence-hiding set): memory resolved → principal gate → counterparty
 * resolved. A resolution miss folds into the gate's uniform FORBIDDEN.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { GraphQLError } from 'graphql';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveUserRefOrEmail } from '../../../lib/entityRef/userRef.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { AmbiguousLegacyUrnError, AmbiguousUserRefError, UserNotFoundError } from '../../../lib/entityRef/errors.js';
import { UrnNotQualifiedError } from '../../../lib/urn.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const schema = buildSchema(typeDefs);
const run = (source: string, userId: string) =>
  graphql({
    schema,
    source,
    contextValue: { db, userId, roles: ['READER'] } as Context,
    fieldResolver: (parent, args, context, info) => {
      const fields = resolvers[info.parentType.name as keyof typeof resolvers] as
        | Record<string, Function>
        | undefined;
      const resolver = fields?.[info.fieldName];
      return typeof resolver === 'function'
        ? resolver(parent, args, context, info)
        : defaultFieldResolver(parent, args, context, info);
    },
  });

type U = { id: string; handle: string; email: string };
let owner: U;
let grantee: U;
let stranger: U;
let personal: { id: string; urn: string };
let group: { id: string; urn: string };

const mkUser = async (h: string): Promise<U> => {
  const handle = `${h}-${generateId().slice(-8)}`.toLowerCase();
  const email = `${handle}@example.com`;
  const u = await db.user.create({ data: { id: generateId(), handle, email, roles: ['READER'] } });
  return { id: u.id, handle, email };
};
const asOwnerCtx = (): Context => ({ db, userId: owner.id, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  owner = await mkUser('s1-owner');
  grantee = await mkUser('s1-grantee');
  stranger = await mkUser('s1-stranger');
  const p = await (resolvers.Mutation as any).createMemory(
    null,
    { name: 'share-s1', memoryClass: 'personal' },
    asOwnerCtx(),
  );
  personal = await db.memory.findUniqueOrThrow({ where: { id: p.id }, select: { id: true, urn: true } });
  const org = await db.organization.create({
    data: { id: generateId(), name: 'm-org', urn: `m-org-${generateId().slice(-8)}` },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'OWNER' },
  });
  const g = await (resolvers.Mutation as any).createMemory(
    {},
    { orgRef: org.id, name: 'member-s1', memoryClass: 'group', visibility: 'GROUP' },
    { db, userId: owner.id, roles: ['ADMIN'] },
  );
  group = await db.memory.findUniqueOrThrow({ where: { id: g.id }, select: { id: true, urn: true } });
});

const createShare = (memoryRef: string, granteeRef: string, userId: string, role = 'reader') =>
  run(
    `mutation { createMemoryShare(memoryRef: ${JSON.stringify(memoryRef)}, granteeRef: ${JSON.stringify(granteeRef)}, role: ${role}) { memoryShare { role grantee { id } } } }`,
    userId,
  );
const updateShare = (memoryRef: string, granteeRef: string, userId: string, role = 'writer') =>
  run(
    `mutation { updateMemoryShareRole(memoryRef: ${JSON.stringify(memoryRef)}, granteeRef: ${JSON.stringify(granteeRef)}, role: ${role}) { memoryShare { role grantee { id } } } }`,
    userId,
  );
const shareRow = () =>
  db.memoryShare.findUnique({
    where: { memoryId_granteeId: { memoryId: personal.id, granteeId: grantee.id } },
  });
const refusal = (r: { errors?: readonly any[] }) =>
  JSON.stringify((r.errors ?? []).map((e) => ({ m: e.message, c: e.extensions?.code })));

describe('createMemoryShare / updateMemoryShareRole take memoryRef (#4137)', () => {
  it('createMemoryShare succeeds for the principal with a memory URN and with a PK', async () => {
    const byUrn = await createShare(personal.urn, grantee.handle, owner.id);
    expect(byUrn.errors).toBeUndefined();
    expect((byUrn.data as any).createMemoryShare.memoryShare).toMatchObject({
      grantee: { id: grantee.id },
      role: 'reader',
    });
    expect((await shareRow())?.memoryId).toBe(personal.id);
    await db.memoryShare.deleteMany({});
    const byPk = await createShare(personal.id, grantee.handle, owner.id);
    expect(byPk.errors).toBeUndefined();
    expect((await shareRow())?.role).toBe('reader');
  });

  it('updateMemoryShareRole succeeds for the principal with a memory URN and with a PK', async () => {
    expect((await createShare(personal.id, grantee.handle, owner.id)).errors).toBeUndefined();
    const byUrn = await updateShare(personal.urn, grantee.handle, owner.id, 'writer');
    expect(byUrn.errors).toBeUndefined();
    expect((await shareRow())?.role).toBe('writer');
    const byPk = await updateShare(personal.id, grantee.handle, owner.id, 'reader');
    expect(byPk.errors).toBeUndefined();
    expect((await shareRow())?.role).toBe('reader');
  });

  it('the old argument names are unknown arguments to GraphQL validation', async () => {
    const withMemoryId = await run(
      `mutation { createMemoryShare(memoryId: "${personal.id}", granteeRef: "${grantee.handle}", role: reader) { memoryShare { role } } }`,
      owner.id,
    );
    expect(refusal(withMemoryId)).toMatch(/Unknown argument .{1,3}memoryId/);
    const withGranteeId = await run(
      `mutation { createMemoryShare(memoryRef: "${personal.id}", granteeId: "${grantee.id}", role: reader) { memoryShare { role } } }`,
      owner.id,
    );
    expect(refusal(withGranteeId)).toMatch(/Unknown argument .{1,3}granteeId/);
    const updMemoryId = await run(
      `mutation { updateMemoryShareRole(memoryId: "${personal.id}", granteeRef: "${grantee.handle}", role: reader) { memoryShare { role } } }`,
      owner.id,
    );
    expect(refusal(updMemoryId)).toMatch(/Unknown argument .{1,3}memoryId/);
    const updGranteeId = await run(
      `mutation { updateMemoryShareRole(memoryRef: "${personal.id}", granteeId: "${grantee.id}", role: reader) { memoryShare { role } } }`,
      owner.id,
    );
    expect(refusal(updGranteeId)).toMatch(/Unknown argument .{1,3}granteeId/);
    const delGranteeId = await run(
      `mutation { deleteMemoryShare(memoryRef: "${personal.id}", granteeId: "${grantee.id}") { memoryId } }`,
      owner.id,
    );
    expect(refusal(delGranteeId)).toMatch(/Unknown argument .{1,3}granteeId/);
    expect(await shareRow()).toBeNull();
  });
});

describe('the share gate refuses a non-principal byte-identically (#4137, cor:api:140:02)', () => {
  it('a PK, a URN, an unknown ref and a deleted memory answer the same FORBIDDEN, for create and update', async () => {
    const deleted = await (resolvers.Mutation as any).createMemory(
      null,
      { name: 'share-s1-deleted', memoryClass: 'personal' },
      asOwnerCtx(),
    );
    const deletedRow = await db.memory.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
      select: { id: true, urn: true },
    });
    const refs = [personal.id, personal.urn, 'cnonexistentnonexistent12', deletedRow.id];
    for (const op of [createShare, updateShare]) {
      const answers = [];
      for (const ref of refs) answers.push(refusal(await op(ref, grantee.handle, stranger.id)));
      expect(new Set(answers).size).toBe(1);
      expect(JSON.parse(answers[0])[0].c).toBe('FORBIDDEN');
    }
    expect(await shareRow()).toBeNull();
  });

  it('counterparty half: a non-principal naming an UNKNOWN grantee gets the same bytes as one naming a REAL grantee', async () => {
    for (const op of [createShare, updateShare]) {
      const real = refusal(await op(personal.id, grantee.handle, stranger.id));
      const ghost = refusal(await op(personal.id, 'ghost-user-s1', stranger.id));
      const ghostEmail = refusal(await op(personal.id, 'ghost@nowhere.example', stranger.id));
      expect(ghost).toBe(real);
      expect(ghostEmail).toBe(real);
      expect(JSON.parse(real)[0].c).toBe('FORBIDDEN');
    }
  });

  it('a malformed memory URN is shape-only: the same URN_NOT_QUALIFIED for owner and non-owner', async () => {
    for (const op of [createShare, updateShare]) {
      const asOwner = await op('onesegment', grantee.handle, owner.id);
      const asStranger = await op('onesegment', grantee.handle, stranger.id);
      expect(refusal(asOwner)).toBe(refusal(asStranger));
      expect(refusal(asOwner)).not.toMatch(/FORBIDDEN/);
      expect(refusal(asOwner)).toMatch(/qualif/i);
    }
  });

  it('the principal still gets NOT_FOUND for an unknown grantee (order: memory, gate, grantee)', async () => {
    const r = await createShare(personal.id, 'ghost-user-s1', owner.id);
    expect(JSON.parse(refusal(r))[0].c).toBe('NOT_FOUND');
  });
});

describe('member mutations take memoryRef / userRef only (#4137)', () => {
  const add = (memoryRef: string, userRef: string, userId: string, role = 'reader') =>
    run(
      `mutation { addMemoryMember(memoryRef: ${JSON.stringify(memoryRef)}, userRef: ${JSON.stringify(userRef)}, role: ${role}) { memoryMember { role user { id } } } }`,
      userId,
    );
  const upd = (memoryRef: string, userRef: string, userId: string, role = 'writer') =>
    run(
      `mutation { updateMemoryMemberRole(memoryRef: ${JSON.stringify(memoryRef)}, userRef: ${JSON.stringify(userRef)}, role: ${role}) { memoryMember { role user { id } } } }`,
      userId,
    );
  const rm = (memoryRef: string, userRef: string, userId: string) =>
    run(
      `mutation { removeMemoryMember(memoryRef: ${JSON.stringify(memoryRef)}, userRef: ${JSON.stringify(userRef)}) { memoryId userId } }`,
      userId,
    );
  const member = () =>
    db.memoryMember.findUnique({
      where: { memoryId_userId: { memoryId: group.id, userId: grantee.id } },
    });

  it('the owner adds, updates and removes by URN and by PK', async () => {
    expect((await add(group.urn, grantee.handle, owner.id)).errors).toBeUndefined();
    expect((await member())?.role).toBe('reader');
    expect((await upd(group.id, grantee.handle, owner.id, 'writer')).errors).toBeUndefined();
    expect((await member())?.role).toBe('writer');
    expect((await rm(group.urn, grantee.handle, owner.id)).errors).toBeUndefined();
    expect(await member()).toBeNull();
  });

  it('the deprecated memoryId / userId aliases are unknown arguments', async () => {
    const cases = [
      `addMemoryMember(memoryId: "${group.id}", userRef: "${grantee.handle}", role: reader) { memoryMember { role } }`,
      `addMemoryMember(memoryRef: "${group.id}", userId: "${grantee.id}", role: reader) { memoryMember { role } }`,
      `updateMemoryMemberRole(memoryId: "${group.id}", userRef: "${grantee.handle}", role: writer) { memoryMember { role } }`,
      `updateMemoryMemberRole(memoryRef: "${group.id}", userId: "${grantee.id}", role: writer) { memoryMember { role } }`,
      `removeMemoryMember(memoryId: "${group.id}", userRef: "${grantee.handle}") { memoryId }`,
      `removeMemoryMember(memoryRef: "${group.id}", userId: "${grantee.id}") { memoryId }`,
    ];
    for (const c of cases) {
      const r = await run(`mutation { ${c} }`, owner.id);
      expect(refusal(r), c).toMatch(/Unknown argument .{1,3}(memoryId|userId)/);
    }
    expect(await member()).toBeNull();
  });

  it('a non-owner gets one FORBIDDEN for a PK, a URN and an unknown memory ref, and for an unknown or real user', async () => {
    for (const op of [add, upd]) {
      const answers = new Set<string>();
      for (const ref of [group.id, group.urn, 'cnonexistentnonexistent12']) {
        answers.add(refusal(await op(ref, grantee.handle, stranger.id)));
      }
      answers.add(refusal(await op(group.id, 'ghost-user-s1', stranger.id)));
      expect(answers.size).toBe(1);
      expect(JSON.parse([...answers][0])[0].c).toBe('FORBIDDEN');
    }
  });

  it('removeMemoryMember self-action: a non-owner naming an unknown user and a real other user get the same FORBIDDEN; only resolved === caller succeeds', async () => {
    await db.memoryMember.create({ data: { memoryId: group.id, userId: grantee.id, role: 'reader' } });
    const real = refusal(await rm(group.urn, owner.handle, grantee.id));
    const ghost = refusal(await rm(group.urn, 'ghost-user-s1', grantee.id));
    expect(ghost).toBe(real);
    expect(JSON.parse(real)[0].c).toBe('FORBIDDEN');
    const self = await rm(group.urn, grantee.handle, grantee.id);
    expect(self.errors).toBeUndefined();
    expect(await member()).toBeNull();
  });

  it('a relative URN gets URN_NOT_QUALIFIED identically for owner and non-owner, before the gate', async () => {
    const asOwner = await add('onesegment', grantee.handle, owner.id);
    const asStranger = await add('onesegment', grantee.handle, stranger.id);
    expect(refusal(asOwner)).toBe(refusal(asStranger));
    expect(refusal(asOwner)).not.toMatch(/FORBIDDEN/);
      expect(refusal(asOwner)).toMatch(/qualif/i);
  });
});

// #4761 §10 P2-1 (Riana): `Memory.legacyUrn` is non-unique by design, so a legacy
// URN can name two rows and `resolveMemoryRef` throws AmbiguousLegacyUrnError. That
// is an answer that depends on existence, and it must not reach a non-principal as
// anything but the gate's uniform FORBIDDEN (cor:api:140:02), the same bytes an
// unknown ref gets. The share mutations took a PK only on main, so this PR
// introduces the surface; the member gate already had it.
describe('an ambiguous legacy memory URN is concealed like an unknown ref (#4137 §10)', () => {
  const AMBIGUOUS = 'amb-org:amb-mem';
  const member = (memoryRef: string, userId: string, op: 'add' | 'upd' | 'rm') =>
    run(
      op === 'rm'
        ? `mutation { removeMemoryMember(memoryRef: ${JSON.stringify(memoryRef)}, userRef: ${JSON.stringify(grantee.handle)}) { memoryId } }`
        : `mutation { ${op === 'add' ? 'addMemoryMember' : 'updateMemoryMemberRole'}(memoryRef: ${JSON.stringify(memoryRef)}, userRef: ${JSON.stringify(grantee.handle)}, role: reader) { memoryMember { role } } }`,
      userId,
    );

  beforeEach(async () => {
    // Two live rows carrying the same legacy URN: the one ref resolves to neither.
    await db.memory.update({ where: { id: personal.id }, data: { legacyUrn: AMBIGUOUS } });
    await db.memory.update({ where: { id: group.id }, data: { legacyUrn: AMBIGUOUS } });
  });

  it('createMemoryShare and updateMemoryShareRole: a non-principal gets the unknown-ref FORBIDDEN', async () => {
    for (const op of [createShare, updateShare]) {
      const unknown = refusal(await op('cnonexistentnonexistent12', grantee.handle, stranger.id));
      const ambiguous = refusal(await op(AMBIGUOUS, grantee.handle, stranger.id));
      expect(JSON.parse(unknown)[0].c).toBe('FORBIDDEN');
      expect(ambiguous).toBe(unknown);
    }
    expect(await db.memoryShare.count()).toBe(0);
  });

  it('deleteMemoryShare: a non-principal gets the unknown-ref FORBIDDEN for an ambiguous memory ref (Celine QA)', async () => {
    const del = (memoryRef: string, userId: string) =>
      run(`mutation { deleteMemoryShare(memoryRef: ${JSON.stringify(memoryRef)}, granteeRef: ${JSON.stringify(grantee.handle)}) { memoryId } }`, userId);
    const unknown = refusal(await del('cnonexistentnonexistent12', stranger.id));
    expect(JSON.parse(unknown)[0].c).toBe('FORBIDDEN');
    expect(refusal(await del(AMBIGUOUS, stranger.id))).toBe(unknown);
  });

  it('the member mutations: a non-owner gets the unknown-ref FORBIDDEN', async () => {
    for (const op of ['add', 'upd', 'rm'] as const) {
      const unknown = refusal(await member('cnonexistentnonexistent12', stranger.id, op));
      const ambiguous = refusal(await member(AMBIGUOUS, stranger.id, op));
      expect(JSON.parse(unknown)[0].c).toBe('FORBIDDEN');
      expect(ambiguous).toBe(unknown);
    }
  });

  it('removeMemoryMember: a non-owner naming an ambiguous (case-colliding) email gets the unknown-user FORBIDDEN', async () => {
    const lower = `collide-${generateId().slice(-6)}@example.com`;
    await db.user.create({ data: { id: generateId(), handle: `c1-${generateId().slice(-6)}`, email: lower, roles: ['READER'] } });
    await db.user.create({ data: { id: generateId(), handle: `c2-${generateId().slice(-6)}`, email: lower.toUpperCase(), roles: ['READER'] } });
    const mixed = lower.replace('collide', 'Collide');
    const rm = (userRef: string) =>
      run(`mutation { removeMemoryMember(memoryRef: ${JSON.stringify(group.id)}, userRef: ${JSON.stringify(userRef)}) { memoryId } }`, stranger.id);
    const unknown = refusal(await rm('ghost-user-s1'));
    expect(JSON.parse(unknown)[0].c).toBe('FORBIDDEN');
    expect(refusal(await rm(mixed))).toBe(unknown);
  });
});

// Celine (QA, #4761): deleteMemoryShare resolves the grantee only AFTER it knows the
// caller is not the principal, and a non-principal must fail the same whether the
// named grantee exists or not. The fold sat in a bare catch with no pin; without it
// a stranger tells a real user from a ghost by the NOT_FOUND-vs-FORBIDDEN difference.
describe('deleteMemoryShare: the grantee is not an oracle for a non-principal (#4137 QA)', () => {
  const del = (granteeRef: string, userId: string) =>
    run(`mutation { deleteMemoryShare(memoryRef: ${JSON.stringify(personal.id)}, granteeRef: ${JSON.stringify(granteeRef)}) { memoryId } }`, userId);

  it('a stranger naming a ghost, a real user or a case-colliding email gets the same FORBIDDEN', async () => {
    const lower = `dcollide-${generateId().slice(-6)}@example.com`;
    await db.user.create({ data: { id: generateId(), handle: `d1-${generateId().slice(-6)}`, email: lower, roles: ['READER'] } });
    await db.user.create({ data: { id: generateId(), handle: `d2-${generateId().slice(-6)}`, email: lower.toUpperCase(), roles: ['READER'] } });
    const real = refusal(await del(grantee.handle, stranger.id));
    expect(JSON.parse(real)[0].c).toBe('FORBIDDEN');
    expect(refusal(await del('ghost-user-s1', stranger.id))).toBe(real);
    expect(refusal(await del(lower.replace('dcollide', 'Dcollide'), stranger.id))).toBe(real);
  });

  it('the principal still gets NOT_FOUND for a ghost (they already know the memory exists)', async () => {
    expect(JSON.parse(refusal(await del('ghost-user-s1', owner.id)))[0].c).toBe('NOT_FOUND');
  });
});

// #4761 blind P2-1 (Jack): the FORBIDDEN fold rests on `instanceof` checks, so the
// proof that nothing existence-dependent escapes it is the CLASS each resolver throws
// for each kind of miss. Pinned here at the resolver, with real rows, so the closed
// taxonomy is a test and not a reading of two source files. None of them is a raw
// GraphQLError (the one shape the folds would let through to a non-principal).
describe('the resolver error taxonomy behind the concealment folds (#4137 blind P2-1)', () => {
  const AMB = 'tax-org:tax-mem';
  const cls = async (f: () => Promise<unknown>) => {
    try { await f(); } catch (e) { return e as Error; }
    throw new Error('expected a refusal');
  };

  it('resolveMemoryRef: unknown, soft-deleted and ambiguous-legacy misses are typed classes, never a GraphQLError', async () => {
    const unknown = await cls(() => resolveMemoryRef(db, 'cnonexistentnonexistent12'));
    expect(unknown).toBeInstanceOf(MemoryNotFoundError);
    const gone = await db.memory.update({ where: { id: personal.id }, data: { deletedAt: new Date() } });
    expect(await cls(() => resolveMemoryRef(db, gone.id))).toBeInstanceOf(MemoryNotFoundError);
    await db.memory.update({ where: { id: group.id }, data: { legacyUrn: AMB } });
    await db.memory.update({ where: { id: personal.id }, data: { deletedAt: null, legacyUrn: AMB } });
    const ambiguous = await cls(() => resolveMemoryRef(db, AMB));
    expect(ambiguous).toBeInstanceOf(AmbiguousLegacyUrnError);
    for (const e of [unknown, ambiguous]) expect(e).not.toBeInstanceOf(GraphQLError);
  });

  it('resolveMemoryRef: a relative URN is a shape error (URN_NOT_QUALIFIED), the only class that propagates before the gate', async () => {
    expect(await cls(() => resolveMemoryRef(db, 'onesegment'))).toBeInstanceOf(UrnNotQualifiedError);
  });

  it('resolveUserRefOrEmail: an unknown user and a case-colliding email are typed classes, never a GraphQLError', async () => {
    const unknown = await cls(() => resolveUserRefOrEmail(db, 'ghost-user-s1'));
    expect(unknown).toBeInstanceOf(UserNotFoundError);
    const lower = `taxo-${generateId().slice(-6)}@example.com`;
    await db.user.create({ data: { id: generateId(), handle: `t1-${generateId().slice(-6)}`, email: lower, roles: ['READER'] } });
    await db.user.create({ data: { id: generateId(), handle: `t2-${generateId().slice(-6)}`, email: lower.toUpperCase(), roles: ['READER'] } });
    const ambiguous = await cls(() => resolveUserRefOrEmail(db, lower.replace('taxo', 'Taxo')));
    expect(ambiguous).toBeInstanceOf(AmbiguousUserRefError);
    for (const e of [unknown, ambiguous]) expect(e).not.toBeInstanceOf(GraphQLError);
  });
});
