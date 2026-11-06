/**
 * #2346: cross-App worker-name discovery costs a bounded number of database
 * operations however many unrelated Apps the caller can reach. Behavior (unique,
 * ambiguous, hidden, held, retired, selected-App) is pinned by
 * server.crossAppWorker1597.test.ts; this file pins the shape of the work.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import type { Context } from './resolvers.js';
import { resolveWorkerBindCandidatesByName } from './resolvers.worker.js';

let user: { id: string };
let org: { id: string; urn: string };
let agentId: string;

/** A ctx whose every database operation (raw included) is counted. */
function countingCtx(): { ctx: Context; ops: () => number } {
  let n = 0;
  const counted = db.$extends({
    query: { async $allOperations({ args, query }) { n++; return query(args); } },
  }) as unknown as Context['db'];
  return { ctx: { db: counted, userId: user.id, roles: ['READER'] }, ops: () => n };
}

async function app(name: string) {
  return db.app.create({ data: { organizationId: org.id, name, urn: `${org.urn}:${name.toLowerCase()}` } });
}
async function worker(appId: string, name: string, extra = {}) {
  return db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name,
    slug: `w-${generateId().slice(-8)}`, role: 'server-engineer', ...extra } });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  user = await db.user.create({ data: { githubId: 2346001, githubUsername: `d-${suffix}`, roles: ['READER'] } });
  org = await db.organization.create({ data: { name: 'Org', urn: `org-${suffix}.example` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'CONTRIBUTOR' } });
  agentId = (await db.agent.create({ data: { organizationId: org.id, name: 'Builder', urn: `${org.urn}:builder`,
    personaRole: 'server-engineer', visibility: 'ORGANIZATION' } })).id;
});

describe('resolveWorkerBindCandidatesByName round trips (#2346)', () => {
  it('does not grow with unrelated Apps when one candidate matches', async () => {
    const a = await app('Match');
    const w = await worker(a.id, 'Iris');
    for (let i = 0; i < 3; i++) await worker((await app(`Few${i}`)).id, `Other${i}`);
    const few = countingCtx();
    expect(await resolveWorkerBindCandidatesByName(few.ctx, 'iris')).toHaveLength(1);
    const fewOps = few.ops();

    for (let i = 0; i < 30; i++) await worker((await app(`Many${i}`)).id, `Noise${i}`);
    const many = countingCtx();
    const got = await resolveWorkerBindCandidatesByName(many.ctx, 'iris');
    expect(got.map((c) => c.id)).toEqual([w.id]);
    expect(many.ops()).toBe(fewOps);
  });

  it('keeps ambiguity visible and orders candidates by App URN', async () => {
    const b = await app('Bbb'); const a = await app('Aaa');
    const wb = await worker(b.id, 'Iris'); const wa = await worker(a.id, 'IRIS');
    await worker((await app('Ccc')).id, 'Iris', { retiredAt: new Date() });
    const { ctx } = countingCtx();
    expect((await resolveWorkerBindCandidatesByName(ctx, 'iris')).map((c) => c.id)).toEqual([wa.id, wb.id]);
  });

  it('a same-name worker in an unreachable App neither matches nor changes the work done', async () => {
    const mine = await worker((await app('Mine')).id, 'Iris');
    const foreign = await db.organization.create({ data: { name: 'Hidden', urn: `hidden-${generateId()}.example` } });
    const hiddenApp = await db.app.create({ data: { organizationId: foreign.id, name: 'H', urn: `${foreign.urn}:h` } });
    const before = countingCtx();
    expect((await resolveWorkerBindCandidatesByName(before.ctx, 'Iris')).map((c) => c.id)).toEqual([mine.id]);
    await worker(hiddenApp.id, 'Iris');
    const after = countingCtx();
    expect((await resolveWorkerBindCandidatesByName(after.ctx, 'Iris')).map((c) => c.id)).toEqual([mine.id]);
    expect(after.ops()).toBe(before.ops());
  });

  it('scales only with matching Apps, never silently picking among them', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await worker((await app(`M${i}`)).id, 'Iris')).id);
    const { ctx } = countingCtx();
    expect((await resolveWorkerBindCandidatesByName(ctx, 'iris')).map((c) => c.id).sort()).toEqual([...ids].sort());
  });
});
