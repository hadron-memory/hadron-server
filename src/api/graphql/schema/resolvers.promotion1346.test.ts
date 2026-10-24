/** #1346: promotion consumes current locked rows, including unrevisioned drift. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { memoryMutations } from './resolvers.mutation.memory.js';
import { resolvers } from './resolvers.js';
import { withTestOperationKey } from '../../../test/operationKey.js';
import { parseDataKey } from '../../../lib/crypto.js';
import { decryptNodeFieldsWithKey, isAuthenticatedStringEnvelope } from '../../../lib/nodeCrypto.js';

const dataKey = Buffer.alloc(32, 46).toString('base64');
let memoryId: string;
let appId: string;
let nodeId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Promotion race', urn: 'promotion1346.test' } });
  const app = await db.app.create({ data: { name: 'Promotion', urn: 'promotion1346.test:app', organizationId: org.id } });
  appId = app.id;
  const agent = await db.agent.create({ data: { name: 'Promotion', urn: 'promotion1346.test:agent', organizationId: org.id } });
  const memory = await db.memory.create({ data: { name: 'Anonymous', urn: 'promotion1346.test:anon', organizationId: org.id,
    appId, userMemoryOfAgentId: agent.id, class: 'app', anonymousExpiresAt: new Date(Date.now() + 86400000) } });
  memoryId = memory.id;
  nodeId = (await db.node.create({ data: { memoryId, loc: 'note', name: 'Note', content: 'original', abstract: 'original abstract', data: { value: 'original' } } })).id;
});

function promote() {
  return withTestOperationKey(dataKey, appId, () => resolvers.Mutation.linkMemoryToUser({},
    { memoryId, externalUserId: 'promotion-owner' }, { db, appId, roles: [] }));
}

/** Commit a competing change immediately before the deciding Memory lock.
 * Baseline has already scanned the node values; the repaired path must not have.
 * All actual SQL and encryption/completion code still run on the private DB.
 */
function beforePromotionLock(change: () => Promise<void>, beforeClaim?: (tx: any) => Promise<void>) {
  const transaction = db.$transaction.bind(db) as any;
  let fired = false;
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (input: any, options: any) => {
    if (typeof input !== 'function') return transaction(input, options);
    return transaction((tx: any) => input(new Proxy(tx, {
      get(target, property) {
        if (property === '$executeRaw' && beforeClaim) return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('').includes('UPDATE memories SET urn')) await beforeClaim(target);
          return target.$executeRaw(strings, ...values);
        };
        if (property !== '$queryRaw') return Reflect.get(target, property);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (!fired && strings.join('').includes('FROM memories') && strings.join('').includes('FOR UPDATE')) {
            fired = true;
            await change();
          }
          return target.$queryRaw(strings, ...values);
        };
      },
    })), options);
  }) as typeof db.$transaction);
  return { restore: () => spy.mockRestore(), fired: () => fired };
}

describe('#1346 anonymous encrypted promotion', () => {
  it('preserves a raw edit committed before the deciding lock', async () => {
    const barrier = beforePromotionLock(async () => {
      await db.node.update({ where: { id: nodeId }, data: { content: 'late edit', abstract: 'late abstract', data: { value: 'late' } } });
    });
    try { await promote(); } finally { barrier.restore(); }
    expect(barrier.fired()).toBe(true);
    const stored = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(isAuthenticatedStringEnvelope(stored.content, parseDataKey(dataKey))).toBe(true);
    expect(decryptNodeFieldsWithKey({ ...stored }, parseDataKey(dataKey)))
      .toMatchObject({ content: 'late edit', abstract: 'late abstract', data: { value: 'late' } });
  });

  it('records raw drift as ciphertext before advancing the live revision', async () => {
    const barrier = beforePromotionLock(async () => {
      await db.node.update({ where: { id: nodeId }, data: { content: 'late edit' } });
    });
    try { await promote(); } finally { barrier.restore(); }
    expect(barrier.fired()).toBe(true);
    const revisions = await db.nodeRevision.findMany({ where: { nodeId }, orderBy: { revNo: 'asc' } });
    expect(revisions).toHaveLength(1);
    for (const revision of revisions) expect(isAuthenticatedStringEnvelope(revision.content, parseDataKey(dataKey))).toBe(true);
    expect(revisions[0]).toMatchObject({ editedByInfo: 'system:revision-reconcile' });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).revSeq).toBe(revisions[0].revNo + 1);
    expect(decryptNodeFieldsWithKey({ ...revisions[0] }, parseDataKey(dataKey)).content).toBe('late edit');
  });

  it('includes a node inserted before the deciding lock', async () => {
    let insertedId = '';
    const barrier = beforePromotionLock(async () => {
      insertedId = (await db.node.create({ data: { memoryId, loc: 'late', name: 'Late', content: 'new node' } })).id;
    });
    try { await promote(); } finally { barrier.restore(); }
    expect(barrier.fired()).toBe(true);
    const inserted = await db.node.findUniqueOrThrow({ where: { id: insertedId } });
    expect(isAuthenticatedStringEnvelope(inserted.content, parseDataKey(dataKey))).toBe(true);
    expect(decryptNodeFieldsWithKey({ ...inserted }, parseDataKey(dataKey)).content).toBe('new node');
  });

  it('commits the new reconcile ciphertext even if history completion is interrupted', async () => {
    const barrier = beforePromotionLock(async () => {
      await db.node.update({ where: { id: nodeId }, data: { content: 'late edit' } });
    });
    const completion = vi.spyOn(memoryMutations, 'encryptMemory').mockRejectedValueOnce(new Error('interrupted completion'));
    try { await expect(promote()).rejects.toThrow('interrupted completion'); }
    finally { barrier.restore(); completion.mockRestore(); }
    expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted).toBe(true);
    const revisions = await db.nodeRevision.findMany({ where: { nodeId } });
    expect(revisions).toHaveLength(1);
    expect(isAuthenticatedStringEnvelope(revisions[0].content, parseDataKey(dataKey))).toBe(true);
    expect(decryptNodeFieldsWithKey({ ...revisions[0] }, parseDataKey(dataKey)).content).toBe('late edit');
  });

  it('rolls back reconcile, ciphertext and alias on a late claim refusal', async () => {
    const before = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const aliases = await db.urnAlias.count();
    const barrier = beforePromotionLock(async () => {
      await db.node.update({ where: { id: nodeId }, data: { content: 'late edit' } });
    }, async tx => { await tx.memory.update({ where: { id: memoryId }, data: { anonymousExpiresAt: new Date(0) } }); });
    try { await expect(promote()).rejects.toMatchObject({ extensions: { code: 'MEMORY_WRITE_CONFLICT' } }); }
    finally { barrier.restore(); }
    expect(barrier.fired()).toBe(true);
    expect(await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).toEqual(before);
    expect(await db.urnAlias.count()).toBe(aliases);
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(0);
    expect(await db.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({ content: 'late edit', revSeq: 1 });
  });

  it('refuses an expired anonymous holding before changing rows or provisioning a user', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { anonymousExpiresAt: new Date(0) } });
    const before = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    const users = await db.user.count();
    await expect(promote()).rejects.toThrow();
    expect(await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).toEqual(before);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('original');
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(0);
    expect(await db.user.count()).toBe(users);
  });

  it('serializes two admitted promotions with different keys; the loser cannot rewrite ciphertext', async () => {
    const otherKey = Buffer.alloc(32, 47).toString('base64');
    const transaction = db.$transaction.bind(db) as any;
    let ready!: () => void;
    const bothAtLock = new Promise<void>(resolve => { ready = resolve; });
    let arrivals = 0;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (input: any, options: any) => {
      if (typeof input !== 'function') return transaction(input, options);
      return transaction((tx: any) => input(new Proxy(tx, { get(target, property) {
        if (property !== '$queryRaw') return Reflect.get(target, property);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (strings.join('').includes('FROM memories') && strings.join('').includes('FOR UPDATE')) {
            arrivals++;
            if (arrivals === 2) ready();
            await bothAtLock;
          }
          return target.$queryRaw(strings, ...values);
        };
      } })), options);
    }) as typeof db.$transaction);
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([promote(), withTestOperationKey(otherKey, appId,
        () => resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'other-owner' }, { db, appId, roles: [] }))]);
    } finally { ready(); spy.mockRestore(); }
    expect(arrivals).toBe(2);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ extensions: { code: 'MEMORY_WRITE_CONFLICT' } });
    const winningKey = parseDataKey(results[0].status === 'fulfilled' ? dataKey : otherKey);
    const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    for (const value of [node.content, node.abstract]) expect(isAuthenticatedStringEnvelope(value, winningKey)).toBe(true);
    expect(decryptNodeFieldsWithKey({ ...node }, winningKey)).toMatchObject({ content: 'original', abstract: 'original abstract', data: { value: 'original' } });
  });


  it('a real queued bulk writer does not lock-invert with promotion', async () => {
    const admin = await db.user.create({ data: { handle: 'promotion-bulk-admin', roles: ['ADMIN'] } });
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    await db.orgMember.create({ data: { organizationId: memory.organizationId!, userId: admin.id, role: 'ADMIN' } });
    const second = await db.node.create({ data: { memoryId, loc: 'second', name: 'Second', content: 'original second' } });
    const transaction = db.$transaction.bind(db) as any;
    let queued = false;
    let writerResult: Promise<unknown> | undefined;
    const spy = vi.spyOn(db, '$transaction').mockImplementation((async (input: any, options: any) => {
      if (typeof input !== 'function') return transaction(input, options);
      return transaction((tx: any) => input(new Proxy(tx, { get(target, property) {
        if (property !== '$queryRaw') return Reflect.get(target, property);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const rows = await target.$queryRaw(strings, ...values);
          if (!queued && strings.join('').includes('FROM memories') && strings.join('').includes('FOR UPDATE')) {
            queued = true;
            // Promotion owns Memory, but has not requested any Node locks.
            // An inverse-order bulk writer would now take nodes and wait on
            // Memory, forming a cycle when this callback returns.
            writerResult = withTestOperationKey(dataKey, appId, () => resolvers.Mutation.searchReplaceInNodes({}, {
              input: { oldText: 'original', newText: 'bulk edit', nodeIds: [nodeId, second.id], fields: ['content'] },
            } as never, { db, userId: admin.id, roles: ['ADMIN'] })).then(() => null, error => error);
            await vi.waitFor(async () => {
              const blocked = await db.$queryRaw<Array<{ pid: number }>>`
                SELECT pid FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%FROM memories WHERE id%'
              `;
              expect(blocked.length).toBeGreaterThan(0);
            }, { timeout: 3000, interval: 20 });
          }
          return rows;
        };
      } })), options);
    }) as typeof db.$transaction);
    try { await promote(); } finally { spy.mockRestore(); }
    expect(queued).toBe(true);
    // The bulk writer computed plaintext edits before promotion. Its locked
    // recheck refuses those stale values after the promotion commits.
    expect(await writerResult).toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
    for (const id of [nodeId, second.id]) {
      const row = await db.node.findUniqueOrThrow({ where: { id } });
      expect(isAuthenticatedStringEnvelope(row.content, parseDataKey(dataKey))).toBe(true);
    }
  });

});
