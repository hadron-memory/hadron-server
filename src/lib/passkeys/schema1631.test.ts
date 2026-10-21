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
        (id, owner_id, credential_id, public_key, algorithm, user_handle, enrollment_rp_id, label, registered_at, counter, transports, backup_eligible, backed_up, registration_method, window_ends_at)
        VALUES (${id}, ${ownerId}, ${Buffer.from('synthetic-credential')}, ${Buffer.from('synthetic-public-key')}, -7,
          ${Buffer.alloc(32,1)}, 'example.test', 'Synthetic', (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3), 0, ARRAY['internal'], false, false, ${first?'github':null}, CASE WHEN ${first} THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) + interval '72 hours' ELSE NULL END)`;
      await run(tx,id);
      throw new RollbackFixture();
    });
  } catch(error) {if (!(error instanceof RollbackFixture)) throw error;}
}
async function refused(tx: Prisma.TransactionClient, operation: () => Promise<unknown>, state = '23514') {
  await tx.$executeRawUnsafe('SAVEPOINT refused_write');
  try {await expect(operation()).rejects.toMatchObject({code:'P2010',meta:{code:state}});}
  finally {await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT refused_write');}
}

describe('passkey credential schema (#1631)', () => {
  it('keeps a public credential and supports normal use and one revocation', async () => fixture(async (tx,id) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET counter=1, last_used_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3), backed_up=false WHERE id=${id}`;
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${id}`;
    const [row] = await tx.$queryRaw<Array<{counter:bigint; revoked_at:Date}>>`SELECT counter,revoked_at FROM passkey_credentials WHERE id=${id}`;
    expect(row.counter).toBe(1n); expect(row.revoked_at).toBeInstanceOf(Date);
  }));
  it('never changes identity or public-key material and never deletes', async () => fixture(async (tx,id) => {
    for (const column of ['id','owner_id','credential_id','public_key','algorithm','user_handle','enrollment_rp_id','registered_at','backup_eligible','registration_method','window_ends_at']) {
      const value = column==='enrollment_rp_id'?"'renamed.example'":column==='id'?`'${generateId()}'`:column==='backup_eligible'?'true':column==='registration_method'?"'google'":column==='window_ends_at'?"registered_at + interval '96 hours'":column==='owner_id'?`'${otherOwnerId}'`:column==='algorithm'?' -257':column==='registered_at'?"registered_at - interval '1 second'":column==='user_handle'?`decode('${'02'.repeat(32)}','hex')`:"decode('0203','hex')";
      await refused(tx,()=>tx.$executeRawUnsafe(`UPDATE passkey_credentials SET ${column}=${value} WHERE id=$1`,id));
    }
    await refused(tx,()=>tx.$executeRaw`DELETE FROM passkey_credentials WHERE id=${id}`);
  },true));
  it('revocation is set once, never changed or cleared', async () => fixture(async (tx,id) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=NULL WHERE id=${id}`);
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=revoked_at + interval '1 second' WHERE id=${id}`);
  }));
  it('uses a deployment-unique credential id and retains the owning user', async () => fixture(async (tx,id) => {
    await refused(tx,()=>tx.$executeRaw`INSERT INTO passkey_credentials (id,owner_id,credential_id,public_key,algorithm,user_handle,enrollment_rp_id,label,registered_at,counter,transports,backup_eligible,backed_up) SELECT ${generateId()},${otherOwnerId},credential_id,public_key,algorithm,user_handle,enrollment_rp_id,label,registered_at,counter,transports,backup_eligible,backed_up FROM passkey_credentials WHERE id=${id}`,'23505');
    await refused(tx,()=>tx.$executeRaw`DELETE FROM users WHERE id=${ownerId}`,'23503');
  }));
  it('requires an enrollment RP ID: it is recorded at enrollment, never inferred later (#1631 PR1b, Eden #10470)', async () => fixture(async (tx) => {
    await refused(tx,()=>tx.$executeRaw`INSERT INTO passkey_credentials (id,owner_id,credential_id,public_key,algorithm,user_handle,label)
      VALUES (${generateId()},${ownerId},decode('aabb','hex'),decode('0102','hex'),-7,${Buffer.alloc(32,6)},'no rp')`,'23502');
  }));
  it('the migration and both schema-push paths carry the same guard', () => {
    const guard = readFileSync('prisma/passkey-invariants.sql','utf8');
    // The newest migration that touches the guard carries it verbatim (#1631 PR1b re-applies it).
    expect(readFileSync('prisma/migrations/20261021110000_passkey_erasure/migration.sql','utf8').endsWith(guard)).toBe(true);
    expect(readFileSync('prisma/post-push.sql','utf8')).toContain('\\ir passkey-invariants.sql');
    expect(readFileSync('src/test/globalSetup.ts','utf8')).toContain('../../prisma/passkey-invariants.sql');
  });
  it('a first window closes once and requires a complete outcome', async () => fixture(async (tx,id) => {
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET window_outcome='ended-early' WHERE id=${id}`);
    await tx.$executeRaw`UPDATE passkey_credentials SET window_outcome='ended-early',window_ended_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET window_outcome='ran-out',window_ended_at=window_ends_at WHERE id=${id}`);
    // Revocation after a legitimate early end does not turn that outcome into cancellation.
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${id}`;
  },true));
  it('revocation during a first window cancels it and retains cancel-link provenance', async () => fixture(async (tx,id) => {
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${id}`);
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),
      window_outcome='cancelled',window_ended_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),
      cancelled_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),cancel_ip='127.0.0.1',cancel_user_agent='synthetic-test' WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET cancel_ip='different' WHERE id=${id}`);
  },true));
  it('the counter supports all unsigned 32 bits but cannot move backwards', async () => fixture(async (tx,id) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET counter=4294967295 WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET counter=4294967296 WHERE id=${id}`);
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET counter=0 WHERE id=${id}`);
  }));

  it('refuses a forward-dated revocation', async () => fixture(async (tx,id) => {
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=window_ends_at WHERE id=${id}`);
  },true));
  it('refuses a backdated revocation after registration but before a recorded use', async () => {
    const row = await db.passkeyCredential.create({data:{ownerId,credentialId:Buffer.from('clock-probe'),
      publicKey:Buffer.from('synthetic'),algorithm:-7,userHandle:Buffer.alloc(32,3),enrollmentRpId:'example.test',label:'clock'}});
    await new Promise(resolve=>setTimeout(resolve,20));
    await db.$executeRaw`UPDATE passkey_credentials SET last_used_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${row.id}`;
    const used = await db.passkeyCredential.findUniqueOrThrow({where:{id:row.id}});
    const forged = new Date(row.registeredAt.getTime()+1);
    expect(forged.getTime()).toBeLessThan(used.lastUsedAt!.getTime());
    await db.$transaction(async tx=>refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=${forged} WHERE id=${row.id}`));
  });
  it('refuses counter and timestamp changes after revocation', async () => fixture(async (tx,id) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),window_ended_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),window_outcome='cancelled' WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET counter=1 WHERE id=${id}`);
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET last_used_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${id}`);

  },true));

  it('the platform clock forbids an insert born with its first window already over', async () => fixture(async (tx,id) => {
    await refused(tx,()=>tx.$executeRaw`INSERT INTO passkey_credentials
      (id,owner_id,credential_id,public_key,algorithm,user_handle,enrollment_rp_id,label,registered_at,counter,transports,backup_eligible,backed_up,registration_method,window_ends_at)
      SELECT ${generateId()},owner_id,decode('aabb','hex'),public_key,algorithm,user_handle,enrollment_rp_id,label,
        registered_at - interval '4 days',counter,transports,backup_eligible,backed_up,'github',registered_at - interval '1 day'
      FROM passkey_credentials WHERE id=${id}`);
  }));
  it('insert shape checks reject malformed public credential records with SQLSTATE 23514', async () => fixture(async (tx) => {
    const base: Record<string,string> = {id: "'shape-test'",owner_id:`'${ownerId}'`,credential_id:"decode('aabb','hex')",
      public_key:"decode('0102','hex')",algorithm:'-7',user_handle:`decode('${'01'.repeat(32)}','hex')`,enrollment_rp_id:"'example.test'",label:"'shape'",
      registered_at:"(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)",counter:'0',transports:"ARRAY['internal']",
      backup_eligible:'false',backed_up:'false',registration_method:'NULL',window_ends_at:'NULL',window_outcome:'NULL',window_ended_at:'NULL'};
    for (const override of [
      {credential_id:"decode('','hex')"}, {credential_id:`decode('${'01'.repeat(1024)}','hex')`},
      {public_key:"decode('','hex')"}, {user_handle:"decode('0102','hex')"}, {algorithm:'-8'},
      {counter:'-1'}, {counter:'4294967296'}, {backed_up:'true'}, {transports:'NULL'},
      {registration_method:"'github'",window_ends_at:"(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + interval '71 hours'"},
      {window_outcome:"'unknown'"}, {window_ended_at:"(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)"},
      // #1631 PR1b: an RP ID is a bare lowercase host, never a URL, a port or empty.
      {enrollment_rp_id:"''"}, {enrollment_rp_id:"'Example.test'"}, {enrollment_rp_id:"'https://example.test'"},
      {enrollment_rp_id:"'example.test:443'"}, {enrollment_rp_id:"'example.test.'"}, {enrollment_rp_id:"'.example.test'"},
      {enrollment_rp_id:"'ex ample.test'"}, {enrollment_rp_id:`'${'a'.repeat(254)}'`},
    ]) {
      const values = {...base,...override};
      await refused(tx,()=>tx.$executeRawUnsafe(`INSERT INTO passkey_credentials (${Object.keys(values).join(',')}) VALUES (${Object.values(values).join(',')})`));
    }
  }));
  it('uses UTC clock comparisons even in a non-UTC database session', async () => fixture(async (tx,id) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Los_Angeles'");
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) WHERE id=${id}`;
  }));

  it('cannot attach cancel-link provenance after a different revocation', async () => fixture(async (tx,id) => {
    await tx.$executeRaw`UPDATE passkey_credentials SET revoked_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),
      window_ended_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3),window_outcome='cancelled' WHERE id=${id}`;
    await refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials SET cancelled_at=revoked_at,cancel_ip='127.0.0.1',cancel_user_agent='late' WHERE id=${id}`);
  },true));
  it('the registration default is the UTC database clock in a non-UTC session', async () => fixture(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/Los_Angeles'");
    const id = generateId();
    await tx.$executeRaw`INSERT INTO passkey_credentials (id,owner_id,credential_id,public_key,algorithm,user_handle,enrollment_rp_id,label)
      VALUES (${id},${ownerId},decode('aabb','hex'),decode('0102','hex'),-7,${Buffer.alloc(32,4)},'example.test','UTC default')`;
    const [row] = await tx.$queryRaw<Array<{same:boolean}>>`SELECT registered_at=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AS same FROM passkey_credentials WHERE id=${id}`;
    expect(row.same).toBe(true);
  }));

  it('inserts only unused, unrevoked credentials with an open first window', async () => fixture(async (tx,id) => {
    for (const extra of [
      "window_outcome,window_ended_at", "revoked_at,window_outcome,window_ended_at",
      "last_used_at", "counter",
    ]) {
      const now = "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)";
      const values = extra==='window_outcome,window_ended_at'?`'ended-early',${now}`:
        extra==='revoked_at,window_outcome,window_ended_at'?`${now},'cancelled',${now}`:extra==='counter'?'1':now;
      await refused(tx,()=>tx.$executeRawUnsafe(`INSERT INTO passkey_credentials
        (id,owner_id,credential_id,public_key,algorithm,user_handle,enrollment_rp_id,label,registration_method,window_ends_at,${extra})
        SELECT $1,owner_id,decode('aabb','hex'),public_key,algorithm,user_handle,enrollment_rp_id,label,'github',registered_at+interval '72 hours',${values}
        FROM passkey_credentials WHERE id=$2`,generateId(),id));
    }
    await refused(tx,()=>tx.$executeRaw`INSERT INTO passkey_credentials
      (id,owner_id,credential_id,public_key,algorithm,user_handle,enrollment_rp_id,label,registration_method,window_ends_at,
       revoked_at,window_outcome,window_ended_at,cancelled_at,cancel_ip,cancel_user_agent)
      SELECT ${generateId()},owner_id,decode('aabb','hex'),public_key,algorithm,user_handle,enrollment_rp_id,label,'github',registered_at+interval '72 hours',
       registered_at,'cancelled',registered_at,registered_at,'127.0.0.1','born-cancelled' FROM passkey_credentials WHERE id=${id}`);
  }));
  it('refuses a backdated early closure in a later transaction', async () => {
    const row = await db.$transaction(async tx => {
      const id = generateId();
      await tx.$executeRaw`INSERT INTO passkey_credentials
        (id,owner_id,credential_id,public_key,algorithm,user_handle,enrollment_rp_id,label,registration_method,window_ends_at)
        VALUES (${id},${ownerId},decode('aabb','hex'),decode('0102','hex'),-7,${Buffer.alloc(32,5)},'example.test','closure','github',
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3)+interval '72 hours')`;
      return tx.passkeyCredential.findUniqueOrThrow({where:{id}});
    });
    await new Promise(resolve=>setTimeout(resolve,20));
    await db.$transaction(async tx=>refused(tx,()=>tx.$executeRaw`UPDATE passkey_credentials
      SET window_outcome='ended-early',window_ended_at=${row.registeredAt} WHERE id=${row.id}`));
  });

});
