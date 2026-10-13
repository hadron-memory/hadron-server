import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';

class RollbackFixture extends Error {}
let ownerId: string;
let otherOwnerId: string;
beforeEach(async () => {
  await cleanDb(db);
  otherOwnerId = (await db.user.create({data:{githubId:1631002,githubUsername:'passkey-other',roles:[]}})).id;
  ownerId = (await db.user.create({data:{githubId:1631001,githubUsername:'passkey-schema',roles:[]}})).id;
});
async function fixture(run: (tx: Prisma.TransactionClient, id: string) => Promise<void>, first = false) {
  try {
    await db.$transaction(async tx => {
      const id = generateId();
      await tx.$executeRaw`INSERT INTO passkey_credentials
        (id, owner_id, credential_id, public_key, algorithm, user_handle, label, registered_at, counter, transports, backup_eligible, backed_up, registration_method, window_ends_at)
        VALUES (${id}, ${ownerId}, ${Buffer.from('synthetic-credential')}, ${Buffer.from('synthetic-public-key')}, -7,
          ${Buffer.alloc(32,1)}, 'Synthetic', CURRENT_TIMESTAMP, 0, ARRAY['internal'], false, false, ${first?'github':null}, CASE WHEN ${first} THEN CURRENT_TIMESTAMP + interval '72 hours' ELSE NULL END)`;
      await run(tx,id);
      throw new RollbackFixture();
    });
  } catch(error) {if (!(error instanceof RollbackFixture)) throw error;}
}
async function refused(tx: Prisma.TransactionClient, operation: () => Promise<unknown>) {
  await tx.$executeRawUnsafe('SAVEPOINT refused_write');
  try {await expect(operation()).rejects.toThrow();}
  finally {await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refused_write');}
}

describe('passkey credential schema (#1631)', () => {
  it('keeps a public credential and supports normal use and one revocation', async () => fixture(async (tx,id) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET counter=1, last_used_at=CURRENT_TIMESTAMP, backed_up=false WHERE id=${id}`;
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    const [row] = await tx.$queryRaw<Array<{counter:bigint; revoked_at:Date}>>`SELECT counter,revoked_at FROM passkey_credentials WHERE id=${id}`;
    expect(row.counter).toBe(1n); expect(row.revoked_at).toBeInstanceOf(Date);
  }));
  it('never changes identity or public-key material and never deletes', async () => fixture(async (tx,id) => {
    for (const column of ['owner_id','credential_id','public_key','algorithm','user_handle','registered_at']) {
      const value = column==='owner_id'?`'${otherOwnerId}'`:column==='algorithm'?' -257':column==='registered_at'?"registered_at + interval '1 second'":column==='user_handle'?`decode('${'02'.repeat(32)}','hex')`:"decode('0203','hex')";
      await refused(tx,()=>tx.$executeRawUnsafe(`UPDATE passkey_credentials SET ${column}=${value} WHERE id=$1`,id));
    }
    await refused(tx,()=>tx.$executeRaw`DELETE FROM passkey_credentials WHERE id=${id}`);
  }));
  it('revocation is set once, never changed or cleared', async () => fixture(async (tx,id) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=CURRENT_TIMESTAMP WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=NULL WHERE id=${id}`);
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=revoked_at + interval '1 second' WHERE id=${id}`);
  }));
  it('uses a deployment-unique credential id and retains the owning user', async () => fixture(async (tx,id) => {
    await refused(tx,()=>tx.$executeRaw`INSERT INTO passkey_credentials (id,owner_id,credential_id,public_key,algorithm,user_handle,label,registered_at,counter,transports,backup_eligible,backed_up) SELECT ${generateId()},${otherOwnerId},credential_id,public_key,algorithm,user_handle,label,registered_at,counter,transports,backup_eligible,backed_up FROM passkey_credentials WHERE id=${id}`);
    await refused(tx,()=>tx.user.delete({where:{id:ownerId}}));
  }));
  it('the migration and both schema-push paths carry the same guard', () => {
    const guard = readFileSync('prisma/passkey-invariants.sql','utf8');
    expect(readFileSync('prisma/migrations/20261013120000_passkey_credentials/migration.sql','utf8').endsWith(guard)).toBe(true);
    expect(readFileSync('prisma/post-push.sql','utf8')).toContain('\\ir passkey-invariants.sql');
    expect(readFileSync('src/test/globalSetup.ts','utf8')).toContain('../../prisma/passkey-invariants.sql');
  });
  it('a first window closes once and requires a complete outcome', async () => fixture(async (tx,id) => {
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET window_outcome='ended-early' WHERE id=${id}`);
    await tx.$executeRaw`UPDATE passkey_credentials SET window_outcome='ended-early',window_ended_at=registered_at + interval '1 hour' WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET window_outcome='ran-out',window_ended_at=window_ends_at WHERE id=${id}`);
    // Revocation after a legitimate early end does not turn that outcome into cancellation.
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=registered_at + interval '2 hours' WHERE id=${id}`;
  },true));
  it('revocation during a first window cancels it and retains cancel-link provenance', async () => fixture(async (tx,id) => {
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=registered_at + interval '1 hour' WHERE id=${id}`);
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=registered_at + interval '1 hour',
      window_outcome='cancelled',window_ended_at=registered_at + interval '1 hour',
      cancelled_at=registered_at + interval '1 hour',cancel_ip='127.0.0.1',cancel_user_agent='synthetic-test' WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET cancel_ip='different' WHERE id=${id}`);
  },true));
  it('the counter supports all unsigned 32 bits but cannot move backwards', async () => fixture(async (tx,id) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET counter=4294967295 WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET counter=4294967296 WHERE id=${id}`);
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET counter=0 WHERE id=${id}`);
  }));

});
