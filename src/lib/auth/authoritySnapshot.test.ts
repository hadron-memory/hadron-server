import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { Prisma } from '../../generated/prisma/index.js';
import { lockAuthorityAnchors } from './authorityAnchors.js';

describe('SERIALIZABLE authority snapshot after an advisory wait', () => {
  async function probe(lockingRead: boolean) {
    await cleanDb(db);
    const org = await db.organization.create({ data: { id: generateId(), name: 'snapshot', urn: `snap-${Date.now()}.com` } });
    const user = await db.user.create({ data: { id: generateId(), githubId: 919191, githubUsername: `snap-${Date.now()}` } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });

    let held!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const revoker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: org.id }], 'exclusive');
      await tx.orgMember.update({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
        data: { deletedAt: new Date() },
      });
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;
    const writer = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: org.id }], 'shared');
      if (lockingRead) {
        return tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM org_members
          WHERE organization_id = ${org.id} AND user_id = ${user.id}
            AND deleted_at IS NULL FOR SHARE`;
      }
      return tx.orgMember.findFirst({ where: { organizationId: org.id, userId: user.id, deletedAt: null } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 2_000);
    } finally {
      release();
    }
    await revoker;
    return writer;
  }

  it('a plain gate sees stale authority after the wait (negative control)', async () => {
    expect(await probe(false)).not.toBeNull();
  });

  it('a locking gate fails rather than authorize from that stale snapshot', async () => {
    await expect(probe(true)).rejects.toThrow(/serialize|40001/i);
  });
});
