/** #1346: promotion consumes current locked rows, including unrevisioned drift. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
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
function beforePromotionLock(change: () => Promise<void>) {
  const transaction = db.$transaction.bind(db) as any;
  let fired = false;
  const spy = vi.spyOn(db, '$transaction').mockImplementation((async (input: any, options: any) => {
    if (typeof input !== 'function') return transaction(input, options);
    return transaction((tx: any) => input(new Proxy(tx, {
      get(target, property) {
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

  it('records drift separately before the promotion revision, both encrypted', async () => {
    const barrier = beforePromotionLock(async () => {
      await db.node.update({ where: { id: nodeId }, data: { content: 'late edit' } });
    });
    try { await promote(); } finally { barrier.restore(); }
    expect(barrier.fired()).toBe(true);
    const revisions = await db.nodeRevision.findMany({ where: { nodeId }, orderBy: { revNo: 'asc' } });
    expect(revisions).toHaveLength(2);
    for (const revision of revisions) expect(isAuthenticatedStringEnvelope(revision.content, parseDataKey(dataKey))).toBe(true);
    expect(revisions[0]).toMatchObject({ reason: 'system:revision-reconcile' });
    expect(revisions[0].revNo).toBeLessThan(revisions[1].revNo);
    expect(decryptNodeFieldsWithKey({ ...revisions[1] }, parseDataKey(dataKey)).content).toBe('late edit');
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
});
