/**
 * #3789: the data-layer gate of the grants read, called directly by #3710's run tool. The soft-deleted-App concealment is
 * pinned HERE, on the function itself, because the resolver refuses a deleted App earlier and would hide a dropped guard.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from './grantFixtures3668.js';
import { getGrantForWorker, listGrantsForWorker } from './read.js';

let w: World;
let w2: string;
beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  w2 = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.app2Id, agentId: w.agentId, name: 'b', slug: `b-${generateId().slice(0, 6)}` } })).id;
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });
const row = (appId: string, workerId: string) => insertGrantUnguarded(w, { app_id: appId, user_id: null, worker_id: workerId, activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 't' });

describe('listGrantsForWorker / getGrantForWorker', () => {
  it('conceals a soft-deleted App\'s grants while a live App\'s row beside it still lists', async () => {
    const a = await row(w.appId, w.workerId);
    const b = await row(w.app2Id, w2);
    expect((await listGrantsForWorker(db, { appId: w.appId, workerId: w.workerId }, {})).items.map((i) => i.id)).toEqual([a]);
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    expect(await listGrantsForWorker(db, { appId: w.appId, workerId: w.workerId }, {})).toEqual({ items: [], total: 0 });
    expect(await getGrantForWorker(db, { appId: w.appId, workerId: w.workerId }, a)).toBeNull();
    expect((await listGrantsForWorker(db, { appId: w.app2Id, workerId: w2 }, {})).items.map((i) => i.id)).toEqual([b]);
  });

  it('is scoped to the reader\'s own App: a row of another App naming the same worker is absent', async () => {
    const stray = await row(w.app2Id, w.workerId);
    expect(await listGrantsForWorker(db, { appId: w.appId, workerId: w.workerId }, {})).toEqual({ items: [], total: 0 });
    expect(await getGrantForWorker(db, { appId: w.appId, workerId: w.workerId }, stray)).toBeNull();
  });
});
