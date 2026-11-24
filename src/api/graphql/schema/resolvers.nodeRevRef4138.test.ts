/**
 * #4138 (Entity refs S2, cor:api:140) — the node-revision family takes `nodeRevRef` (a revision URN or a PK),
 * resolved through `resolveNodeRevRef`, on `nodeRevision`, `restoreNodeRevision`, `deleteNodeRevision` and
 * `updateNodeRevision`. Hard rename: `revisionId` is an unknown argument. Every gate stays on the RESOLVED revision.
 * Everything runs through real GraphQL (argument validation included), not the resolver map directly.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { composeNodeRevUrn } from '../../../lib/entityRef/nodeRevRef.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const schema = buildSchema(typeDefs);
const run = (source: string, contextValue: Context) =>
  graphql({
    schema,
    source,
    contextValue,
    fieldResolver: (parent, args, context, info) => {
      const fields = resolvers[info.parentType.name as keyof typeof resolvers] as Record<string, Function> | undefined;
      const resolver = fields?.[info.fieldName];
      return typeof resolver === 'function' ? resolver(parent, args, context, info) : defaultFieldResolver(parent, args, context, info);
    },
  });

const adminCtx = (): Context => ({ db, roles: ['ADMIN'], userId: 'admin-user' }) as Context;
let outsider: { id: string };
let org: { id: string; urn: string };
let memory: { id: string; urn: string };
let node: { id: string; loc: string };
let rev1: { id: string };
let rev2: { id: string };
let urn1: string;
let urn2: string;

const NOT_FOUND = 'NOT_FOUND';
const code = (r: { errors?: readonly { extensions?: Record<string, unknown> }[] }) => r.errors?.[0]?.extensions?.code;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'nrr-org', urn: 'nrr-org' } });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' },
  });
  node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'guide', name: 'Current', content: 'now', revSeq: 3 } });
  rev1 = await db.nodeRevision.create({
    data: { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', revNo: 1, name: 'v1', content: 'body-1', createdAt: new Date('2026-01-01T00:00:00Z') },
  });
  rev2 = await db.nodeRevision.create({
    data: { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', revNo: 2, name: 'v2', content: 'body-2', createdAt: new Date('2026-01-02T00:00:00Z') },
  });
  urn1 = composeNodeRevUrn(memory.urn, 'guide', 1);
  urn2 = composeNodeRevUrn(memory.urn, 'guide', 2);
  outsider = await db.user.create({ data: { githubId: 413801, githubUsername: 'nrr-out', roles: ['READER'] } });
});

const outsiderCtx = (): Context => ({ db, roles: ['READER'], userId: outsider.id }) as Context;

describe('the four surfaces take nodeRevRef — a URN or a PK', () => {
  it('nodeRevision', async () => {
    for (const ref of [urn1, rev1.id]) {
      const r = await run(`{ nodeRevision(nodeRevRef: "${ref}") { id name } }`, adminCtx());
      expect(r.errors).toBeUndefined();
      expect(r.data?.nodeRevision).toEqual({ id: rev1.id, name: 'v1' });
    }
  });
  it('updateNodeRevision', async () => {
    for (const [ref, label] of [[urn1, 'by-urn'], [rev1.id, 'by-pk']] as const) {
      const r = await run(`mutation { updateNodeRevision(nodeRevRef: "${ref}", revLabel: "${label}") { id revLabel } }`, adminCtx());
      expect(r.errors).toBeUndefined();
      expect(r.data?.updateNodeRevision).toEqual({ id: rev1.id, revLabel: label });
    }
  });
  it('restoreNodeRevision', async () => {
    for (const ref of [urn1, rev1.id]) {
      const r = await run(`mutation { restoreNodeRevision(nodeRevRef: "${ref}") { id name } }`, adminCtx());
      expect(r.errors).toBeUndefined();
      expect(r.data?.restoreNodeRevision).toEqual({ id: node.id, name: 'v1' });
    }
  });
  it('deleteNodeRevision', async () => {
    expect((await run(`mutation { deleteNodeRevision(nodeRevRef: "${urn1}") }`, adminCtx())).data?.deleteNodeRevision).toBe(true);
    expect((await run(`mutation { deleteNodeRevision(nodeRevRef: "${rev2.id}") }`, adminCtx())).data?.deleteNodeRevision).toBe(true);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });
});

describe('revisionId is gone (hard rename, no alias)', () => {
  it.each([
    ['nodeRevision', (id: string) => `{ nodeRevision(revisionId: "${id}") { id } }`],
    ['restoreNodeRevision', (id: string) => `mutation { restoreNodeRevision(revisionId: "${id}") { id } }`],
    ['deleteNodeRevision', (id: string) => `mutation { deleteNodeRevision(revisionId: "${id}") }`],
    ['updateNodeRevision', (id: string) => `mutation { updateNodeRevision(revisionId: "${id}") { id } }`],
  ])('%s rejects revisionId as an unknown argument', async (_n, q) => {
    const r = await run(q(rev1.id), adminCtx());
    expect(r.errors?.[0]?.message).toMatch(/Unknown argument "revisionId"/);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(2); // nothing ran
  });
});

describe('unknown ≡ unreadable ≡ soft-deleted node ≡ soft-deleted memory (cor:api:140:01, :03)', () => {
  /** Each miss, as an [ensure-the-fixture-state, ctx, ref] triple. */
  const misses: [string, () => Promise<void>, () => Context, () => string, boolean?][] = [
    ['an unknown PK', async () => {}, adminCtx, () => 'cnope00000000000000000000'],
    ['an unknown URN', async () => {}, adminCtx, () => composeNodeRevUrn(memory.urn, 'guide', 99)],
    ['a malformed URN', async () => {}, adminCtx, () => 'hrn:noderev:not-a-real-urn'],
    ['a well-formed URN under a memory that does not exist', async () => {}, adminCtx, () => 'hrn:noderev:no-such-org:no-such-memory:guide:r1'],
    ['the empty string', async () => {}, adminCtx, () => ''],
    ['another entity\'s PK (a node id)', async () => {}, adminCtx, () => node.id],
    ['an unreadable PK', async () => {}, outsiderCtx, () => rev1.id],
    ['an unreadable URN', async () => {}, outsiderCtx, () => urn1],
    ['a soft-deleted node (PK)', async () => { await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } }); }, adminCtx, () => rev1.id, true],
    ['a soft-deleted node (URN)', async () => { await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } }); }, adminCtx, () => urn1],
    ['a soft-deleted memory (PK)', async () => { await db.memory.update({ where: { id: memory.id }, data: { deletedAt: new Date() } }); }, adminCtx, () => rev1.id],
    ['a soft-deleted memory (URN)', async () => { await db.memory.update({ where: { id: memory.id }, data: { deletedAt: new Date() } }); }, adminCtx, () => urn1],
  ];

  it.each(misses)('nodeRevision answers null for %s', async (_n, setup, ctx, ref) => {
    await setup();
    const r = await run(`{ nodeRevision(nodeRevRef: "${ref()}") { id } }`, ctx());
    expect(r.errors).toBeUndefined();
    expect(r.data?.nodeRevision).toBeNull();
  });

  it.each(misses)('restoreNodeRevision refuses %s with the typed NOT_FOUND', async (_n, setup, ctx, ref) => {
    await setup();
    const r = await run(`mutation { restoreNodeRevision(nodeRevRef: "${ref()}") { id } }`, ctx());
    expect(code(r)).toBe(NOT_FOUND);
    expect(r.errors?.[0]?.message).toBe('Node revision not found');
  });

  it.each(misses)('updateNodeRevision refuses %s with the typed NOT_FOUND', async (_n, setup, ctx, ref) => {
    await setup();
    const r = await run(`mutation { updateNodeRevision(nodeRevRef: "${ref()}", revLabel: "x") { id } }`, ctx());
    expect(code(r)).toBe(NOT_FOUND);
    expect(r.errors?.[0]?.message).toBe('Node revision not found');
  });

  // deleteNodeRevision keeps its own gate (#4138 "gates unchanged"): a tombstoned NODE's revision is still cleanable by PK
  // (as clearNodeHistory); by URN it is a missing ref and is in the matrix below. An unreadable memory is concealed as
  // not-found like the other doors (Rook P2: the URN is guessable), so unreadable cases ARE in this matrix.
  // The fifth tuple element marks that one case; nothing selects it by its display name.
  const deleteMisses = misses.filter(([, , , , deleteCleansByPk]) => !deleteCleansByPk);
  it.each(deleteMisses)('deleteNodeRevision refuses %s with the typed NOT_FOUND', async (_n, setup, ctx, ref) => {
    await setup();
    const r = await run(`mutation { deleteNodeRevision(nodeRevRef: "${ref()}") }`, ctx());
    expect(code(r)).toBe(NOT_FOUND);
    expect(r.errors?.[0]?.message).toBe('Node revision not found');
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(2); // nothing was deleted
  });

  it('all four doors answer unknown and unreadable with a byte-identical error, extensions, path and locations included', async () => {
    // Only the caller's own echoed ref (extensions.nodeRevRef) is normalised, after asserting it is exactly that ref;
    // every other byte of the response is compared as is.
    const wire = async (op: string, ref: string, ctx: Context) => {
      const r = await run(op.replace('REF', ref), ctx);
      return JSON.stringify({
        data: r.data,
        errors: r.errors?.map((e) => {
          const { nodeRevRef, ...rest } = (e.extensions ?? {}) as Record<string, unknown>;
          if (nodeRevRef !== undefined) expect(nodeRevRef).toBe(ref);
          return { message: e.message, path: e.path, locations: e.locations, extensions: rest, echoedRef: nodeRevRef === undefined ? null : '<ref>' };
        }),
      });
    };
    const ops = [
      `{ nodeRevision(nodeRevRef: "REF") { id } }`,
      `mutation { restoreNodeRevision(nodeRevRef: "REF") { id } }`,
      `mutation { updateNodeRevision(nodeRevRef: "REF", revLabel: "x") { id } }`,
      `mutation { deleteNodeRevision(nodeRevRef: "REF") }`,
    ];
    for (const [existing, missing] of [
      [rev1.id, 'cnope00000000000000000000'],
      [urn1, composeNodeRevUrn(memory.urn, 'guide', 99)],
    ] as const) {
      for (const op of ops) {
        expect(await wire(op, existing, outsiderCtx())).toBe(await wire(op, missing, outsiderCtx()));
      }
    }
  });

  it('deleteNodeRevision keeps its gate: a tombstoned node still takes the cleanup, an unreadable memory answers not-found (Rook P2, guessable URN)', async () => {
    const concealed = await run(`mutation { deleteNodeRevision(nodeRevRef: "${urn1}") }`, outsiderCtx());
    expect(code(concealed)).toBe(NOT_FOUND);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(2);
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
    // A URN into a tombstoned node is a missing ref (cor:api:140:00: the resolver excludes soft-deleted rows); the PK keeps
    // today's cleanup path, so an owner can still purge a deleted node's residual history by id.
    const viaUrn = await run(`mutation { deleteNodeRevision(nodeRevRef: "${urn1}") }`, adminCtx());
    expect(code(viaUrn)).toBe(NOT_FOUND);
    const viaPk = await run(`mutation { deleteNodeRevision(nodeRevRef: "${rev1.id}") }`, adminCtx());
    expect(viaPk.errors).toBeUndefined();
    expect(viaPk.data?.deleteNodeRevision).toBe(true);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });
});

describe('gates stay on the resolved revision, pinned with a URN', () => {
  it('a reader of the node memory but not the revision source memory gets null / NOT_FOUND', async () => {
    const other = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other`, name: 'other', class: 'knowledge' },
    });
    const moved = await db.nodeRevision.create({
      data: { id: generateId(), nodeId: node.id, memoryId: other.id, loc: 'guide', revNo: 3, name: 'v3', content: 'b3' },
    });
    await db.orgMember.create({ data: { organizationId: org.id, userId: outsider.id, role: 'READER' } });
    const ref = composeNodeRevUrn(memory.urn, 'guide', 3);
    // BEFORE: this very caller reads both memories (org member), and the URN resolves to the moved revision for them
    // and for an admin, so every refusal below is the gate acting on a revision that exists, not a miss.
    for (const ctx of [outsiderCtx(), adminCtx()]) {
      expect((await run(`{ nodeRevision(nodeRevRef: "${ref}") { id } }`, ctx)).data?.nodeRevision).toEqual({ id: moved.id });
    }
    // AFTER: `other` leaves the caller's org, so the same caller can no longer read the snapshot's source memory.
    await db.memory.update({ where: { id: other.id }, data: { organizationId: (await db.organization.create({ data: { id: generateId(), name: 'o2', urn: 'o2' } })).id } });
    expect((await run(`{ nodeRevision(nodeRevRef: "${ref}") { id } }`, adminCtx())).data?.nodeRevision).toEqual({ id: moved.id });
    const read = await run(`{ nodeRevision(nodeRevRef: "${ref}") { id } }`, outsiderCtx());
    expect(read.data?.nodeRevision).toBeNull();
    for (const q of [
      `mutation { restoreNodeRevision(nodeRevRef: "${ref}") { id } }`,
      `mutation { updateNodeRevision(nodeRevRef: "${ref}", revLabel: "x") { id } }`,
      `mutation { deleteNodeRevision(nodeRevRef: "${ref}") }`,
    ]) expect(code(await run(q, outsiderCtx()))).toBe(NOT_FOUND);
    expect(await db.nodeRevision.count({ where: { id: moved.id } })).toBe(1);
  });

  it('a reader without write gets Forbidden on restore, update and delete (URN)', async () => {
    await db.orgMember.create({ data: { organizationId: org.id, userId: outsider.id, role: 'READER' } });
    for (const q of [
      `mutation { restoreNodeRevision(nodeRevRef: "${urn1}") { id } }`,
      `mutation { updateNodeRevision(nodeRevRef: "${urn1}", revLabel: "x") { id } }`,
      `mutation { deleteNodeRevision(nodeRevRef: "${urn1}") }`,
    ]) {
      const r = await run(q, outsiderCtx());
      expect(r.errors?.[0]?.message).toMatch(/Forbidden/);
    }
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(2);
  });
});

describe('an ambiguous legacy alias in the URN is a missing revision (Byron P3, no existence-dependent answer)', () => {
  it('all four surfaces answer exactly as for an unknown ref, for an outsider and an admin', async () => {
    const other = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'other', name: 'Other', content: 'o' } });
    // BOTH candidates hold revision 1, so an implementation that silently picked either would resolve a real revision.
    const otherRev1 = await db.nodeRevision.create({
      data: { id: generateId(), nodeId: other.id, memoryId: memory.id, loc: 'other', revNo: 1, name: 'o1', content: 'other-1' },
    });
    const alias = (entityId: string) => ({
      urn: `${memory.urn}:shared-old`, entityType: 'NODE' as const, entityId,
      reason: 'RENAME' as const, replacedByUrn: `${memory.urn}:guide`,
    });
    const ambiguous = composeNodeRevUrn(memory.urn, 'shared-old', 1);
    // One candidate: the alias resolves, to that node's revision 1 (a reader sees it).
    await db.urnAlias.create({ data: alias(node.id) });
    expect((await run(`{ nodeRevision(nodeRevRef: "${ambiguous}") { id } }`, adminCtx())).data?.nodeRevision).toEqual({ id: rev1.id });
    // Two candidates: now ambiguous, and neither revision may be returned or touched.
    await db.urnAlias.create({ data: alias(other.id) });
    const unknown = composeNodeRevUrn(memory.urn, 'no-such-loc', 1);
    const ops = (ref: string) => [
      `{ nodeRevision(nodeRevRef: "${ref}") { id } }`,
      `mutation { restoreNodeRevision(nodeRevRef: "${ref}") { id } }`,
      `mutation { deleteNodeRevision(nodeRevRef: "${ref}") }`,
      `mutation { updateNodeRevision(nodeRevRef: "${ref}", revLabel: "x") { id } }`,
    ];
    for (const ctx of [outsiderCtx(), adminCtx()]) {
      const a = ops(ambiguous);
      const u = ops(unknown);
      for (let i = 0; i < a.length; i++) {
        const ra = await run(a[i]!, ctx);
        const ru = await run(u[i]!, ctx);
        expect(JSON.stringify(ra.errors?.map((e) => [e.message, e.extensions?.code]))).toBe(
          JSON.stringify(ru.errors?.map((e) => [e.message, e.extensions?.code])));
        expect(ra.errors?.[0]?.extensions?.code).not.toBe('AMBIGUOUS_LEGACY_URN');
      }
    }
    expect(await db.nodeRevision.count({ where: { id: { in: [rev1.id, otherRev1.id] } } })).toBe(2);
  });
});
