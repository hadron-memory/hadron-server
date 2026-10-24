/** #1416 (R204, cor:api:010:02): a merge ends live source-related impersonations, then moves actor references to the survivor. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
import { approvedMergeProof } from '../../test/mergeConsent.js';
import { mergeUsers } from './mergeUsers.js';

let org: { id: string };
let source: { id: string };
let target: { id: string };
let other: { id: string };
let admin: { id: string };

const HOUR = 3_600_000;
const session = (data: { adminUserId: string; targetUserId: string; endedAt?: Date | null; endedBy?: string | null; expiresAt?: Date }) =>
  db.impersonationSession.create({ data: {
    id: generateId(), organizationId: org.id, expiresAt: new Date(Date.now() + HOUR), ...data,
  } });
const rowOf = (id: string) => db.impersonationSession.findUniqueOrThrow({ where: { id } });
const merge = async () => mergeUsers(db, {
  sourceUserId: source.id, targetUserId: target.id, actorUserId: admin.id,
  consentProof: await approvedMergeProof(db, source.id, target.id, admin.id),
});

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'imp1416', urn: `imp1416-${generateId()}.test` } });
  [source, target, other, admin] = await Promise.all([
    db.user.create({ data: { handle: `src-${generateId().slice(-6)}` } }),
    db.user.create({ data: { handle: `tgt-${generateId().slice(-6)}` } }),
    db.user.create({ data: { handle: `oth-${generateId().slice(-6)}` } }),
    db.user.create({ data: { handle: `adm-${generateId().slice(-6)}`, roles: ['ADMIN'] } }),
  ]);
});

describe('mergeUsers: impersonation sessions (#1416, R204)', () => {
  it.each(['admin', 'target'] as const)('ends a live session where the source is the %s and moves the participant to the survivor', async (role) => {
    const live = await session(role === 'admin'
      ? { adminUserId: source.id, targetUserId: other.id }
      : { adminUserId: other.id, targetUserId: source.id });
    await merge();
    const row = await rowOf(live.id);
    expect(row.endedAt).toBeInstanceOf(Date);
    expect(row.endedBy).toBeNull();
    expect(role === 'admin' ? row.adminUserId : row.targetUserId).toBe(target.id);
    expect(role === 'admin' ? row.targetUserId : row.adminUserId).toBe(other.id);
    const active = await db.impersonationSession.findMany({ where: { organizationId: org.id, endedAt: null, expiresAt: { gt: new Date() } } });
    expect(active).toEqual([]);
  });

  it('moves the exact source ender to the survivor, keeps NULL and a third-party ender, and never touches ended_at', async () => {
    const at = new Date(Date.now() - HOUR);
    const bySource = await session({ adminUserId: other.id, targetUserId: admin.id, endedAt: at, endedBy: source.id });
    const bySystem = await session({ adminUserId: other.id, targetUserId: admin.id, endedAt: at, endedBy: null });
    const byOther = await session({ adminUserId: source.id, targetUserId: admin.id, endedAt: at, endedBy: other.id });
    await merge();
    expect(await rowOf(bySource.id)).toMatchObject({ endedBy: target.id, endedAt: at });
    expect(await rowOf(bySystem.id)).toMatchObject({ endedBy: null, endedAt: at });
    expect(await rowOf(byOther.id)).toMatchObject({ endedBy: other.id, endedAt: at, adminUserId: target.id });
  });

  it('rewrites participants of an expired-but-unstamped session without stamping it', async () => {
    const expired = await session({ adminUserId: source.id, targetUserId: other.id, expiresAt: new Date(Date.now() - 1000) });
    await merge();
    expect(await rowOf(expired.id)).toMatchObject({ adminUserId: target.id, endedAt: null, endedBy: null });
  });

  it('leaves unrelated sessions alone', async () => {
    const unrelated = await session({ adminUserId: other.id, targetUserId: admin.id });
    await merge();
    expect(await rowOf(unrelated.id)).toMatchObject({ adminUserId: other.id, targetUserId: admin.id, endedAt: null });
  });

  it('accepts the historical self-pair when the survivor was the other participant', async () => {
    const ended = await session({ adminUserId: source.id, targetUserId: target.id, endedAt: new Date(Date.now() - HOUR) });
    await merge();
    expect(await rowOf(ended.id)).toMatchObject({ adminUserId: target.id, targetUserId: target.id });
  });

  it('rolls everything back, consent included, when the merge fails late', async () => {
    const live = await session({ adminUserId: source.id, targetUserId: other.id });
    const proof = await approvedMergeProof(db, source.id, target.id, admin.id);
    // The merge record is the last write and is unique per source: a pre-existing one fails it after every rewrite.
    await db.userMerge.create({ data: { sourceUserId: source.id, targetUserId: other.id, mergedBy: admin.id } });
    await expect(mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id, actorUserId: admin.id, consentProof: proof }))
      .rejects.toBeDefined();
    expect(await rowOf(live.id)).toMatchObject({ adminUserId: source.id, endedAt: null, endedBy: null });
    expect((await db.user.findUniqueOrThrow({ where: { id: source.id } })).deletedAt).toBeNull();
    expect(await db.userMergeConsent.count({ where: { consumedAt: null } })).toBe(1);
  });
});

describe('mergeUsers: workers.retired_by (#1416, R204)', () => {
  it('moves the source retirer to the survivor and leaves other retirers', async () => {
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.id}:a` } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.id}:t`, visibility: 'ORGANIZATION' } });
    const mk = (name: string, retiredBy: string) => db.worker.create({ data: {
      ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(),
      retiredAt: new Date(), retiredBy,
    } });
    const a = await mk('Aa', source.id);
    const b = await mk('Bb', other.id);
    await merge();
    expect((await db.worker.findUniqueOrThrow({ where: { id: a.id } })).retiredBy).toBe(target.id);
    expect((await db.worker.findUniqueOrThrow({ where: { id: b.id } })).retiredBy).toBe(other.id);
  });
});
