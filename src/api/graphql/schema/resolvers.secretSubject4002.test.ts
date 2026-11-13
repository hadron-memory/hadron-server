/**
 * S7 (#4002), cor:sec:080:01 — PREPARED acceptance pins.
 *
 * Dispatch requires S2 (#3997) to merge before implementation/baselining. These use the planned existing
 * createSecret App arm and new eraseSecretsBySubject surface; on pre-S2 main, ownerType=app is refused before
 * S7 behavior is reached. That prerequisite failure is NOT a valid red for this slice. Re-run on S2's verified
 * merge, inspect assertion failures, and commit any seam adjustments before the implementation commit.
 * No fake/skipped/mocked erasure implementation stands in for the real mutation.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
let managerId: string, subjectId: string, platformAdminId: string;
let apps: { id: string }[];
let priorRoot: string | undefined;
const ctx = (userId = managerId, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });
const store = (appId: string, name: string, subject?: string) => M.createSecret({}, {
  ownerType: 'app', ownerRef: appId, name, kind: 'generic', value: { token: 'synthetic-4002-only' },
  ...(subject === undefined ? {} : { subject }),
}, ctx());
const erase = (appId: string, subject: string, caller = ctx()) => M.eraseSecretsBySubject({}, { appRef: appId, subject }, caller);
const row = (id: string) => db.secret.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  priorRoot = process.env.SECRET_ROOT_KEY;
  process.env.SECRET_ROOT_KEY = '42'.repeat(32); // Dedicated synthetic S1 root, never a live credential.
  await cleanDb(db);
  managerId = (await db.user.create({ data: { id: generateId(), handle: 'subject4002-manager' } })).id;
  subjectId = (await db.user.create({ data: { id: generateId(), handle: 'subject4002-before' } })).id;
  platformAdminId = (await db.user.create({ data: { id: generateId(), handle: 'subject4002-platform', roles: ['ADMIN'] } })).id;
  const orgs = await Promise.all([0, 1].map(i => db.organization.create({ data: {
    id: generateId(), name: `Subject fixture ${i}`, urn: `subject4002-${i}.test`,
  } })));
  for (const org of orgs) await db.orgMember.create({ data: { organizationId: org.id, userId: managerId, role: 'ADMIN' } });
  apps = await Promise.all([0, 1, 2].map(i => db.app.create({ data: {
    id: generateId(), name: `Subject App ${i}`, urn: `subject4002-${i % 2}.test:a${i}`, organizationId: orgs[i % 2].id,
  } })));
});
afterEach(() => {
  if (priorRoot === undefined) delete process.env.SECRET_ROOT_KEY;
  else process.env.SECRET_ROOT_KEY = priorRoot;
});

describe('#4002 subject labels and erasure (requires merged S2)', () => {
  it('stores only a keyed subject hash, shared across Apps and NFC/case/spacing variants', async () => {
    const a = await store(apps[0].id, 'label-a', '  CAF\u00c9-4002  ');
    const b = await store(apps[1].id, 'label-b', 'cafe\u0301-4002');
    const ah = (await row(a.id) as unknown as { subjectHash?: string }).subjectHash;
    const bh = (await row(b.id) as unknown as { subjectHash?: string }).subjectHash;
    expect(ah).toEqual(expect.any(String));
    expect(ah).not.toBe('caf\u00e9-4002');
    expect(bh).toBe(ah);
    expect(await erase(apps[0].id, 'caf\u00e9-4002')).toBe(1);
    expect(await db.secret.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await row(b.id)).toBeDefined(); // Manual arm is App-scoped, despite the platform-wide key.
  });

  it('returns 0 for an authorized no-match and preserves unlabelled/differently labelled secrets', async () => {
    const none = await store(apps[0].id, 'unlabelled');
    const other = await store(apps[0].id, 'other-label', 'another-subject');
    expect(await erase(apps[0].id, 'missing-subject')).toBe(0);
    expect(await row(none.id)).toBeDefined();
    expect(await row(other.id)).toBeDefined();
  });

  it('uses a resolved user id: a later handle rename does not orphan its label', async () => {
    const secret = await store(apps[0].id, 'user-label', 'hrn:user:subject4002-before');
    await db.user.update({ where: { id: subjectId }, data: { handle: 'subject4002-after' } });
    expect(await erase(apps[0].id, 'hrn:user:subject4002-after')).toBe(1);
    expect(await db.secret.findUnique({ where: { id: secret.id } })).toBeNull();
  });

  for (const arm of ['self', 'platform-admin'] as const) {
    it(`account deletion (${arm}) erases labelled rows across three foreign Apps/two orgs, preserving each unlabelled control`, async () => {
      const labelled = [], unlabelled = [];
      for (const app of apps) {
        labelled.push(await store(app.id, 'labelled', subjectId));
        unlabelled.push(await store(app.id, 'unlabelled'));
      }
      // The subject manages none of the Apps: this is the ungated internal system hook, not the manual arm.
      await deleteUserAccount(db, { targetUserId: subjectId,
        actorUserId: arm === 'self' ? subjectId : platformAdminId,
        ...(arm === 'platform-admin' ? { reason: 'Synthetic S7 acceptance' } : {}),
      });
      for (const s of labelled) expect(await db.secret.findUnique({ where: { id: s.id } })).toBeNull();
      for (const s of unlabelled) expect(await row(s.id)).toBeDefined();
      for (const app of apps) expect(await db.app.findUnique({ where: { id: app.id } })).not.toBeNull();
    });
  }

  it('the manual manager gate includes the live platform-admin arm', async () => {
    const secret = await store(apps[0].id, 'platform-arm', subjectId);
    expect(await erase(apps[0].id, subjectId, ctx(platformAdminId, ['ADMIN']))).toBe(1);
    expect(await db.secret.findUnique({ where: { id: secret.id } })).toBeNull();
  });
});
