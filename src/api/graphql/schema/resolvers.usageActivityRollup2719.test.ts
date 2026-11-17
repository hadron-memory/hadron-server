/**
 * #2719 slice 2 (§10 evidence): the access gate on `usageActivity` is unchanged when the answer comes from the rollup.
 * The state row is set complete so every read here is served from `usage_activity_cells`, and each test first proves the
 * cells hold the very rows the gate must keep out, so a refusal cannot be an empty table.
 * Law: cor:acl:090:01 (own activity needs only a user; a resource scope uses the memory's READ gate; an unreadable memory
 * answers as a missing one; an empty or fully denied scope never falls back to own activity), cor:dmo:080:02 (events
 * scope on their own memoryId).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resolvers, type Context } from './resolvers.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

const Q = resolvers.Query as any;
let memA: { id: string }, memB: { id: string }, member: { id: string }, outsider: { id: string };
const asMember = (): Context => ({ db, userId: member.id, roles: ['READER'] }) as Context;
const asKey = (): Context => ({ db, appId: 'app-1', roles: [] }) as Context;
const hourAgo = () => new Date(Date.now() - 3 * 3_600_000);
const seed = (n: number, o: { userId?: string; memoryId?: string }) =>
  db.usageEvent.createMany({ data: Array.from({ length: n }, () => ({ id: generateId(), type: 'read', userId: o.userId ?? null, memoryId: o.memoryId ?? null, createdAt: hourAgo() })) });
const cellsFor = async (kind: string, id: string) => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT COALESCE(SUM(reads), 0) AS n FROM usage_activity_cells WHERE scope_kind = ${kind} AND scope_id = ${id}`)[0].n);
const reads = (r: Array<{ reads: number }>) => r.reduce((n, b) => n + b.reads, 0);

beforeEach(async () => {
  await cleanDb(db);
  await db.$executeRaw`UPDATE usage_activity_rollup_state SET complete = true`;
  const orgA = await db.organization.create({ data: { id: generateId(), name: 'rg-a', urn: `rg-a-${generateId().slice(-8)}` } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'rg-b', urn: `rg-b-${generateId().slice(-8)}` } });
  const mk = (org: { id: string; urn: string }, name: string) => db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${name}`, name, class: 'knowledge', visibility: 'ORGANIZATION' } });
  memA = await mk(orgA, 'mem-a');
  memB = await mk(orgB, 'mem-b');
  member = await db.user.create({ data: { id: generateId(), githubId: 271911, githubUsername: 'rg-member', roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 271912, githubUsername: 'rg-outsider', roles: ['READER'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: member.id, role: 'READER' } });
});
afterAll(async () => {
  await cleanDb(db);
  await db.$executeRaw`UPDATE usage_activity_rollup_state SET complete = false, applies_from = hadron_usage_cell((now() AT TIME ZONE 'UTC')::timestamp) + interval '15 minutes'`;
});

describe('usageActivity gate, answered from the rollup', () => {
  it('an unreadable memory answers exactly as a missing one while its cells hold the events', async () => {
    await seed(5, { userId: outsider.id, memoryId: memB.id });
    expect(await cellsFor('memory', memB.id)).toBe(5);
    const unreadable = await Q.usageActivity(null, { memoryRefs: [memB.id] }, asMember());
    expect(unreadable).toEqual([]);
    expect(unreadable).toEqual(await Q.usageActivity(null, { memoryRefs: [generateId()] }, asMember()));
  });

  it('a readable memory counts every user of it, and a mixed list drops only the unreadable ref', async () => {
    await seed(2, { userId: member.id, memoryId: memA.id });
    await seed(3, { userId: outsider.id, memoryId: memA.id });
    await seed(7, { userId: outsider.id, memoryId: memB.id });
    expect(reads(await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember()))).toBe(5);
    expect(await Q.usageActivity(null, { memoryRefs: [memA.id, memB.id, generateId()] }, asMember())).toEqual(await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember()));
  });

  it('an empty or fully denied memory scope never falls back to own activity, which the rollup does hold', async () => {
    await seed(4, { userId: member.id });
    expect(await cellsFor('user', member.id)).toBe(4);
    expect(await Q.usageActivity(null, { memoryRefs: [] }, asMember())).toEqual([]);
    expect(await Q.usageActivity(null, { memoryRefs: [memB.id] }, asMember())).toEqual([]);
    expect(reads(await Q.usageActivity(null, {}, asMember()))).toBe(4);
  });

  it('own activity is the caller\'s alone: another user\'s cells and memory-only events never show', async () => {
    await seed(2, { userId: member.id });
    await seed(9, { userId: outsider.id });
    await seed(6, { memoryId: memA.id }); // unattributed to any user: memory scope only
    expect(reads(await Q.usageActivity(null, {}, asMember()))).toBe(2);
    expect(reads(await Q.usageActivity(null, { memoryRefs: [memA.id] }, asMember()))).toBe(6);
  });

  it('a user-less App key gets the empty own-activity answer', async () => {
    await seed(3, { userId: member.id });
    expect(await Q.usageActivity(null, {}, asKey())).toEqual([]);
  });
});
