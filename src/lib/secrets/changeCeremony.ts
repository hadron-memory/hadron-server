/** #3999; cor:sec:070:02. Separate proof and change assertions; the requester, browser and immutable request bind both. */
import { createHash, randomBytes } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { withAuthorizedTx } from '../../api/graphql/schema/authorizedTx.js';
import { createCeremony, verifyCeremonyAssertion, decideCeremonyAssertion, type CeremonyPurpose } from '../passkeys/ceremony.js';
import type { AssertionParts } from '../signing/verify.js';
import { passkeyRpId, signingCeremonyOrigins } from '../signing/config.js';
import { appAnchors, appManager, requireAppMember, loadLiveApp } from './access.js';
import { addAppSecretVersion, assertAppSecretRoom, lockSecretRow, recordSecretEvent } from './appSecrets.js';
import { decryptBytesAad } from '../tokenCrypto.js';
import { unwrapAppKey, stagedValueAad } from './appKeys.js';
import { changeSnapshot, type ChangeRequest } from './changeRequests.js';
import { signingSurfacePolicy } from '../signing/surface.js';
import { emitEntityUrnV2 } from '../urnEmit.js';
import { requirePersonOnlyAct } from '../auth/personAsThemselves.js';

export class SecretCeremonyRefused extends Error { constructor() { super('Secret ceremony refused.'); } }
const refuse = () => new SecretCeremonyRefused();
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest();
export const secretProofChallenge = (requestId: string, ceremonyId: string) => hash(`hadron-secret-change-proof:v1\n${requestId}\n${ceremonyId}\n`);
/** Immutable request identity, terms, operation and staged ciphertext digest are inside the approved challenge. */
export const secretChangeChallenge = (r: ChangeRequest) => hash(JSON.stringify(['hadron-secret-change:v1', r.id, r.requester_id,
 r.app_id,r.secret_id,r.secret_name,r.secret_kind,r.metadata,r.operation,r.snapshot,r.size_bytes,r.key_version,r.protected_result,r.write_version,
 r.staged_value_encrypted === null ? null : hash(r.staged_value_encrypted).toString('hex'),r.expires_at.toISOString()]));

async function request(db: Prisma.TransactionClient, id: string): Promise<ChangeRequest | null> {
 const [r] = await db.$queryRaw<ChangeRequest[]>`SELECT * FROM secret_change_requests WHERE id=${id}`;
 return r ?? null;
}
/** A generic proof challenge reveals nothing about whether the request exists. */
export async function openSecretProof(db: PrismaClient, a: { requestId: string; browserNonceHash: string }) {
 if (!signingSurfacePolicy().signing) throw refuse();
 const ceremonyId = randomBytes(32).toString('base64url'), challenge = secretProofChallenge(a.requestId, ceremonyId);
 await db.$executeRaw`INSERT INTO passkey_ceremonies (id,purpose,browser_nonce_hash,challenge_hash,expires_at)
 VALUES (${ceremonyId},'SECRET_CHANGE_PROOF',${a.browserNonceHash},${hash(challenge).toString('hex')},(clock_timestamp() AT TIME ZONE 'UTC')+interval '5 minutes')`;
 return { ceremonyId, challenge: challenge.toString('base64url') };
}
export interface SecretAssertion { requestId: string; ceremonyId: string; browserNonceHash: string; credentialId: Buffer; assertion: AssertionParts }
async function verify(db: PrismaClient, a: SecretAssertion, challenge: Buffer) {
 const c = await db.passkeyCredential.findUnique({ where: { credentialId: new Uint8Array(a.credentialId) } });
 if (!c || c.revokedAt || c.enrollmentRpId !== passkeyRpId()) throw refuse();
 try {
  return await verifyCeremonyAssertion({ assertion: a.assertion, credential: { passkeyId: c.id, ownerId: c.ownerId,
   credentialId: Buffer.from(c.credentialId), publicKey: Buffer.from(c.publicKey), counter: c.counter }, expectedChallenge: challenge,
   rpId: passkeyRpId(), origins: signingCeremonyOrigins() });
 } catch { throw refuse(); }
}
/** Refresh authority under the shared App/user anchors, then lock the secret before the request. */
async function authorized<T>(db: PrismaClient, r: ChangeRequest, userId: string, f: (tx: Prisma.TransactionClient, ctx: Context) => Promise<T>) {
 if (userId !== r.requester_id || !signingSurfacePolicy().signing) throw refuse();
 const user = await db.user.findUnique({ where: { id: userId }, select: { roles: true, deletedAt: true } });
 if (!user || user.deletedAt) throw refuse();
 const ctx = { db, userId, roles: user.roles } as Context;
 const app = await loadLiveApp(ctx, r.app_id); if (!app) throw refuse();
 return withAuthorizedTx(ctx, [...appAnchors(app), { kind: 'user', id: userId }], async (txCtx) => {
  await requirePersonOnlyAct(txCtx, 'secret.change', refuse);
  if (r.operation === 'CLEAR_PROTECTED' || r.protected_result === false) { if (!(await appManager(txCtx, r.app_id))) throw refuse(); }
  else await requireAppMember(txCtx, r.app_id);
  if (r.operation === 'STORE') await requireAppMember(txCtx, r.app_id);
 }, async (tx, txCtx) => {
  // Ordinary creates use this count lock too; protected creates never race through a free name.
  if (!r.secret_id) await assertAppSecretRoom(tx, r.app_id);
  else if (!(await lockSecretRow(tx, r.secret_id))) throw refuse();
  return f(tx, txCtx);
 });
}
/** Prove the requester's own passkey before returning any request metadata; rotate nonce for the completion ceremony. */
export async function proveSecretChange(db: PrismaClient, a: SecretAssertion) {
 const verified = await verify(db, a, secretProofChallenge(a.requestId,a.ceremonyId));
 const r = await request(db, a.requestId); if (!r) throw refuse();
 return authorized(db,r,verified.snapshot.ownerId,async (tx) => {
  const proof = await decideCeremonyAssertion(tx,{ ceremonyId:a.ceremonyId,browserNonceHash:a.browserNonceHash,purpose:'SECRET_CHANGE_PROOF',verified:verified.snapshot });
  if (!proof || proof.ownerId !== r.requester_id) throw refuse();
  // A new successful proof retires this browser's earlier completion proof before returning any state.
  await tx.$executeRaw`UPDATE passkey_ceremonies SET consumed_at=(clock_timestamp() AT TIME ZONE 'UTC')
   WHERE purpose='SECRET_CHANGE' AND browser_nonce_hash=${a.browserNonceHash} AND consumed_at IS NULL`;
  const current = await request(tx,r.id); if (!current) throw refuse();
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT hadron_signing_now() AS now`;
  if (current.state !== 'open' || current.expires_at <= now) return { outcome:'ended' as const,state:current.expires_at <= now && current.state==='open'?'expired':current.state };
  const nonce = randomBytes(32).toString('base64url'), challenge=secretChangeChallenge(current);
  const ceremony=await createCeremony(tx,{purpose:'SECRET_CHANGE',browserNonceHash:hash(nonce).toString('hex'),ttlSeconds:600,challengeHash:hash(challenge).toString('hex')});
  const app=await tx.app.findUniqueOrThrow({where:{id:r.app_id}});
  const appUrn = emitEntityUrnV2('app', app.urn);
  // The pinned urn-lib version has only the former org/user secret arity; the App owner marker is cor:urn:010:01.
  const secretUrn = appUrn.replace(/^hrn:app:([^:]+):(.+)$/, 'hrn:secret:$1:app:$2') + ':' + current.secret_name;
  // The proof exposes metadata only; neither ciphertext nor plaintext leaves the server.
  return { outcome:'change' as const,nonce,ceremonyId:ceremony.id,challenge:challenge.toString('base64url'),rpId:passkeyRpId(),
   summary:{app:appUrn,secret:secretUrn,operation:current.operation,change:current.operation==='STORE'?(current.secret_id?'Store a new version':'Create a protected secret'):({DELETE:'Delete this secret',SET_PROTECTED:'Turn protection on',CLEAR_PROTECTED:'Turn protection off'} as const)[current.operation],sizeBytes:current.size_bytes,requester:current.requester_id,expiresAt:current.expires_at.toISOString()} };
 });
}
/** Completion rejudges standing, deadlines, snapshot and credential under locks. Only its committed result leaves the server. */
export async function completeSecretChange(db: PrismaClient,a:SecretAssertion):Promise<void> {
 const located=await request(db,a.requestId);if(!located)throw refuse();
 const verified=await verify(db,a,secretChangeChallenge(located));
 const result=await authorized(db,located,verified.snapshot.ownerId,async(tx,ctx)=>{
  const [r]=await tx.$queryRaw<ChangeRequest[]>`SELECT * FROM secret_change_requests WHERE id=${located.id} FOR UPDATE`;
  if(!r || r.requester_id!==verified.snapshot.ownerId)throw refuse();
  // Lock the credential before the decision clock, so waiting cannot preserve an expired cooling-off or request judgment.
  const [cred]=await tx.$queryRaw<Array<{window_ends_at:Date|null;window_outcome:string|null}>>`SELECT window_ends_at,window_outcome FROM passkey_credentials WHERE id=${verified.snapshot.passkeyId} FOR UPDATE`;
  const [{now}]=await tx.$queryRaw<Array<{now:Date}>>`SELECT hadron_signing_now() AS now`;
  if(r.state!=='open')throw refuse();
  const end=async(state:string,code:string)=>{
   await tx.$executeRaw`UPDATE secret_change_requests SET state=${state},ended_at=(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${r.id}`;
   return new GraphQLError('This secret change is no longer available.',{extensions:{code}});
  };
  if(r.expires_at<=now)return end('expired','SECRET_CHANGE_REQUEST_EXPIRED');
  let secret=r.secret_id?await tx.secret.findUnique({where:{id:r.secret_id}}):null;
  const newest=secret?await tx.secretVersion.findFirst({where:{secretId:secret.id},orderBy:{versionNo:'desc'},select:{versionNo:true}}):null;
  if(r.secret_id ? !secret || changeSnapshot(secret,newest?.versionNo??0)!==r.snapshot :
   await tx.secret.findUnique({where:{ownerType_ownerId_name:{ownerType:'app',ownerId:r.app_id,name:r.secret_name}}})) return end('stale','SECRET_CHANGE_REQUEST_STALE');
  if(!cred || (cred.window_outcome===null && cred.window_ends_at!==null && cred.window_ends_at>now))throw new GraphQLError('This passkey is still in its cooling-off period.',{extensions:{code:'PASSKEY_COOLING_OFF'}});
  const decided=await decideCeremonyAssertion(tx,{ceremonyId:a.ceremonyId,browserNonceHash:a.browserNonceHash,purpose:'SECRET_CHANGE',verified:verified.snapshot});
  if(!decided || decided.ownerId!==r.requester_id)throw refuse();
  const actor={userId:r.requester_id,workerId:null,sessionId:null};
  if(r.operation==='DELETE'){
   if(!secret)throw refuse();
   if (secret.createdBy !== ctx.userId && !(await appManager(ctx, r.app_id))) throw refuse();
   await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:'DELETE',actor});
   // Mark completion before deletion; keep the terminal request for requester polling, with no staged value.
   await tx.$executeRaw`UPDATE secret_change_requests SET state='completed',ended_at=(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${r.id}`;
   await tx.secret.delete({where:{id:secret.id}});return null;
  }
  if(r.operation==='STORE'){
   const wasProtected = secret?.protected;
   if(!r.staged_value_encrypted || r.key_version===null || r.size_bytes===null)throw refuse();
   const key=await unwrapAppKey(tx,r.app_id,r.key_version);
   const plaintext=decryptBytesAad(r.staged_value_encrypted,stagedValueAad(r.id),key.encryptionKey);
   try{
    if(!secret)secret=await tx.secret.create({data:{ownerType:'app',ownerId:r.app_id,name:r.secret_name,kind:r.secret_kind,metadata:r.metadata as Prisma.InputJsonValue,valueEncrypted:null,protected:true,createdBy:r.requester_id}});
    const versionNo=r.write_version?await addAppSecretVersion(tx,secret,plaintext.toString('utf8'),r.size_bytes,actor):newest?.versionNo??null;
    await tx.secret.update({where:{id:secret.id},data:{metadata:r.metadata as Prisma.InputJsonValue,updatedBy:r.requester_id,...(r.protected_result===null?{}:{protected:r.protected_result})}});
    await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:!r.write_version?'METADATA':newest?'VERSION':'STORE',versionNo,actor});
    if (wasProtected !== undefined && r.protected_result !== null && r.protected_result !== wasProtected) {
     await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:r.protected_result?'PROTECT':'UNPROTECT',actor});
    }
   }finally{plaintext.fill(0);}
  }else{
   if(!secret)throw refuse();
   await tx.secret.update({where:{id:secret.id},data:{protected:r.operation==='SET_PROTECTED',updatedBy:r.requester_id}});
   await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:r.operation==='SET_PROTECTED'?'PROTECT':'UNPROTECT',actor});
  }
  // S3 fold: BOTH SET_PROTECTED and STORE with protected_result=true must end person-self-issued clients atomically.
  // Acquire affected grant/lifecycle locks in S3's canonical order BEFORE request/credential locks above, not at this late marker.
  // This draft must not freeze until those locks, the transition and activation/read guards fold in after S3 merges.
  await tx.$executeRaw`UPDATE secret_change_requests SET state='completed',ended_at=(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${r.id}`;
  return null;
 });
 if(result instanceof GraphQLError)throw result;
}
