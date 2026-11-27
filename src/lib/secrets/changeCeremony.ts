import { deleteLockedAppSecret } from './autoDelete.js';
import { lockProtectionClients, endProtectionClients } from './protection.js';
/** #3999; cor:sec:070:02. Separate proof and change assertions; the requester, browser and immutable request bind both. */
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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

/**
 * #4703: the decline challenge. A separate string from the approve challenge, so an assertion made to approve can never end the
 * request and a decline assertion can never approve it. It binds the request's identity, requester and deadline.
 */
export const secretDeclineChallenge = (r: ChangeRequest) => hash(JSON.stringify(['hadron-secret-change-decline:v1', r.id, r.requester_id,
 r.app_id, r.secret_name, r.operation, r.snapshot, r.expires_at.toISOString()]));

/** Is this staged STORE a protection-flag-only change (#4626 item 17): an existing secret, no staged value, a protection change, metadata equal to the live row's. */
async function isProtectionFlagOnly(tx: Prisma.TransactionClient, r: ChangeRequest): Promise<boolean> {
 if (r.operation !== 'STORE' || r.secret_id === null || r.write_version || r.protected_result === null) return false;
 const live = await tx.secret.findUnique({ where: { id: r.secret_id }, select: { metadata: true } });
 return live !== null && isDeepStrictEqual(r.metadata, live.metadata);
}

/** The one line the proof page shows for a staged change. One case per branch; the bytes are the ceremony's contract (#4626 item 17, #5299 item 2). */
function changeText(r: Pick<ChangeRequest, 'operation' | 'secret_id' | 'write_version' | 'protected_result'>, flagOnly: boolean): string {
 if (r.operation !== 'STORE') return ({ DELETE: 'Delete this secret', SET_PROTECTED: 'Turn protection on', CLEAR_PROTECTED: 'Turn protection off',
  SET_DELETE_AFTER_USE: 'Allow deletion after use', CLEAR_DELETE_AFTER_USE: 'Stop deletion after use' } as const)[r.operation];
 const protection = r.protected_result === null ? '' : r.protected_result ? ' and turn protection on' : ' and turn protection off';
 if (r.secret_id === null) return 'Create a protected secret' + protection;
 if (r.write_version) return 'Store a new version' + protection;
 if (flagOnly) return r.protected_result ? 'Turn protection on' : 'Turn protection off';
 return 'Update secret metadata' + protection;
}


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
  // #4703: the requester may end their own request instead; its own ceremony, bound to the decline challenge.
  const declineChallenge=secretDeclineChallenge(current);
  const declineCeremony=await createCeremony(tx,{purpose:'SECRET_CHANGE',browserNonceHash:hash(nonce).toString('hex'),ttlSeconds:600,challengeHash:hash(declineChallenge).toString('hex')});
  const app=await tx.app.findUniqueOrThrow({where:{id:r.app_id}});
  const appUrn = emitEntityUrnV2('app', app.urn);
  // The pinned urn-lib version has only the former org/user secret arity; the App owner marker is
  // hrn:node:hadronmemory.com:specs:cor:urn:010:01.
  const secretUrn = appUrn.replace(/^hrn:app:([^:]+):(.+)$/, 'hrn:secret:$1:app:$2') + ':' + current.secret_name;
  // #4626 item 17: a STORE that stages neither a value nor a metadata change is a protection-flag-only change. Its text
  // names the flag alone and its summary carries no metadata, so the page never claims a metadata change. The live row is
  // read under the secret lock `authorized` already took, so the comparison cannot race a concurrent edit. #5299 item 2: it is
  // read only where the answer can matter (an existing secret, no staged value, a protection change); the text itself is
  // `changeText`, one case per line, pinned byte for byte by proofText5299.test.ts.
  const flagOnly = await isProtectionFlagOnly(tx, current);
  const change = changeText(current, flagOnly);
  return { outcome:'change' as const,nonce,ceremonyId:ceremony.id,challenge:challenge.toString('base64url'),rpId:passkeyRpId(),decline:{ceremonyId:declineCeremony.id,challenge:declineChallenge.toString('base64url')},
   summary:{app:appUrn,secret:secretUrn,operation:current.operation,change,...(current.operation==='STORE'&&!flagOnly?{metadata:current.metadata}:{}),sizeBytes:current.size_bytes,requester:current.requester_id,expiresAt:current.expires_at.toISOString()} };
 });
}
/** Completion rejudges standing, deadlines, snapshot and credential under locks. Only its committed result leaves the server. */
export async function completeSecretChange(db: PrismaClient,a:SecretAssertion):Promise<void> {
 const located=await request(db,a.requestId);if(!located)throw refuse();
 const verified=await verify(db,a,secretChangeChallenge(located));
 const result=await authorized(db,located,verified.snapshot.ownerId,async(tx,ctx)=>{
  const protectionGrants=located.secret_id ? await lockProtectionClients(tx,located.secret_id) : [];
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
   // Mark completion before deletion; keep the terminal request for requester polling, with no staged value.
   await tx.$executeRaw`UPDATE secret_change_requests SET state='completed',ended_at=(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${r.id}`;
   await deleteLockedAppSecret(tx,secret,actor);return null;
  }
  if(r.operation==='SET_DELETE_AFTER_USE'||r.operation==='CLEAR_DELETE_AFTER_USE'){
   // #5335 (cor:sec:060:03): setting the option consents to the secret's deletion, so it needs the deletion authority (its creator,
   // still a member, or whoever manages the App), judged again here as DELETE is. Clearing it only withdraws that consent: any member.
   if(!secret)throw refuse();
   const on=r.operation==='SET_DELETE_AFTER_USE';
   if(on && secret.createdBy!==ctx.userId && !(await appManager(ctx,r.app_id)))throw refuse();
   await tx.secret.update({where:{id:secret.id},data:{deleteAfterUse:on,updatedBy:r.requester_id}});
   await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:on?'DELETE_AFTER_USE_ON':'DELETE_AFTER_USE_OFF',actor});
  }else if(r.operation==='STORE'){
   // #4717 items 1-2 (cor:sec:010:05): a create starts unprotected in the trail and ends protected, so it records PROTECT;
   // a protection change that leaves the metadata as it was records only the protection event, never a METADATA event.
   const before = secret ? { protected: secret.protected, metadata: secret.metadata } : null;
   let plaintext: Buffer | null = null;
   if(r.write_version){
    if(!r.staged_value_encrypted || r.key_version===null || r.size_bytes===null)throw refuse();
    const key=await unwrapAppKey(tx,r.app_id,r.key_version);
    plaintext=decryptBytesAad(r.staged_value_encrypted,stagedValueAad(r.id),key.encryptionKey);
   }else if(!secret)throw refuse();
   try{
    if(!secret)secret=await tx.secret.create({data:{ownerType:'app',ownerId:r.app_id,name:r.secret_name,kind:r.secret_kind,metadata:r.metadata as Prisma.InputJsonValue,valueEncrypted:null,protected:true,createdBy:r.requester_id}});
    const versionNo=r.write_version?await addAppSecretVersion(tx,secret,plaintext!.toString('utf8'),r.size_bytes!,actor):newest?.versionNo??null;
    await tx.secret.update({where:{id:secret.id},data:{metadata:r.metadata as Prisma.InputJsonValue,updatedBy:r.requester_id,...(r.protected_result===null?{}:{protected:r.protected_result})}});
    // before === null only for a protected create (the sole STORE staged with secret_id null), whose row is born protected.
    const protectedAfter = r.protected_result ?? before?.protected ?? true;
    const protectionChanged = (before?.protected ?? false) !== protectedAfter;
    const protectionOnly = !r.write_version && protectionChanged && before !== null && isDeepStrictEqual(r.metadata, before.metadata);
    if (!protectionOnly) await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:!r.write_version?'METADATA':newest?'VERSION':'STORE',versionNo,actor});
    if (protectionChanged) await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:protectedAfter?'PROTECT':'UNPROTECT',actor});
   }finally{
    // The wipe clears the decrypted Buffer only. The UTF-8 string `toString('utf8')` makes inside addAppSecretVersion is
    // an immutable JS string and cannot be zeroed; the staged ciphertext (cleared by the request's own trigger) and
    // this Buffer are the copies we can reach. #4626 item 4 records the limit rather than pretending to more.
    plaintext?.fill(0);}
  }else{
   if(!secret)throw refuse();
   await tx.secret.update({where:{id:secret.id},data:{protected:r.operation==='SET_PROTECTED',updatedBy:r.requester_id}});
   await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:r.operation==='SET_PROTECTED'?'PROTECT':'UNPROTECT',actor});
  }
  if(secret && (r.operation==='SET_PROTECTED' || (r.operation==='STORE' && r.protected_result===true))) {
   await endProtectionClients(tx,secret.id,protectionGrants,r.requester_id);
   // #5335 (cor:sec:060:03): an option set while the secret was unprotected was any member's plain write. Turning protection on
   // clears it, so a protected secret is armed only through SET_DELETE_AFTER_USE and its deletion authority. `secret` is the row
   // read before this completion's writes; an already-protected secret (a STORE that keeps protection) keeps its option.
   if(!secret.protected && secret.deleteAfterUse){
    await tx.secret.update({where:{id:secret.id},data:{deleteAfterUse:false,updatedBy:r.requester_id}});
    await recordSecretEvent(tx,{ownerId:r.app_id,secretId:secret.id,secretName:r.secret_name,kind:'DELETE_AFTER_USE_OFF',actor});
   }
  }
  await tx.$executeRaw`UPDATE secret_change_requests SET state='completed',ended_at=(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${r.id}`;
  return null;
 });
 if(result instanceof GraphQLError)throw result;
}
/**
 * #4703 (cor:sec:070:02): the requester ends their own open request with a passkey proof, as for approve. Only the requester
 * (any other person is refused as for a missing request), one guarded `open` -> `declined` update under the request's row lock,
 * and the database clears the staged value with the state. Same standing and cooling-off judgment as completion; an open
 * request past its deadline ends `expired`, never `declined`. Locks: the user anchor, then the request, then the credential
 * (the order completion takes them in, minus the secret lock a decline does not need).
 */
export async function declineSecretChange(db: PrismaClient, a: SecretAssertion): Promise<void> {
 const located=await request(db,a.requestId);if(!located)throw refuse();
 const verified=await verify(db,a,secretDeclineChallenge(located));
 if(verified.snapshot.ownerId!==located.requester_id||!signingSurfacePolicy().signing)throw refuse();
 const user=await db.user.findUnique({where:{id:located.requester_id},select:{roles:true,deletedAt:true}});
 if(!user||user.deletedAt)throw refuse();
 const ctx={db,userId:located.requester_id,roles:user.roles} as Context;
 const result=await withAuthorizedTx(ctx,[{kind:'user',id:located.requester_id}],async(txCtx)=>{
  await requirePersonOnlyAct(txCtx,'secret.change',refuse);
 },async(tx)=>{
  const [r]=await tx.$queryRaw<ChangeRequest[]>`SELECT * FROM secret_change_requests WHERE id=${located.id} FOR UPDATE`;
  if(!r||r.requester_id!==verified.snapshot.ownerId)throw refuse();
  // Lock the credential before the decision clock, so waiting cannot preserve an expired cooling-off or request judgment.
  const [cred]=await tx.$queryRaw<Array<{window_ends_at:Date|null;window_outcome:string|null}>>`SELECT window_ends_at,window_outcome FROM passkey_credentials WHERE id=${verified.snapshot.passkeyId} FOR UPDATE`;
  const [{now}]=await tx.$queryRaw<Array<{now:Date}>>`SELECT hadron_signing_now() AS now`;
  if(r.state!=='open')throw refuse();
  if(r.expires_at<=now){
   await tx.$executeRaw`UPDATE secret_change_requests SET state='expired',ended_at=(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${r.id} AND state='open'`;
   return new GraphQLError('This secret change is no longer available.',{extensions:{code:'SECRET_CHANGE_REQUEST_EXPIRED'}});
  }
  // A credential that vanished between verification and this lock is a refusal, not a cooling-off (#4798 BLIND F3).
  if(!cred)throw refuse();
  if(cred.window_outcome===null&&cred.window_ends_at!==null&&cred.window_ends_at>now)throw new GraphQLError('This passkey is still in its cooling-off period.',{extensions:{code:'PASSKEY_COOLING_OFF'}});
  const decided=await decideCeremonyAssertion(tx,{ceremonyId:a.ceremonyId,browserNonceHash:a.browserNonceHash,purpose:'SECRET_CHANGE',verified:verified.snapshot});
  if(!decided||decided.ownerId!==r.requester_id)throw refuse();
  // The one transition: guarded on `open`, so nothing else that ended the request is ever overwritten. The staged value is
  // cleared by the table's own trigger in the same statement.
  const moved=await tx.$executeRaw`UPDATE secret_change_requests SET state='declined',ended_at=(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${r.id} AND state='open'`;
  if(moved!==1)throw refuse();
  return null;
 });
 if(result instanceof GraphQLError)throw result;
}
