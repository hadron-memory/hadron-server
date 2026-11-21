/** #3999; cor:sec:070:01. Protection forbids person self-read clients; workers remain distinct holders. */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { endGrant } from '../grants/manage.js';

/** Called under the secret row lock, before issue, activation or spend. */
export async function requireProtectedSecretHolder(tx: Prisma.TransactionClient, secretId: string, issuerId: string, personHolderId: string | null): Promise<void> {
 if (personHolderId !== issuerId) return;
 const secret = await tx.secret.findUnique({where:{id:secretId},select:{protected:true}});
 if (secret?.protected) throw new GraphQLError('A protected secret requires a different person to hold its read client.', {extensions:{code:'SECRET_PROTECTED_TWO_PERSON_REQUIRED'}});
}
/** Prelock grants in id order AFTER the secret, BEFORE request and credential locks. No issuer can add a client past the secret lock. */
export async function lockProtectionClients(tx: Prisma.TransactionClient, secretId: string): Promise<string[]> {
 const rows=await tx.$queryRaw<Array<{id:string}>>`SELECT g.id FROM grants g JOIN secret_read_clients c ON c.grant_id=g.id
 WHERE c.secret_id=${secretId} AND c.ended_at IS NULL AND g.user_id IS NOT NULL AND g.worker_id IS NULL
 AND (c.self_issued OR g.user_id=COALESCE(g.issuer_user_id,g.requested_by_user_id,c.issuer_user_id)) ORDER BY g.id FOR UPDATE OF g`;
 return rows.map(r=>r.id);
}
/** The protection transition and every affected grant/client end commit together. First grant ends stand; no client revives. */
export async function endProtectionClients(tx: Prisma.TransactionClient, secretId: string, grantIds: string[], userId: string): Promise<void> {
 for(const id of grantIds){
  const ended=await endGrant(tx,id,{userId,workerId:null,sessionId:null},{kind:'revoke',authorize:()=>undefined});
  if(!ended.changed) continue; // An earlier expiry, spend, revocation or departure remains the first end.
  await tx.$executeRaw`UPDATE secret_read_clients SET end_reason='PROTECTED',ended_at=(clock_timestamp() AT TIME ZONE 'UTC')
   WHERE grant_id=${id} AND secret_id=${secretId} AND ended_at IS NULL`;
 }
}
