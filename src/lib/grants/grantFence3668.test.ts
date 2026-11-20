/** #3668 S1a — every worker and session column on the grant tables joins the closed #1162 reference fence, in its own migration. */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { dropTestActions, insertEvent, insertGrant, seedWorld, type World } from './grantFixtures3668.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });
// Prisma surfaces the P1162 fence refusal as a typed message (src/lib/workerReferenceError.ts).
const MISSING = /Cannot add a new (?:worker|session) reference|WORKER_REFERENCE_NOT_FOUND/;

describe('grants', () => {
  it('requested_by_worker_id: a real worker passes, a missing one is refused by the fence', async () => {
    await expect(insertGrant(w, { requested_by_worker_id: w.workerId })).resolves.toBeTruthy();
    await expect(insertGrant(w, { requested_by_worker_id: 'no-such-worker' })).rejects.toThrow(MISSING);
  });
  it('requested_by_session_id: a real session passes, a missing one is refused', async () => {
    await expect(insertGrant(w, { requested_by_session_id: w.sessionId })).resolves.toBeTruthy();
    await expect(insertGrant(w, { requested_by_session_id: 'no-such-session' })).rejects.toThrow(MISSING);
  });
  it('the holder worker_id is fenced too: a missing worker never becomes a holder', async () => {
    await expect(insertGrant(w, { user_id: null, worker_id: w.workerId })).resolves.toBeTruthy();
    await expect(insertGrant(w, { user_id: null, worker_id: 'no-such-worker' })).rejects.toThrow(/Cannot add a new worker reference|WORKER_REFERENCE_NOT_FOUND|foreign key|a grant needs a holder/i);
  });
});
describe('grant_events (no foreign keys: sealed ids)', () => {
  it('worker_id and session_id must name a real worker / session at write time', async () => {
    const g = await insertGrant(w);
    await expect(insertEvent(w, g, { worker_id: w.workerId, session_id: w.sessionId })).resolves.toBeTruthy();
    await expect(insertEvent(w, g, { worker_id: 'no-such-worker' })).rejects.toThrow(MISSING);
    await expect(insertEvent(w, g, { session_id: 'no-such-session' })).rejects.toThrow(MISSING);
  });
});
