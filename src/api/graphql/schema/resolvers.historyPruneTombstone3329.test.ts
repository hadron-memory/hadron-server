/**
 * #3329 (ruling 0195; cor:dmo:010:04 "A soft-deleted memory takes no writes", cor:dmo:060:04's liveness condition on
 * the history-pruning operations): deleteNodeRevision and clearNodeHistory refuse through a soft-deleted memory as if
 * it did not exist, whoever the caller and whatever access they still hold. Pins:
 *  1. red-first: the identical call by the same live org contributor succeeds in a live memory and is refused through a
 *     tombstoned one, for both mutations (clearNodeHistory by id and by URN), and no revision row is deleted;
 *  2. no oracle: the refusal equals the nonexistent-target refusal (message, code, extension keys), for a writer and an
 *     outsider alike;
 *  3. a soft delete that commits after the preflight is still refused (the locked re-check inside the write);
 *  4. out of scope by the ruling: a soft-deleted NODE in a LIVE memory keeps its history reachable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let memory: { id: string; urn: string };
let node: { id: string; loc: string };
let revisionId: string;
let contributorId: string;
let outsiderId: string;
let adminId: string;

const as = (userId: string, client: typeof db = db): Context =>
  ({ db: client, roles: userId === adminId ? ['ADMIN'] : ['READER'], userId } as Context);
const tombstone = () => db.memory.update({ where: { id: memory.id }, data: { deletedAt: new Date() } });
const revisionCount = () => db.nodeRevision.count({ where: { nodeId: node.id } });

/** The refusal's observable shape: message, code, and the extension keys (values differ only by the echoed ref). */
async function refusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e as { message: string; extensions?: Record<string, unknown> });
  expect(err, 'expected a refusal').not.toBeNull();
  return { message: err!.message, code: err!.extensions?.code, keys: Object.keys(err!.extensions ?? {}).sort() };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'prune-org', urn: 'prune-org' } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'mem', class: 'knowledge' } });
  node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'guide', name: 'Guide', content: 'now' } });
  for (const name of ['v1', 'v2']) {
    revisionId = (await db.nodeRevision.create({ data: { id: generateId(), nodeId: node.id, memoryId: memory.id, loc: 'guide', name, content: name } })).id;
  }
  contributorId = (await db.user.create({ data: { githubId: 33291, githubUsername: 'prune-contrib', roles: ['READER'] } })).id;
  outsiderId = (await db.user.create({ data: { githubId: 33292, githubUsername: 'prune-out', roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: contributorId, role: 'CONTRIBUTOR' } });
  // On main a platform ADMIN pruned THROUGH a tombstone (the write-through); org members were refused FORBIDDEN (an oracle).
  adminId = (await db.user.create({ data: { githubId: 33293, githubUsername: 'prune-admin', roles: ['ADMIN'] } })).id;
});

describe('#3329 deleteNodeRevision through a soft-deleted memory', () => {
  it.each(['contributor', 'admin'] as const)('the same %s deletes the revision in a live memory', async who => {
    expect(await resolvers.Mutation.deleteNodeRevision(null, { revisionId }, as(who === 'admin' ? adminId : contributorId))).toBe(true);
    expect(await revisionCount()).toBe(1);
  });

  it('is refused through a tombstoned memory, exactly like a nonexistent revision, for a writer and an outsider', async () => {
    await tombstone();
    const missing = await refusal(resolvers.Mutation.deleteNodeRevision(null, { revisionId: generateId() }, as(contributorId)));
    expect(missing.code).toBe('NOT_FOUND');
    for (const user of [adminId, contributorId, outsiderId]) {
      expect(await refusal(resolvers.Mutation.deleteNodeRevision(null, { revisionId }, as(user)))).toEqual(missing);
    }
    expect(await revisionCount()).toBe(2);
  });
});

describe('#3329 clearNodeHistory through a soft-deleted memory', () => {
  it.each(['contributor', 'admin'] as const)('the same %s clears the history in a live memory', async who => {
    expect(await resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, as(who === 'admin' ? adminId : contributorId))).toBe(2);
    expect(await revisionCount()).toBe(0);
  });

  it('is refused through a tombstoned memory, by id and by URN, exactly like a nonexistent node, for a writer and an outsider', async () => {
    await tombstone();
    const missing = await refusal(resolvers.Mutation.clearNodeHistory(null, { nodeRef: generateId() }, as(contributorId)));
    expect(missing.code).toBe('NODE_NOT_FOUND');
    for (const user of [adminId, contributorId, outsiderId]) {
      for (const nodeRef of [node.id, `hrn:node:${memory.urn}:${node.loc}`]) {
        expect(await refusal(resolvers.Mutation.clearNodeHistory(null, { nodeRef }, as(user)))).toEqual(missing);
      }
    }
    expect(await revisionCount()).toBe(2);
  });
});

describe('#3329 a soft delete that commits after the preflight', () => {
  /** A client whose write transaction starts only after the memory was tombstoned, as a concurrent deleteMemory would. */
  const tombstonedBeforeWrite = () => new Proxy(db, { get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return async (work: unknown, options?: unknown) => {
      await tombstone();
      return (db.$transaction as (w: unknown, o?: unknown) => Promise<unknown>)(work, options);
    };
  } }) as typeof db;

  it('deleteNodeRevision refuses inside the write, as not found, and deletes nothing', async () => {
    const missing = await refusal(resolvers.Mutation.deleteNodeRevision(null, { revisionId: generateId() }, as(adminId)));
    expect(await refusal(resolvers.Mutation.deleteNodeRevision(null, { revisionId }, as(adminId, tombstonedBeforeWrite())))).toEqual(missing);
    expect(await revisionCount()).toBe(2);
  });

  it('clearNodeHistory refuses inside the write, as not found, and deletes nothing', async () => {
    const missing = await refusal(resolvers.Mutation.clearNodeHistory(null, { nodeRef: generateId() }, as(adminId)));
    expect(await refusal(resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, as(adminId, tombstonedBeforeWrite())))).toEqual(missing);
    expect(await revisionCount()).toBe(2);
  });
});

describe('#3329 out of scope: a soft-deleted node in a live memory', () => {
  it('keeps its residual history reachable to both mutations', async () => {
    await db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } });
    expect(await resolvers.Mutation.deleteNodeRevision(null, { revisionId }, as(contributorId))).toBe(true);
    expect(await resolvers.Mutation.clearNodeHistory(null, { nodeRef: node.id }, as(contributorId))).toBe(1);
    expect(await revisionCount()).toBe(0);
  });
});
