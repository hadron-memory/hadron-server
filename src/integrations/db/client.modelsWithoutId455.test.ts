/**
 * #455 — the id default must not depend on which insert path wrote the row.
 *
 * The extension in `client.ts` injects a `generateId()` (32-hex UUIDv7) on
 * `create` and `upsert`, but on main `createMany` / `createManyAndReturn`
 * fall through to the schema's `@default(cuid())`, so a batch-written Edge or
 * Node gets a cuid while a single write gets a UUIDv7. And the set of models
 * the extension must leave alone (no `id` field) is a hand list that has
 * already missed two models. These pins hold both halves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db, MODELS_WITHOUT_ID } from './client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { runAsActor } from '../../lib/requestActor.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';

/** The `generateId()` domain: 32 lowercase hex, version nibble 7, variant 10xx. */
const UUIDV7_HEX = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;

describe('#455 the no-id model set', () => {
  const dmmfNoId = Prisma.dmmf.datamodel.models
    .filter((model) => !model.fields.some((field) => field.name === 'id'))
    .map((model) => model.name)
    .sort();

  it('names the two models the hand list missed', () => {
    expect(MODELS_WITHOUT_ID.has('WorkerDeliveryTaskEvent')).toBe(true);
    expect(MODELS_WITHOUT_ID.has('StopConsumerDeclaration')).toBe(true);
  });

  it('equals the schema models that have no field named id', () => {
    expect([...MODELS_WITHOUT_ID].sort()).toEqual(dmmfNoId);
  });

  it('keys on "no field named id", not on a composite key', () => {
    // UserMerge and CommentMeta have a single-column key that is not `id`.
    expect(MODELS_WITHOUT_ID.has('UserMerge')).toBe(true);
    expect(MODELS_WITHOUT_ID.has('CommentMeta')).toBe(true);
    expect(MODELS_WITHOUT_ID.has('Edge')).toBe(false);
  });
});

describe('#455 createMany through the extension', () => {
  let user: { id: string };
  let app: { id: string };
  let memory: { id: string };
  let agent: { id: string };
  let worker: { id: string };
  let a: { id: string; loc: string };
  let b: { id: string; loc: string };

  const edgeRow = (loc: string, id?: string) => ({
    ...(id ? { id } : {}), memoryId: memory.id, sourceId: a.id, targetId: b.id, loc, name: 'cites',
  });

  beforeEach(async () => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { id: generateId(), name: 'Ids Org', urn: 'ids.example' } });
    user = await db.user.create({ data: { githubId: 455001, githubUsername: 'ids-user', handle: 'ids-user', roles: [] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
    const ctx: Context = { db, userId: user.id, roles: [] };
    memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'ids' }, ctx);
    agent = await db.agent.create({ data: { id: generateId(), urn: 'ids.example:server-engineer', name: 'server-engineer', organizationId: org.id } });
    app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: 'ids.example:team', organizationId: org.id } });
    worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Ida', slug: 'ida' } });
    a = await db.node.create({ data: { memoryId: memory.id, loc: 'a', name: 'a' } });
    b = await db.node.create({ data: { memoryId: memory.id, loc: 'b', name: 'b' } });
  });

  it('gives edge.createMany rows the same id domain as edge.create', async () => {
    const single = await db.edge.create({ data: edgeRow('a:cites:single') });
    expect(single.id).toMatch(UUIDV7_HEX);
    await db.edge.createMany({ data: [edgeRow('a:cites:1'), edgeRow('a:cites:2')] });
    const batch = await db.edge.findMany({ where: { memoryId: memory.id, loc: { in: ['a:cites:1', 'a:cites:2'] } } });
    expect(batch).toHaveLength(2);
    for (const row of batch) expect(row.id, row.loc).toMatch(UUIDV7_HEX);
  });

  it('gives edge.createManyAndReturn rows generateId() ids, and accepts one object as data', async () => {
    const rows = await db.edge.createManyAndReturn({ data: edgeRow('a:cites:one') });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(UUIDV7_HEX);
  });

  it('keeps caller-supplied ids and honours skipDuplicates', async () => {
    const mine = generateId();
    await db.edge.createMany({ data: [edgeRow('a:cites:mine', mine)] });
    expect((await db.edge.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'a:cites:mine' } })).id).toBe(mine);
    // The duplicate is skipped on its key; the new row gets an injected id.
    const result = await db.edge.createMany({
      data: [edgeRow('a:cites:mine', mine), edgeRow('a:cites:fresh')], skipDuplicates: true,
    });
    expect(result.count).toBe(1);
    expect((await db.edge.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'a:cites:fresh' } })).id).toMatch(UUIDV7_HEX);
  });

  it('still stamps node.createMany / createManyAndReturn, and gives them generateId() ids', async () => {
    await runAsActor({ workerId: worker.id, agentId: agent.id }, async () => {
      await db.node.createMany({ data: [{ memoryId: memory.id, loc: 'cm:1', name: 'cm' }] });
      await db.node.createManyAndReturn({ data: [{ memoryId: memory.id, loc: 'cm:2', name: 'cm' }] });
    });
    for (const loc of ['cm:1', 'cm:2']) {
      const row = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc } });
      expect(row.id, loc).toMatch(UUIDV7_HEX);
      expect(row, loc).toMatchObject({ createdByWorkerId: worker.id, createdByAgentId: agent.id });
    }
  });

  it('leaves a model with no id field alone', async () => {
    // AppMember is keyed by (appId, userId): an injected `id` would make Prisma refuse the write.
    await expect(db.appMember.createMany({ data: [{ appId: app.id, userId: user.id, role: 'owner' }] }))
      .resolves.toEqual({ count: 1 });
  });
});
