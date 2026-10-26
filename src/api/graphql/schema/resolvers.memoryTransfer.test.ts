import { beforeEach, describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { cleanDb } from '../../../test/helpers.js';
import { waitForLockWaiters, waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { resolvers, type Context } from './resolvers.js';
import { setMintedSpecPermanenceEnforcedForTests } from '../../../lib/mintedSpecPermanence.js';

// #1591: minted-spec permanence is switched off in production for now; the
// #1468 guard's own assertions run with it on.
beforeAll(() => setMintedSpecPermanenceEnforcedForTests(true));
afterAll(() => setMintedSpecPermanenceEnforcedForTests(false));

let owner: { id: string };
let receiver: { id: string };
let outsider: { id: string };
let org: { id: string; urn: string };
let memory: { id: string; urn: string };
let node: { id: string; loc: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const transfer = (input: Record<string, unknown>, userId = owner.id) =>
  resolvers.Mutation.transferMemoryOwnership(null, input as never, ctx(userId));

beforeEach(async () => {
  await cleanDb(db);
  owner = await db.user.create({ data: { id: generateId(), githubId: 147601, githubUsername: 'transfer-owner', handle: 'transfer-owner', roles: ['READER'] } });
  receiver = await db.user.create({ data: { id: generateId(), githubId: 147602, githubUsername: 'transfer-receiver', handle: 'transfer-receiver', roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 147603, githubUsername: 'transfer-outsider', handle: 'transfer-outsider', roles: ['ADMIN'] } });
  org = await db.organization.create({ data: { id: generateId(), name: 'Transfer Org', urn: 'transfer-org' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  memory = await db.memory.create({ data: {
    id: generateId(), ownerUserId: owner.id, userId: owner.id,
    urn: 'transfer-owner:specs', name: 'Specs', class: 'private', corpusDraft: false,
  } });
  node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'cor:spc:020:01', name: 'Rule', content: 'Permanent citation', tags: [] } });
});

describe('transferMemoryOwnership', () => {
  it('transfer waits for an in-flight share, then refuses the new dependent', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { class: 'personal' } });
    let release!: () => void;
    let held!: () => void;
    const holdGate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR UPDATE`;
      held();
      await holdGate;
    }, { timeout: 20_000 });
    await locked;

    const share = resolvers.Mutation.createMemoryShare(null, {
      memoryId: memory.id, granteeId: receiver.id, role: 'reader',
    }, ctx(owner.id));
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      const move = transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      release();
      await holder;
      await share;
      await expect(move).rejects.toMatchObject({ extensions: { code: 'MEMORY_TRANSFER_DEPENDENTS' } });
      expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).ownerUserId).toBe(owner.id);
      expect(await db.memoryShare.count({ where: { memoryId: memory.id, granteeId: receiver.id } })).toBe(1);
    } finally {
      release();
      await Promise.allSettled([holder, share]);
    }
  });

  it('previews without writes, then moves a minted corpus and preserves old citations and an audit log', async () => {
    const input = { memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' };
    const preview = await transfer({ ...input, dryRun: true });
    expect(preview).toMatchObject({
      oldUrn: memory.urn, newUrn: `${org.urn}:specs`, targetClass: 'knowledge',
      canApply: true, applied: false,
    });
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).urn).toBe(memory.urn);
    expect(await db.memoryLogEntry.count({ where: { memoryId: memory.id } })).toBe(0);

    const result = await transfer({ ...input, expectedNewUrn: preview.newUrn });
    expect(result.applied).toBe(true);
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: null, organizationId: org.id, userId: null,
      class: 'knowledge', visibility: 'ORGANIZATION', urn: `${org.urn}:specs`, legacyUrn: memory.urn,
    });
    expect((await resolveMemoryRef(db, `hrn:mem:${memory.urn}`)).id).toBe(memory.id);
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
    expect(await db.memoryLogEntry.findFirst({ where: { memoryId: memory.id, eventType: 'OTHER' } })).toMatchObject({
      detail: expect.objectContaining({ oldUrn: memory.urn, newUrn: `${org.urn}:specs`, fromOwner: owner.id, toOwner: org.id, actorId: owner.id }),
    });
  });

  it('requires source access before revealing destination or dependent details', async () => {
    const input = { memoryRef: memory.id, orgRef: 'nonexistent-org', targetClass: 'knowledge', dryRun: true };
    await expect(transfer(input, outsider.id)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    const oldUrn = memory.urn;
    await expect(transfer({ ...input, memoryRef: `hrn:mem:${oldUrn}` }, outsider.id)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
  });

  it('requires administration of the destination and a class conversion', async () => {
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, dryRun: true })).resolves.toMatchObject({
      canApply: false, blockers: expect.arrayContaining([expect.objectContaining({ code: 'MEMORY_TRANSFER_CLASS_REQUIRED' })]),
    });
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: owner.id } });
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' })).rejects.toThrow('Forbidden');
  });

  it('refuses encrypted and attached memories with typed preview blockers', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    const preview = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', dryRun: true });
    expect(preview.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ENCRYPTED_MEMORY_TRANSFER_UNSUPPORTED' })]));
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' })).rejects.toMatchObject({ extensions: { code: 'ENCRYPTED_MEMORY_TRANSFER_UNSUPPORTED' } });
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: false } });
    await db.memoryShare.create({ data: { memoryId: memory.id, granteeId: receiver.id, grantorId: owner.id, role: 'reader' } });
    const attached = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', dryRun: true });
    expect(attached.dependents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Memory shares', count: 1, handling: 'REFUSE' })]));
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' })).rejects.toMatchObject({ extensions: { code: 'MEMORY_TRANSFER_DEPENDENTS' } });
  });

  it('refuses an Agent memory grant before a transfer can change its tenant', async () => {
    const agent = await db.agent.create({ data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:grant-agent`, name: 'Grant Agent',
    } });
    await db.agentMemoryItem.create({ data: {
      id: generateId(), agentId: agent.id, memoryId: memory.id, role: 'read',
    } });
    const input = { memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' };
    const preview = await transfer({ ...input, dryRun: true });
    expect(preview.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Agent grants', count: 1, handling: 'REFUSE' }),
    ]));
    await expect(transfer(input)).rejects.toMatchObject({ extensions: { code: 'MEMORY_TRANSFER_DEPENDENTS' } });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: owner.id, organizationId: null, urn: memory.urn,
    });
  });

  it('re-roots on collision and rejects a stale preview', async () => {
    await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:specs`, name: 'Existing', class: 'knowledge', visibility: 'ORGANIZATION' } });
    const preview = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', dryRun: true });
    expect(preview.newUrn).not.toBe(`${org.urn}:specs`);
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', expectedNewUrn: `${org.urn}:specs` })).rejects.toMatchObject({ extensions: { code: 'STALE_TRANSFER_PREVIEW' } });
    const result = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', expectedNewUrn: preview.newUrn });
    expect(result.newUrn).toBe(preview.newUrn);
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
  });

  it('preserves a prior legacy spelling when transferring an already renamed memory', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { legacyUrn: 'transfer-owner:old-specs' } });
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    expect((await resolveNodeRef(db, `hrn:node:transfer-owner:old-specs:${node.loc}`)).id).toBe(node.id);
  });

  it('does not let a platform admin transfer another user\'s personal or private memory', async () => {
    const adminCtx = { db, userId: outsider.id, roles: ['ADMIN'] };
    for (const sourceClass of ['private', 'personal'] as const) {
      await db.memory.update({ where: { id: memory.id }, data: { class: sourceClass } });
      for (const destination of [
        { orgRef: org.id, targetClass: 'knowledge' },
        { userRef: receiver.id },
      ]) {
        for (const dryRun of [true, false]) {
          await expect(resolvers.Mutation.transferMemoryOwnership(null, {
            memoryRef: memory.id, ...destination, dryRun,
          }, adminCtx)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
        }
      }
    }
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: owner.id, organizationId: null, userId: owner.id, class: 'personal', urn: memory.urn,
    });
  });

  it('refuses a personal or private source to any user target before resolving that user', async () => {
    for (const sourceClass of ['private', 'personal'] as const) {
      await db.memory.update({ where: { id: memory.id }, data: { class: sourceClass } });
      for (const userRef of [receiver.id, 'nonexistent-user']) {
        for (const dryRun of [true, false]) {
          await expect(transfer({ memoryRef: memory.id, userRef, dryRun }))
            .rejects.toMatchObject({ extensions: { code: 'MEMORY_TRANSFER_USER_TARGET_UNSUPPORTED' } });
        }
      }
    }
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: owner.id, organizationId: null, userId: owner.id, class: 'personal', urn: memory.urn,
    });
  });

  it('can move org ownership back to a user while preserving both former roots', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    await resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, userRef: receiver.id, targetClass: 'private',
    }, { db, userId: outsider.id, roles: ['ADMIN'] });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: receiver.id, organizationId: null, userId: receiver.id,
      urn: 'transfer-receiver:specs', class: 'private',
    });
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
    expect((await resolveNodeRef(db, `hrn:node:${org.urn}:specs:${node.loc}`)).id).toBe(node.id);
  });

  it('uses the current destination handle when it changes during transfer', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    let pending: ReturnType<typeof transfer> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${receiver.id} FOR UPDATE`;
      pending = resolvers.Mutation.transferMemoryOwnership(null, {
        memoryRef: memory.id, userRef: receiver.id, targetClass: 'private',
      }, { db, userId: outsider.id, roles: ['ADMIN'] });
      await waitForLockWaiters(db);
      await tx.user.update({ where: { id: receiver.id }, data: { handle: 'transfer-renamed' } });
    }, { timeout: 10_000 });
    const result = await pending!;
    expect(result.newUrn).toBe('transfer-renamed:specs');
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      ownerUserId: receiver.id, urn: 'transfer-renamed:specs',
    });
  });

  it('does not let a former org admin delete a memory after its ownership changes', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Next Delete Owner', urn: 'next-delete-owner',
    } });
    const transaction = db.$transaction.bind(db);
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            await resolvers.Mutation.transferMemoryOwnership(null, {
              memoryRef: memory.id, orgRef: nextOrg.id,
            }, { db, userId: outsider.id, roles: ['ADMIN'] });
            return transaction(work as never);
          };
        }
        return Reflect.get(target, key);
      },
    });
    await expect(resolvers.Mutation.deleteMemory(null, { id: memory.id }, {
      db: raceDb, userId: owner.id, roles: ['READER'],
    })).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      organizationId: nextOrg.id, deletedAt: null,
    });
  });

  it('does not let a former org writer create a Channel after transfer', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Next Channel Owner', urn: 'next-channel-owner',
    } });
    const transaction = db.$transaction.bind(db);
    let transferred = false;
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            // The write opens more than one transaction; the race is the FIRST only.
            if (!transferred) {
              transferred = true;
              await resolvers.Mutation.transferMemoryOwnership(null, {
                memoryRef: memory.id, orgRef: nextOrg.id,
              }, { db, userId: outsider.id, roles: ['ADMIN'] });
            }
            return transaction(work as never);
          };
        }
        return Reflect.get(target, key);
      },
    });
    await expect(resolvers.Mutation.createChannel(null, { input: {
      memoryRef: memory.id, loc: 'chats:late', name: 'late',
    } }, { db: raceDb, userId: owner.id, roles: ['READER'] })).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    expect(await db.channel.count({ where: { memoryId: memory.id } })).toBe(0);
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ organizationId: nextOrg.id });
  });

  it.each(['create', 'update'] as const)('does not let a former org writer %s a node after transfer', async (mode) => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Next Node Owner', urn: 'next-node-owner',
    } });
    const transaction = db.$transaction.bind(db);
    let transferred = false;
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            if (!transferred) {
              transferred = true;
              await resolvers.Mutation.transferMemoryOwnership(null, {
                memoryRef: memory.id, orgRef: nextOrg.id,
              }, { db, userId: outsider.id, roles: ['ADMIN'] });
            }
            return transaction(work as never);
          };
        }
        return Reflect.get(target, key);
      },
    });
    const input = mode === 'create'
      ? { memoryId: memory.id, loc: 'late-node', name: 'Late', content: 'late write' }
      : { memoryId: memory.id, loc: node.loc, content: 'late write' };
    const mutation = mode === 'create' ? resolvers.Mutation.createNode : resolvers.Mutation.updateNode;
    await expect(mutation(null, { input }, { db: raceDb, userId: owner.id, roles: ['READER'] }))
      .rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    expect(transferred).toBe(true);
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'late-node' } })).toBe(0);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('Permanent citation');
  });

  it.each(['create', 'update', 'delete'] as const)('does not let a former org writer %s an edge after transfer', async (mode) => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const target = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'edge-target', name: 'Target' } });
    const edge = mode === 'create' ? null : await db.edge.create({ data: {
      id: generateId(), memoryId: memory.id, sourceId: node.id, targetId: target.id,
      loc: 'edge-before-transfer', name: 'Before',
    } });
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Next Edge Owner', urn: 'next-edge-owner',
    } });
    const transaction = db.$transaction.bind(db);
    let transferred = false;
    const raceDb = new Proxy(db, {
      get(targetDb, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0], options?: Parameters<typeof transaction>[1]) => {
            if (!transferred) {
              transferred = true;
              await resolvers.Mutation.transferMemoryOwnership(null, {
                memoryRef: memory.id, orgRef: nextOrg.id,
              }, { db, userId: outsider.id, roles: ['ADMIN'] });
            }
            return transaction(work as never, options as never);
          };
        }
        return Reflect.get(targetDb, key);
      },
    });
    const raceCtx = { db: raceDb, userId: owner.id, roles: ['READER'] };
    const pending = mode === 'create'
      ? resolvers.Mutation.createEdge(null, { sourceRef: node.id, targetRef: target.id, name: 'Late' }, raceCtx)
      : mode === 'update'
        ? resolvers.Mutation.updateEdge(null, { edgeRef: edge!.id, name: 'Late' }, raceCtx)
        : resolvers.Mutation.deleteEdge(null, { edgeRef: edge!.id }, raceCtx);
    await expect(pending).rejects.toThrow();
    expect(transferred).toBe(true);
    expect(await db.edge.count({ where: { memoryId: memory.id } })).toBe(mode === 'create' ? 0 : 1);
    if (edge) expect(await db.edge.findUniqueOrThrow({ where: { id: edge.id } })).toMatchObject({ name: 'Before' });
  });

  it.each(['move', 'delete'] as const)('does not let a former org writer %s a node after transfer', async (mode) => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Next Node Owner', urn: 'next-node-operation-owner' } });
    const transaction = db.$transaction.bind(db);
    let transferred = false;
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0], options?: Parameters<typeof transaction>[1]) => {
            if (!transferred) {
              transferred = true;
              await resolvers.Mutation.transferMemoryOwnership(null, {
                memoryRef: memory.id, orgRef: nextOrg.id,
              }, { db, userId: outsider.id, roles: ['ADMIN'] });
            }
            return transaction(work as never, options as never);
          };
        }
        return Reflect.get(target, key);
      },
    });
    const raceCtx = { db: raceDb, userId: owner.id, roles: ['READER'] };
    const pending = mode === 'move'
      ? resolvers.Mutation.moveNode(null, { sourceRef: node.id, targetUrn: `hrn:node:${org.urn}:specs:moved` }, raceCtx)
      : resolvers.Mutation.deleteNode(null, { nodeRef: node.id }, raceCtx);
    await expect(pending).rejects.toThrow();
    expect(transferred).toBe(true);
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      loc: node.loc, deletedAt: null, content: 'Permanent citation',
    });
  });

  it('serializes a pending Channel creation with transfer of its host', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Concurrent Channel Owner', urn: 'concurrent-channel-owner',
    } });
    let pendingTransfer: ReturnType<typeof transfer> | undefined;
    let pendingCreate: ReturnType<typeof resolvers.Mutation.createChannel> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR UPDATE`;
      pendingTransfer = resolvers.Mutation.transferMemoryOwnership(null, {
        memoryRef: memory.id, orgRef: nextOrg.id,
      }, { db, userId: outsider.id, roles: ['ADMIN'] });
      await waitForLockWaiters(db);
      pendingCreate = resolvers.Mutation.createChannel(null, { input: {
        memoryRef: memory.id, loc: 'chats:pending', name: 'pending',
      } }, ctx(owner.id));
      void pendingCreate.catch(() => {});
      await waitForLockWaiters(db, 2);
    }, { timeout: 10_000 });
    const [moved, created] = await Promise.allSettled([pendingTransfer!, pendingCreate!]);
    const current = await db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    if (moved.status === 'fulfilled') {
      expect(moved.value).toMatchObject({ applied: true });
      expect(created.status).toBe('rejected');
      expect(await db.channel.count({ where: { memoryId: memory.id } })).toBe(0);
      expect(current.organizationId).toBe(nextOrg.id);
    } else {
      expect(moved.reason).toMatchObject({ extensions: { code: 'MEMORY_TRANSFER_DEPENDENTS' } });
      expect(created.status).toBe('fulfilled');
      expect(await db.channel.count({ where: { memoryId: memory.id } })).toBe(1);
      expect(current.organizationId).toBe(org.id);
    }
  });

  it('does not revive a tombstoned Channel after its host transfers', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const channel = await resolvers.Mutation.createChannel(null, { input: {
      memoryRef: memory.id, loc: 'chats:former', name: 'former',
    } }, ctx(owner.id));
    await resolvers.Mutation.deleteChannel(null, { ref: channel.id }, ctx(owner.id));
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Next Restored Owner', urn: 'next-restored-owner',
    } });
    const transaction = db.$transaction.bind(db);
    let transferred = false;
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0]) => {
            // The write opens more than one transaction; the race is the FIRST only.
            if (!transferred) {
              transferred = true;
              await resolvers.Mutation.transferMemoryOwnership(null, {
                memoryRef: memory.id, orgRef: nextOrg.id,
              }, { db, userId: outsider.id, roles: ['ADMIN'] });
            }
            return transaction(work as never);
          };
        }
        return Reflect.get(target, key);
      },
    });
    await expect(resolvers.Mutation.createChannel(null, { input: {
      memoryRef: memory.id, loc: 'chats:former', name: 'former',
    } }, { db: raceDb, userId: owner.id, roles: ['READER'] })).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    expect(await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it('refuses erasure of a minted corpus until its owner hands it to a surviving org', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: receiver.id, role: 'OWNER' } });
    await db.memory.update({ where: { id: memory.id }, data: { corpusMintedAt: new Date() } });
    await db.node.update({ where: { id: node.id }, data: { tags: ['spec'] } });
    await expect(resolvers.Mutation.deleteUser(null, {}, ctx(owner.id))).rejects.toMatchObject({
      extensions: { code: 'SPEC_MINTED_PERMANENT' },
    });
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).ownerUserId).toBe(owner.id);

    const input = { memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' };
    const preview = await transfer({ ...input, dryRun: true });
    expect(preview).toMatchObject({ canApply: true, applied: false, oldUrn: memory.urn });
    await transfer({ ...input, expectedNewUrn: preview.newUrn });
    await resolvers.Mutation.deleteUser(null, {}, ctx(owner.id));
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      organizationId: org.id, ownerUserId: null, corpusMintedAt: expect.any(Date),
      urn: preview.newUrn, legacyUrn: memory.urn,
    });
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
  });

  it('bootstraps the receiving group owner when converting an unshared memory', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'group' });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({ class: 'group', visibility: 'GROUP' });
    expect(await db.memoryMember.findUniqueOrThrow({ where: { memoryId_userId: { memoryId: memory.id, userId: owner.id } } })).toMatchObject({ role: 'owner' });
  });

  it('requires an explicit member reset to transfer a valid group memory', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'group' });
    await db.memoryMember.create({ data: { memoryId: memory.id, userId: receiver.id, role: 'reader' } });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Next', urn: 'next-transfer-org' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: nextOrg.id, userId: owner.id, role: 'ADMIN' } });
    // A group owner-member left behind after org departure is not an org
    // administrator and cannot rehome the org's memory.
    await db.orgMember.deleteMany({ where: { organizationId: org.id, userId: owner.id } });
    const input = { memoryRef: memory.id, orgRef: nextOrg.id };
    await expect(transfer({ ...input, resetGroupMembers: true })).rejects.toThrow('Forbidden');
    await expect(transfer({
      memoryRef: memory.id, userRef: owner.id, targetClass: 'private', resetGroupMembers: true,
    })).rejects.toThrow('Forbidden');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
    const blocked = await transfer({ ...input, dryRun: true });
    expect(blocked.canApply).toBe(false);
    expect(blocked.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MEMORY_TRANSFER_DEPENDENTS', message: expect.stringContaining('resetGroupMembers') }),
    ]));
    const preview = await transfer({ ...input, resetGroupMembers: true, dryRun: true });
    expect(preview.canApply).toBe(true);
    expect(preview.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Memory members', count: 2, handling: 'REMOVE' }),
      expect.objectContaining({ kind: 'Receiving group owner', count: 1, handling: 'CREATE' }),
    ]));
    await transfer({ ...input, resetGroupMembers: true, expectedNewUrn: preview.newUrn });
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      organizationId: nextOrg.id, urn: `${nextOrg.urn}:specs`, class: 'group', visibility: 'GROUP',
    });
    expect(await db.memoryMember.findMany({ where: { memoryId: memory.id } })).toMatchObject([
      { userId: owner.id, role: 'owner' },
    ]);
    expect((await resolveNodeRef(db, `hrn:node:${memory.urn}:${node.loc}`)).id).toBe(node.id);
  });

  it('does not let a former group owner add a member after the reset transfer', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'group' });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Next Group', urn: 'next-group-owner' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: receiver.id, role: 'ADMIN' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: nextOrg.id, userId: receiver.id, role: 'ADMIN' } });
    const transaction = db.$transaction.bind(db);
    let transferred = false;
    const raceDb = new Proxy(db, {
      get(target, key) {
        if (key === '$transaction') {
          return async (work: Parameters<typeof transaction>[0], options?: Parameters<typeof transaction>[1]) => {
            if (!transferred) {
              transferred = true;
              await transfer({ memoryRef: memory.id, orgRef: nextOrg.id, resetGroupMembers: true }, receiver.id);
            }
            return transaction(work as never, options as never);
          };
        }
        return Reflect.get(target, key);
      },
    });
    await expect(resolvers.Mutation.addMemoryMember(null, {
      memoryRef: memory.id, userRef: outsider.id, role: 'reader',
    }, { db: raceDb, userId: owner.id, roles: ['READER'] })).rejects.toMatchObject({
      extensions: { code: 'FORBIDDEN' },
    });
    expect(transferred).toBe(true);
    expect(await db.memoryMember.findUnique({ where: { memoryId_userId: { memoryId: memory.id, userId: outsider.id } } })).toBeNull();
  });

  it('holds a pending group-member insert behind the transfer fence', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'group' });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Waiting Group', urn: 'waiting-group-owner' } });
    let pending: ReturnType<typeof resolvers.Mutation.addMemoryMember> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR UPDATE`;
      pending = resolvers.Mutation.addMemoryMember(null, {
        memoryRef: memory.id, userRef: outsider.id, role: 'reader',
      }, ctx(owner.id));
      void pending.catch(() => {});
      await waitForLockWaiters(db);
      await tx.memoryMember.deleteMany({ where: { memoryId: memory.id } });
      await tx.memory.update({ where: { id: memory.id }, data: {
        organizationId: nextOrg.id, urn: `${nextOrg.urn}:specs`,
      } });
      await tx.memoryMember.create({ data: { memoryId: memory.id, userId: receiver.id, role: 'owner' } });
    }, { timeout: 10_000 });
    await expect(pending!).rejects.toThrow();
    expect(await db.memoryMember.findUnique({ where: { memoryId_userId: { memoryId: memory.id, userId: outsider.id } } })).toBeNull();
  });

  it('honors a live memory.delete grant for the source org, but never a revoked membership', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Grant Target', urn: 'grant-target' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: nextOrg.id, userId: owner.id, role: 'ADMIN' } });
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: owner.id }, data: { role: 'CONTRIBUTOR' } });
    const grant = await db.principalGrant.create({ data: {
      id: generateId(), principalType: 'USER', principalId: owner.id,
      organizationId: org.id, actions: ['memory.delete'],
    } });
    const input = { memoryRef: memory.id, orgRef: nextOrg.id, dryRun: true };
    await expect(transfer(input)).resolves.toMatchObject({ canApply: true });
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: owner.id }, data: { deletedAt: new Date() } });
    await expect(transfer(input)).rejects.toMatchObject({ name: 'MemoryNotFoundError' });
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: owner.id }, data: { deletedAt: null } });
    await db.principalGrant.update({ where: { id: grant.id }, data: { deletedAt: new Date() } });
    await expect(transfer(input)).rejects.toThrow('Forbidden');
  });

  it('revokes group members when converting a group to a user-owned private memory', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'group' });
    await db.memoryMember.create({ data: { memoryId: memory.id, userId: receiver.id, role: 'reader' } });
    const result = await resolvers.Mutation.transferMemoryOwnership(null, {
      memoryRef: memory.id, userRef: receiver.id, targetClass: 'private', resetGroupMembers: true,
    }, { db, userId: outsider.id, roles: ['ADMIN'] });
    expect(result.applied).toBe(true);
    expect(await db.memoryMember.count({ where: { memoryId: memory.id } })).toBe(0);
    expect(await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      organizationId: null, ownerUserId: receiver.id, userId: receiver.id, class: 'private', visibility: null,
    });
  });

  it('refuses to carry git provenance into a new owner', async () => {
    await db.node.update({ where: { id: node.id }, data: { ownerRepo: 'old-owner/specs' } });
    const preview = await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge', dryRun: true });
    expect(preview.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Node mirror provenance', count: 1, handling: 'REFUSE' }),
    ]));
    await expect(transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' })).rejects.toMatchObject({ extensions: { code: 'MEMORY_TRANSFER_DEPENDENTS' } });
  });

  it('reports durable trigger URNs as dependents before changing their owner scope', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: { id: generateId(), name: 'Next', urn: 'next-transfer-org' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: nextOrg.id, userId: owner.id, role: 'ADMIN' } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'App' } });
    const olderUrn = 'transfer-owner:older-specs';
    await recordUrnRename(db, { entityType: 'MEMORY', entityId: memory.id, oldUrn: olderUrn, newUrn: `${org.urn}:specs` });
    await db.agentSchedule.create({ data: {
      id: generateId(), organizationId: org.id, appId: app.id, name: 'Nightly',
      runAt: new Date('2030-01-01T00:00:00Z'), entryNodeUrn: `hrn:node:${olderUrn}:${node.loc}`, enabled: false,
    } });
    const foreignApp = await db.app.create({ data: { id: generateId(), organizationId: nextOrg.id, urn: `${nextOrg.urn}:app`, name: 'Foreign App' } });
    await db.agentSchedule.create({ data: {
      id: generateId(), organizationId: nextOrg.id, appId: foreignApp.id, name: 'Foreign',
      runAt: new Date('2030-01-01T00:00:00Z'), entryNodeUrn: `hrn:node:${olderUrn}:${node.loc}`,
    } });
    const preview = await transfer({ memoryRef: memory.id, orgRef: nextOrg.id, dryRun: true });
    expect(preview.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Schedules', count: 1, handling: 'REFUSE' }),
    ]));
  });

  it('ignores deleted triggers but still blocks on disabled live triggers', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const nextOrg = await db.organization.create({ data: {
      id: generateId(), name: 'Trigger receiver', urn: 'trigger-receiver',
    } });
    await db.orgMember.create({ data: {
      id: generateId(), organizationId: nextOrg.id, userId: owner.id, role: 'ADMIN',
    } });
    const app = await db.app.create({ data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:trigger-app`, name: 'Trigger App',
    } });
    const entryNodeUrn = `hrn:node:${org.urn}:specs:${node.loc}`;
    const schedule = await db.agentSchedule.create({ data: {
      id: generateId(), organizationId: org.id, appId: app.id, name: 'Deleted schedule',
      runAt: new Date('2030-01-01T00:00:00Z'), entryNodeUrn, enabled: false,
      deletedAt: new Date(),
    } });
    await db.agentWebhook.create({ data: {
      id: generateId(), organizationId: org.id, appId: app.id, name: 'Deleted webhook',
      secret: `deleted-${generateId()}`, entryNodeUrn, enabled: false, deletedAt: new Date(),
    } });
    const input = { memoryRef: memory.id, orgRef: nextOrg.id };
    const preview = await transfer({ ...input, dryRun: true });
    expect(preview.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Schedules', count: 0 }),
      expect.objectContaining({ kind: 'Webhooks', count: 0 }),
    ]));
    expect(preview.canApply).toBe(true);
    await db.agentSchedule.update({ where: { id: schedule.id }, data: { deletedAt: null } });
    const live = await transfer({ ...input, dryRun: true });
    expect(live.dependents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'Schedules', count: 1, handling: 'REFUSE' }),
    ]));
  });

  it('closes updateMemory’s original org-to-org owner-change path', async () => {
    await transfer({ memoryRef: memory.id, orgRef: org.id, targetClass: 'knowledge' });
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'Other', urn: 'other-transfer-org' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: owner.id, role: 'ADMIN' } });
    await expect(resolvers.Mutation.updateMemory(null, { id: memory.id, organizationId: otherOrg.id }, ctx(owner.id))).rejects.toMatchObject({ extensions: { code: 'USE_TRANSFER_MEMORY_OWNERSHIP' } });
  });

  it('rejects owner change through updateMemory', async () => {
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'Other', urn: 'other-transfer-org' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: owner.id, role: 'ADMIN' } });
    await expect(resolvers.Mutation.updateMemory(null, { id: memory.id, organizationId: otherOrg.id }, ctx(owner.id))).rejects.toMatchObject({ extensions: { code: 'USE_TRANSFER_MEMORY_OWNERSHIP' } });
  });
});
