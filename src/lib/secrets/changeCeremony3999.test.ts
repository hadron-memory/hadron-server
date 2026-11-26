import { bigintAsString } from '../../test/bigintJson.js';
import * as deletion from './autoDelete.js';
import * as secretRows from './appSecrets.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { revealForPersonHolder } from './readClientReveal.js';
import { runAsActor } from '../requestActor.js';
import { createGrantSigningRequestInTransaction } from '../signing/grantRequests.js';
import { openGrantProofCeremony, proveForGrantSigning, currentGrantSigningChallenge, completeGrantSigning } from '../signing/grantCeremony.js';
import { ApolloServer } from '@apollo/server';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { formatGraphQLError } from '../../api/graphql/formatError.js';
/** #3999 real database and real software-passkey assertions, no production or provider calls. */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { insertSoftPasskey, softPasskey } from '../../test/softPasskey.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { openSecretProof, proveSecretChange, completeSecretChange, SecretCeremonyRefused } from './changeCeremony.js';
import { type ChangeRequest, sweepExpiredSecretChanges } from './changeRequests.js';
import { upsertPlatformActions } from '../grants/actions.js';
import { currentAppSecretValue } from './appSecrets.js';
import { unwrapAppKey, secretVersionAad } from './appKeys.js';
import { decryptBytesAad } from '../tokenCrypto.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const RP='localhost',ORIGIN='http://localhost:4000';
let userId:string,appId:string,secretId:string;
const key=softPasskey();
const ctx=():Context=>({db,userId,roles:[]} as unknown as Context);
const error=async(p:Promise<unknown>)=>p.then(()=>{throw new Error('expected refusal');},e=>e);
async function stage(){return (await error(resolvers.Mutation.updateSecret({}, {ref:secretId,value:'staged-canary'},ctx()))).extensions.requestId as string;}
async function proof(id:string,k=key,opts:{uv?:boolean;origin?:string}={},nonce='browser-nonce-for-secret-change'){
 const open=await openSecretProof(db,{requestId:id,browserNonceHash:hash(nonce)});
 return proveSecretChange(db,{requestId:id,ceremonyId:open.ceremonyId,browserNonceHash:hash(nonce),credentialId:k.credentialId,
 assertion:k.assert({payload:Buffer.alloc(0),rawChallenge:Buffer.from(open.challenge,'base64url'),origin:ORIGIN,rpId:RP,...opts})});
}
async function complete(id:string,p:any,k=key){return completeSecretChange(db,{requestId:id,ceremonyId:p.ceremonyId,browserNonceHash:hash(p.nonce),credentialId:k.credentialId,
 assertion:k.assert({payload:Buffer.alloc(0),rawChallenge:Buffer.from(p.challenge,'base64url'),origin:ORIGIN,rpId:RP})});}
const row=async(id:string)=>(await db.$queryRaw<ChangeRequest[]>`SELECT * FROM secret_change_requests WHERE id=${id}`)[0];
beforeEach(async()=>{
 process.env.SECRET_ROOT_KEY='22'.repeat(32);process.env.PASSKEY_SIGNING_ENABLED='true';
 process.env.PASSKEY_RP_ID=RP;process.env.SIGNING_CEREMONY_ORIGINS=ORIGIN;
 await cleanDb(db); await upsertPlatformActions(db);
 userId=(await db.user.create({data:{email:`${generateId()}@s4.test`}})).id;
 appId=(await db.app.create({data:{ownerUserId:userId,name:'S4 ceremony',urn:`${generateId().toLowerCase()}:s4`}})).id;
 secretId=(await resolvers.Mutation.createSecret({}, {ownerType:'app',ownerRef:appId,name:'canary',kind:'generic',value:'original'},ctx())).id;
 await db.secret.update({where:{id:secretId},data:{protected:true}});
 await insertSoftPasskey(db,userId,key,{rpId:RP});
});
describe('#3999 own passkey ceremony',()=>{
 it('commits one re-encrypted version, clears staged ciphertext and retains completed polling',async()=>{
  const id=await stage(),r=await row(id);expect(r.staged_value_encrypted).toBeTruthy();
  const k=await unwrapAppKey(db as never,appId,r.key_version!);
  expect(()=>decryptBytesAad(r.staged_value_encrypted!,secretVersionAad(secretId,2),k.encryptionKey)).toThrow();
  const p=await proof(id);expect(p.outcome).toBe('change');expect(JSON.stringify(p)).not.toContain('staged-canary');
  await complete(id,p);expect((await row(id)).state).toBe('completed');expect((await row(id)).staged_value_encrypted).toBeNull();
  expect(await currentAppSecretValue(db as never,{id:secretId,ownerId:appId})).toBe('staged-canary');
  await expect(complete(id,p)).rejects.toThrow();expect(await db.secretVersion.count({where:{secretId}})).toBe(2);
 });
 it('refuses another person at proof without spending their assertion or disclosing the request',async()=>{
  const other=(await db.user.create({data:{email:`${generateId()}@s4.test`}})).id;
  await db.appMember.create({data:{appId,userId:other,role:'reader'}});const k=softPasskey();await insertSoftPasskey(db,other,k,{rpId:RP});
  const id=await stage();await expect(proof(id,k)).rejects.toThrow();expect((await row(id)).state).toBe('open');
 });
 it('persists stale and clears staged value when another writer changed the secret',async()=>{
  const id=await stage(),p=await proof(id);
  await db.secret.update({where:{id:secretId},data:{metadata:{changed:true}}});
  await expect(complete(id,p)).rejects.toMatchObject({extensions:{code:'SECRET_CHANGE_REQUEST_STALE'}});
  expect((await row(id)).state).toBe('stale');expect((await row(id)).staged_value_encrypted).toBeNull();
 });
 it('withdraws only for the requester and clears the ciphertext',async()=>{
  const id=await stage();await resolvers.Mutation.withdrawSecretChangeRequest({}, {id},ctx());
  expect((await row(id)).state).toBe('withdrawn');expect((await row(id)).staged_value_encrypted).toBeNull();
 });
 it('bounds open requests per secret',async()=>{
  const users=await Promise.all([0,1].map(()=>db.user.create({data:{email:`${generateId()}@s4.test`}})));
  await db.appMember.createMany({data:users.map(user=>({appId,userId:user.id,role:'reader'}))});
  const others=users.map(user=>({...ctx(),userId:user.id}));
  for(const caller of [ctx(),ctx(),others[0],others[0],others[1]]){
   expect((await error(resolvers.Mutation.updateSecret({}, {ref:secretId,value:'staged'},caller))).extensions.requestId).toEqual(expect.any(String));
  }
  expect((await error(resolvers.Mutation.updateSecret({}, {ref:secretId,value:'six'},others[1]))).extensions.code).toBe('SECRET_CHANGE_REQUEST_LIMIT');
 });
});

describe('#3999 lifecycle and authority negatives',()=>{
 it('refuses a first passkey in cooling-off without writing a version or spending completion',async()=>{
  const cold=softPasskey();await insertSoftPasskey(db,userId,cold,{rpId:RP,firstWindow:true});
  const id=await stage(),p=await proof(id,cold);
  await expect(complete(id,p,cold)).rejects.toMatchObject({extensions:{code:'PASSKEY_COOLING_OFF'}});
  expect((await row(id)).state).toBe('open');expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
  const [cer]=await db.$queryRaw<Array<{consumed_at:Date|null}>>`SELECT consumed_at FROM passkey_ceremonies WHERE id=${(p as any).ceremonyId}`;
  expect(cer.consumed_at).toBeNull();
 });
 it('rejudges App uninstall at completion and preserves the request uncompleted',async()=>{
  const id=await stage(),p=await proof(id);
  await db.app.update({where:{id:appId},data:{uninstalledAt:new Date()}});
  await expect(complete(id,p)).rejects.toThrow();expect((await row(id)).state).toBe('open');
 });
 it('clears outstanding staged copies when the secret is deleted by another path',async()=>{
  const id=await stage();await db.secret.delete({where:{id:secretId}});
  expect((await row(id)).state).toBe('stale');expect((await row(id)).staged_value_encrypted).toBeNull();
 });
 it('clears staged requests at App soft-delete',async()=>{
  const id=await stage();await db.app.update({where:{id:appId},data:{deletedAt:new Date()}});expect(await row(id)).toBeUndefined();
 });
 it('serializes two completion attempts: one version and one completed request',async()=>{
  const id=await stage(),p=await proof(id);
  const both=await Promise.allSettled([complete(id,p),complete(id,p)]);
  expect(both.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.secretVersion.count({where:{secretId}})).toBe(2);
 });
 it('protected create stages without a row and the completed row is protected',async()=>{
  const staged=await error(resolvers.Mutation.createSecret({}, {ownerType:'app',ownerRef:appId,name:'new-protected',kind:'generic',value:'new-canary',protected:true},ctx()));
  const id=staged.extensions.requestId;
  expect(await db.secret.count({where:{ownerType:'app',ownerId:appId,name:'new-protected'}})).toBe(0);
  const p=await proof(id);await complete(id,p);
  expect(await db.secret.findUnique({where:{ownerType_ownerId_name:{ownerType:'app',ownerId:appId,name:'new-protected'}}})).toMatchObject({protected:true});
 });
 it('a protected create loses stale to an ordinary create of the same name',async()=>{
  const id=(await error(resolvers.Mutation.createSecret({}, {ownerType:'app',ownerRef:appId,name:'racing',kind:'generic',value:'staged',protected:true},ctx()))).extensions.requestId;
  const p=await proof(id);
  await resolvers.Mutation.createSecret({}, {ownerType:'app',ownerRef:appId,name:'racing',kind:'generic',value:'ordinary'},ctx());
  await expect(complete(id,p)).rejects.toMatchObject({extensions:{code:'SECRET_CHANGE_REQUEST_STALE'}});
  expect((await row(id)).staged_value_encrypted).toBeNull();
 });
 it('only the requester can poll or withdraw, including under impersonation',async()=>{
  const id=await stage();const other=(await db.user.create({data:{email:`${generateId()}@s4.test`}})).id;
  const outsider={...ctx(),userId:other};
  expect(await resolvers.Query.secretChangeRequest({}, {id},outsider)).toBeNull();
  await expect(resolvers.Mutation.withdrawSecretChangeRequest({}, {id},outsider)).rejects.toMatchObject({extensions:{code:'NOT_FOUND'}});
  expect(await resolvers.Query.secretChangeRequest({}, {id},{...ctx(),impersonation:{}} as Context)).toBeNull();
  expect((await row(id)).state).toBe('open');
 });
 it('refused worker-shaped staging has no id, ciphertext or new request',async()=>{
  const before=await db.secretChangeRequest.count();
  const e=await error(resolvers.Mutation.updateSecret({}, {ref:secretId,value:'worker-canary'},{...ctx(),sessionBindingRefused:true} as unknown as Context));
  expect(e.extensions).toEqual({code:'SECRET_PROTECTED_NEEDS_PASSKEY'});expect(await db.secretChangeRequest.count()).toBe(before);
 });
 it('completes a protected delete and retains requester-visible completion',async()=>{
  const id=(await error(resolvers.Mutation.deleteSecret({}, {ref:secretId},ctx()))).extensions.requestId;
  await complete(id,await proof(id));expect(await db.secret.findUnique({where:{id:secretId}})).toBeNull();
  expect((await row(id)).state).toBe('completed');
 });
});

describe('#3999 clearing and request integrity',()=>{
 it('physically clears expired staged bytes without anyone polling the request',async()=>{
  const id=await stage();const r=await row(id);const expiredId=generateId();
  await db.secretChangeRequest.create({data:{id:expiredId,appId,secretId,secretName:r.secret_name,secretKind:r.secret_kind,metadata:r.metadata as never,
   operation:r.operation,requesterId:userId,state:'open',snapshot:r.snapshot,stagedValueEncrypted:r.staged_value_encrypted,keyVersion:r.key_version,
   sizeBytes:r.size_bytes,expiresAt:new Date(Date.now()-10000)}});
  expect(await db.$transaction(tx=>sweepExpiredSecretChanges(tx))).toBe(1);
  expect((await row(expiredId)).state).toBe('expired');expect((await row(expiredId)).staged_value_encrypted).toBeNull();
  expect((await row(id)).state).toBe('open');
 });
 it('the database refuses changing a request target or reviving a terminal request',async()=>{
  const id=await stage();
  await expect(db.$executeRaw`UPDATE secret_change_requests SET secret_name='other' WHERE id=${id}`).rejects.toThrow();
  await resolvers.Mutation.withdrawSecretChangeRequest({}, {id},ctx());
  await expect(db.$executeRaw`UPDATE secret_change_requests SET state='open',ended_at=NULL WHERE id=${id}`).rejects.toThrow();
 });
 it('protects and unprotects only by the requester passkey ceremony',async()=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});
  const id=(await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:true},ctx()))).extensions.requestId;
  expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(false);
  await complete(id,await proof(id));expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(true);
  const clearId=(await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:false},ctx()))).extensions.requestId;
  await complete(clearId,await proof(clearId));expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(false);
 });
});

describe('#3999 assertion binding negatives',()=>{
 it.each([{uv:false},{origin:'https://untrusted.invalid'}])('requires user verification and the configured origin (%j)',async(opts)=>{
  const id=await stage();await expect(proof(id,key,opts)).rejects.toThrow();expect((await row(id)).state).toBe('open');
 });
 it('requires the rotated browser nonce at completion',async()=>{
  const id=await stage(),p=await proof(id) as any;
  await expect(complete(id,{...p,nonce:'another-browser'})).rejects.toThrow();expect((await row(id)).state).toBe('open');
  expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
 });
 it('refuses a credential revoked between proof and completion',async()=>{
  const id=await stage(),p=await proof(id);
  await db.$executeRaw`UPDATE passkey_credentials SET revoked_at=public.hadron_passkey_wall_now() WHERE credential_id=${key.credentialId}`;
  await expect(complete(id,p)).rejects.toThrow();expect((await row(id)).state).toBe('open');
 });
 it('two protected creates of one name have exactly one winner and one stale terminal request',async()=>{
  const open=async()=> (await error(resolvers.Mutation.createSecret({}, {ownerType:'app',ownerRef:appId,name:'double-create',kind:'generic',value:'chosen',protected:true},ctx()))).extensions.requestId as string;
  const first=await open(),second=await open(),p1=await proof(first),p2=await proof(second);
  const results=await Promise.allSettled([complete(first,p1),complete(second,p2)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect([(await row(first)).state,(await row(second)).state].sort()).toEqual(['completed','stale']);
  expect(await db.secret.count({where:{ownerType:'app',ownerId:appId,name:'double-create'}})).toBe(1);
 });
});

describe('#3999 protection authority',()=>{
 it('allows any person member to turn protection on, but refuses their attempt to turn it off',async()=>{
  const member=(await db.user.create({data:{email:`${generateId()}@s4.test`}})).id;
  await db.appMember.create({data:{appId,userId:member,role:'reader'}});
  const k=softPasskey();await insertSoftPasskey(db,member,k,{rpId:RP});
  await db.secret.update({where:{id:secretId},data:{protected:false}});
  const memberCtx={...ctx(),userId:member};
  const id=(await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:true},memberCtx))).extensions.requestId;
  await complete(id,await proof(id,k),k);expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(true);
  await expect(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:false},memberCtx)).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});
 });
});

describe('#3999 update protection terms',()=>{
 it('protects through updateSecret without manufacturing a value version',async()=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});
  const id=(await error(resolvers.Mutation.updateSecret({}, {ref:secretId,protected:true},ctx()))).extensions.requestId;
  await complete(id,await proof(id));expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(true);
  expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
 });
 it('shows an explicit protection change when updateSecret stages no new value',async()=>{
  const id=(await error(resolvers.Mutation.updateSecret({}, {ref:secretId,protected:false},ctx()))).extensions.requestId;
  const r=await row(id);expect(r.staged_value_encrypted).toBeNull();expect(r.key_version).toBeNull();
  const p=await proof(id);expect(p.outcome).toBe('change');if(p.outcome==='change')expect(p.summary.change).toBe('Turn protection off');
  await complete(id,p);expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(false);expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
 });
 it('a protected metadata-only edit keeps the current version unchanged',async()=>{
  const id=(await error(resolvers.Mutation.updateSecret({}, {ref:secretId,metadata:{label:'chosen'}},ctx()))).extensions.requestId;
  expect((await row(id)).staged_value_encrypted).toBeNull();
  expect((await row(id)).key_version).toBeNull();
  const p=await proof(id);expect(p.outcome).toBe('change');if(p.outcome==='change')expect(p.summary.change).toBe('Update secret metadata');
  await complete(id,p);expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
  expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).metadata).toEqual({label:'chosen'});
 });
});

describe('#3999 completion rejudges membership and unprotect authority',()=>{
 it('refuses a requester removed after proof, leaving the request open and value unchanged',async()=>{
  const owner=(await db.user.create({data:{email:`${generateId()}@s4.test`}})).id;
  await db.app.update({where:{id:appId},data:{ownerUserId:owner}});
  await db.appMember.create({data:{appId,userId,role:'reader'}});
  const id=await stage(),p=await proof(id);
  await db.appMember.deleteMany({where:{appId,userId}});
  await expect(complete(id,p)).rejects.toMatchObject({extensions:{code:'FORBIDDEN'}});expect((await row(id)).state).toBe('open');
  expect(await db.secretVersion.count({where:{secretId}})).toBe(1);expect(await currentAppSecretValue(db as never,{id:secretId,ownerId:appId})).toBe('original');
 });
 it.each(['setSecretProtected','updateSecret'] as const)('refuses a demoted manager at %s completion even while still a member',async door=>{
  const owner=(await db.user.create({data:{email:`${generateId()}@s4.test`}})).id;
  const id=(await error(resolvers.Mutation[door]({}, {ref:secretId,protected:false},ctx()))).extensions.requestId;
  const p=await proof(id);
  await db.app.update({where:{id:appId},data:{ownerUserId:owner}});
  await db.appMember.create({data:{appId,userId,role:'reader'}});
  await expect(complete(id,p)).rejects.toBeInstanceOf(SecretCeremonyRefused);expect((await row(id)).state).toBe('open');
  expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(true);
 });
});

describe('#3999 delete authority is current at completion',()=>{
 it('refuses a former manager who remains a member but did not create the secret',async()=>{
  const writer=(await db.user.create({data:{email:`${generateId()}@s4.test`}})).id;
  await db.appMember.create({data:{appId,userId:writer,role:'reader'}});
  const target=await resolvers.Mutation.createSecret({}, {ownerType:'app',ownerRef:appId,name:'other-writer',kind:'generic',value:'chosen'},{...ctx(),userId:writer});
  await db.secret.update({where:{id:target.id},data:{protected:true}});
  const id=(await error(resolvers.Mutation.deleteSecret({}, {ref:target.id},ctx()))).extensions.requestId;
  const p=await proof(id);
  await db.app.update({where:{id:appId},data:{ownerUserId:writer}});
  await db.appMember.create({data:{appId,userId,role:'reader'}});
  await expect(complete(id,p)).rejects.toThrow();expect(await db.secret.count({where:{id:target.id}})).toBe(1);
 });
});


describe('#3999 completion expiry clock',()=>{
 it('ends and clears an expired request using the decision clock after locks',async()=>{
  const id=await stage(),p=await proof(id);
  // This Vitest worker owns its private DB. Move only the shared signing-decision clock, then restore it in finally.
  await db.$executeRawUnsafe("CREATE OR REPLACE FUNCTION hadron_signing_now() RETURNS timestamp(3) LANGUAGE sql VOLATILE AS $$ SELECT (clock_timestamp() AT TIME ZONE 'UTC' + interval '2 hours')::timestamp(3) $$");
  try{
   await expect(complete(id,p)).rejects.toMatchObject({extensions:{code:'SECRET_CHANGE_REQUEST_EXPIRED'}});
   expect((await row(id)).state).toBe('expired');expect((await row(id)).staged_value_encrypted).toBeNull();
   expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
  }finally{
   await db.$executeRawUnsafe("CREATE OR REPLACE FUNCTION hadron_signing_now() RETURNS timestamp(3) LANGUAGE sql VOLATILE AS $$ SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) $$");
  }
 });
});


describe('#3999 wire error and canary boundary',()=>{
 it('keeps the staged value out of real Apollo responses, coercion errors, events and captured logs',async()=>{
  const canary='R11-plaintext-a5719';
  const calls:unknown[][]=[];
  const spies=[vi.spyOn(console,'log'),vi.spyOn(console,'warn'),vi.spyOn(console,'error')];
  for(const spy of spies)spy.mockImplementation((...a:unknown[])=>{calls.push(a);});
  const api=new ApolloServer<Context>({typeDefs,resolvers,formatError:formatGraphQLError,includeStacktraceInErrorResponses:false});
  try{
   await api.start();
   const query='mutation($ref:ID!,$value:JSON!,$protected:Boolean){updateSecret(ref:$ref,value:$value,protected:$protected){id}}';
   const result=await api.executeOperation({query,variables:{ref:secretId,value:canary}},{contextValue:ctx()});
   expect(result.body.kind).toBe('single');
   if(result.body.kind!=='single')throw new Error('unexpected response kind');
   expect(result.body.singleResult.errors?.[0].extensions).toMatchObject({code:'SECRET_PROTECTED_NEEDS_PASSKEY',requestId:expect.any(String),ceremonyUrl:expect.any(String)});
   expect(JSON.stringify(result.body)).not.toContain(canary);
   const coercion=await api.executeOperation({query,variables:{ref:secretId,value:canary,protected:canary}},{contextValue:ctx()});
   expect(coercion.body.kind).toBe('single');
   if(coercion.body.kind==='single')expect(coercion.body.singleResult.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
   expect(JSON.stringify(coercion.body)).not.toContain(canary);
   expect(await db.secretEvent.findMany({where:{secretId}})).not.toEqual([]);
   expect(JSON.stringify(await db.secretEvent.findMany({where:{secretId}}), bigintAsString)).not.toContain(canary);
   expect(JSON.stringify(calls)).not.toContain(canary);
  }finally{await api.stop();for(const spy of spies)spy.mockRestore();}
 });
});

describe('#3999 request authority and revision pins',()=>{
 it('rejects a different credential owner even with the completion challenge from the requester browser',async()=>{
  const other=(await db.user.create({data:{email:`${generateId()}@s4.test`}})).id;
  await db.appMember.create({data:{appId,userId:other,role:'reader'}});const k=softPasskey();await insertSoftPasskey(db,other,k,{rpId:RP});
  const id=await stage(),p=await proof(id);await expect(complete(id,p,k)).rejects.toThrow();
  expect((await row(id)).state).toBe('open');expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
 });
 it('rejects a changed-then-restored secret even if its old timestamp and metadata were restored',async()=>{
  const id=await stage(),p=await proof(id),original=await db.secret.findUniqueOrThrow({where:{id:secretId}});
  await db.$executeRaw`UPDATE secrets SET metadata='{"changed":true}'::jsonb,updated_at=(${original.updatedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${secretId}`;
  await db.$executeRaw`UPDATE secrets SET metadata=${JSON.stringify(original.metadata)}::jsonb,updated_at=(${original.updatedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC') WHERE id=${secretId}`;
  const restored=await db.secret.findUniqueOrThrow({where:{id:secretId}});
  expect(restored.updatedAt).toEqual(original.updatedAt);
  expect(restored.metadata).toEqual(original.metadata);
  expect(restored.protected).toBe(original.protected);
  expect(restored.changeRevision).toBe(original.changeRevision+2);
  await expect(complete(id,p)).rejects.toMatchObject({extensions:{code:'SECRET_CHANGE_REQUEST_STALE'}});
 });
});

describe('#3999 UTC-naive transaction timestamps',()=>{
 it('records completion on the UTC clock even with a non-UTC transaction timezone',async()=>{
  const id=await stage(),p=await proof(id);
  const transact=db.$transaction.bind(db);
  const spy=vi.spyOn(db,'$transaction').mockImplementationOnce(((f:any,opts:any)=>transact(async(tx)=>{
   await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Auckland'");return f(tx);
  },opts)) as any);
  try{await complete(id,p);}finally{spy.mockRestore();}
  const [r]=await db.$queryRaw<Array<{utc:boolean}>>`SELECT ended_at >= created_at AND ended_at <= hadron_signing_now() AS utc FROM secret_change_requests WHERE id=${id}`;
  expect(r.utc).toBe(true);
 });
});


describe('#3999 proof rotation',()=>{
 it('a fresh proof in the same browser retires the earlier completion ceremony',async()=>{
  const first=await stage(),second=await stage(),p1=await proof(first) as any;
  const p2=await proof(second,key,{},p1.nonce);
  await expect(complete(first,p1)).rejects.toThrow();expect((await row(first)).state).toBe('open');
  await complete(second,p2);expect((await row(second)).state).toBe('completed');
 });
});

describe('#3999 staged deletion uses the common deletion contract',()=>{
 it('rolls back request completion, audit and deletion when the shared helper fails after deleting', async () => {
   const pending = await stage();
   const before = (await row(pending)).staged_value_encrypted;
   const id = (await error(resolvers.Mutation.deleteSecret({}, { ref: secretId }, ctx()))).extensions.requestId;
   const p = await proof(id);
   const original = deletion.deleteLockedAppSecret;
   const fail = vi.spyOn(deletion, 'deleteLockedAppSecret').mockImplementation(async (...args) => {
     await original(...args);
     throw new Error('injected post-delete failure');
   });
   try {
     await expect(complete(id, p)).rejects.toThrow('injected post-delete failure');
   }
   finally {
     fail.mockRestore();
   }
   expect(await db.secret.count({ where: { id: secretId } })).toBe(1);
   expect(await db.secretVersion.count({ where: { secretId } })).toBe(1);
   expect(await db.secretEvent.count({ where: { secretId, kind: 'DELETE' } })).toBe(0);
   expect((await row(id)).state).toBe('open');
   expect((await row(pending)).state).toBe('open');
   expect((await row(pending)).staged_value_encrypted).toBe(before);
 });
 it('a manager deletes another person secret with newest-version audit, client ends and request cleanup', async () => {
   const writer = (await db.user.create({ data: { email: `${generateId()}@s4.test` } })).id;
   await db.appMember.create({ data: { appId, userId: writer, role: 'writer' } });
   const writerCtx = { ...ctx(), userId: writer };
   const target = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'manager-target', kind: 'generic', value: 'v1' }, writerCtx);
   await resolvers.Mutation.updateSecret({}, { ref: target.id, value: 'v2' }, writerCtx);
   const protectId = (await error(resolvers.Mutation.setSecretProtected({}, { ref: target.id, protected: true }, ctx()))).extensions.requestId;
   await complete(protectId, await proof(protectId));
   const client = await resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: target.id, holderKind: 'USER', holderRef: writer, reason: 'sibling ends with secret' } }, ctx());
   const staged = (await error(resolvers.Mutation.updateSecret({}, { ref: target.id, value: 'never-committed' }, writerCtx))).extensions.requestId;
   const id = (await error(resolvers.Mutation.deleteSecret({}, { ref: target.id }, ctx()))).extensions.requestId;
   await complete(id, await proof(id));
   expect(await db.secret.findUnique({ where: { id: target.id } })).toBeNull();
   expect(await db.secretVersion.count({ where: { secretId: target.id } })).toBe(0);
   expect(await db.secretEvent.findMany({ where: { secretId: target.id, kind: 'DELETE' } })).toMatchObject([{ versionNo: 2, actorUserId: userId }]);
   expect(await db.secretReadClient.findUniqueOrThrow({ where: { id: client.clientId } })).toMatchObject({ endReason: 'SECRET_DELETED', endedAt: expect.any(Date) });
   expect((await row(id)).state).toBe('completed');
   expect((await row(id)).staged_value_encrypted).toBeNull();
   expect((await row(staged)).state).toBe('stale');
   expect((await row(staged)).staged_value_encrypted).toBeNull();
 });

});

describe('#3999 explicit validation and event boundaries',()=>{
 it('documents both protection event kinds on the public schema',()=>{
  const event=buildSchema(typeDefs).getType('SecretEvent') as GraphQLObjectType;
  expect(event.getFields().kind.description).toMatch(/\bPROTECT\b/);expect(event.getFields().kind.description).toMatch(/\bUNPROTECT\b/);
 });
 it.each([false,true])('refuses an oversized UTF-8 update before any write (protected=%s)',async protectedValue=>{
  await db.secret.update({where:{id:secretId},data:{protected:protectedValue}});
  const before=await db.secretChangeRequest.count();
  const e=await error(resolvers.Mutation.updateSecret({}, {ref:secretId,value:'é'.repeat(16_400)},ctx()));
  expect(e.extensions?.code).toBe('BAD_USER_INPUT');
  expect(await db.secretChangeRequest.count()).toBe(before);expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
  expect(await currentAppSecretValue(db as never,{id:secretId,ownerId:appId})).toBe('original');
 });
 it('exposes both protection event kinds through the real GraphQL event read surface',async()=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});
  for(const protectedValue of [true,false]){
   const id=(await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:protectedValue},ctx()))).extensions.requestId;
   await complete(id,await proof(id));
  }
  const api=new ApolloServer<Context>({typeDefs,resolvers});
  try{
   await api.start();const result=await api.executeOperation({query:'query($ref:ID!){secretEvents(ref:$ref){items{kind}}}',variables:{ref:secretId}},{contextValue:ctx()});
   expect(result.body.kind).toBe('single');if(result.body.kind!=='single')throw new Error('single response required');
   expect(result.body.singleResult.errors).toBeUndefined();
   const data=result.body.singleResult.data as {secretEvents:{items:Array<{kind:string}>}};
   expect(data.secretEvents.items.map(e=>e.kind)).toEqual(expect.arrayContaining(['PROTECT','UNPROTECT']));
  }finally{await api.stop();}
 });
 it.each([true,false])('activates and reveals a protected worker grant with person holder NULL (own=%s)',async own=>{
  await db.secret.update({where:{id:secretId},data:{protected:true}});expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(true);
  const agent=await db.agent.create({data:{name:'protected-agent',urn:`${generateId()}:protected`,ownerUserId:userId}});
  const worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,name:'protected-worker',slug:'protected-worker',appId,agentId:agent.id,...(own?{heldByUserId:userId,heldAt:new Date()}:{})}});
  const c=await resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'WORKER',holderRef:worker.id,reason:'protected worker boundary'}},ctx());
  const grant=await db.grant.findUniqueOrThrow({where:{id:c.grantId}});expect(grant.userId).toBeNull();expect(grant.workerId).toBe(worker.id);
  await (await prepareClientActivation(c.grantId))();expect((await db.grant.findUniqueOrThrow({where:{id:c.grantId}})).activatedAt).not.toBeNull();
  const revealed=await runAsActor({workerId:worker.id,agentId:null},()=>resolvers.Mutation.revealSecret({}, {clientId:c.clientId},ctx()));
  expect(revealed.value).toBe(JSON.stringify('original'));
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:c.clientId}})).issuedToOwnWorker).toBe(own);
 });
});

describe('#3999 S3 protection fold', () => {
 it('refuses a self-issued person client on a protected secret but permits another person', async () => {
  await expect(resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'USER',reason:'protected self'}},ctx())).rejects.toMatchObject({extensions:{code:'SECRET_PROTECTED_TWO_PERSON_REQUIRED'}});
  const other=await db.user.create({data:{email:`${generateId()}@s4.test`}});
  await db.appMember.create({data:{appId,userId:other.id,role:'member'}});
  const client=await resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'USER',holderRef:other.id,reason:'different person'}},ctx());
  expect(client.selfIssued).toBe(false);
  expect((await db.grant.findUniqueOrThrow({where:{id:client.grantId}})).userId).toBe(other.id);
 });
 it.each(['set','store'])('ends an existing self-issued pending client via %s and its grant atomically, attributes one end, and never revives it', async operation => {
  await db.secret.update({where:{id:secretId},data:{protected:false}});
  const client=await resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'USER',reason:'before protection'}},ctx());
  const staged=await error(operation==='set' ? resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:true},ctx()) : resolvers.Mutation.updateSecret({}, {ref:secretId,protected:true,value:'stored-protected'},ctx()));
  const id=staged.extensions.requestId,p=await proof(id);await complete(id,p);
  expect(await db.secretReadClient.findUniqueOrThrow({where:{id:client.clientId}})).toMatchObject({endReason:'PROTECTED',endedAt:expect.any(Date)});
  expect(await db.grant.findUniqueOrThrow({where:{id:client.grantId}})).toMatchObject({revokedAt:expect.any(Date),revokedBy:userId});
  expect(await db.grantEvent.findMany({where:{grantId:client.grantId,action:'REVOKE'}})).toMatchObject([{actorUserId:userId}]);
  const off=await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:false},ctx()));
  await complete(off.extensions.requestId,await proof(off.extensions.requestId));
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:client.clientId}})).endReason).toBe('PROTECTED');
  expect(await db.grantEvent.count({where:{grantId:client.grantId,action:'REVOKE'}})).toBe(1);
 });
});

/** Real signature preparation; the signature itself is spent only when the returned operation runs. */
async function prepareClientActivation(grantId:string,signerId=userId,signerKey=key){
 const req=await db.$transaction(tx=>createGrantSigningRequestInTransaction(tx,grantId,{appId,requester:{userId,workerId:null,sessionId:null,appId:null}}));
 const browser=hash(`grant-${generateId()}`),o=await openGrantProofCeremony(db,{requestId:req.id,browserNonceHash:browser});
 const p=await proveForGrantSigning(db,{requestId:req.id,ceremonyId:o.ceremonyId,browserNonceHash:browser,credentialId:signerKey.credentialId,
  assertion:signerKey.assert({payload:Buffer.alloc(0),rawChallenge:Buffer.from(o.challenge,'base64url'),origin:ORIGIN,rpId:RP}),rpId:RP,origins:[ORIGIN]});
 if(p.outcome!=='open'||!p.canSign||!p.sessionNonce)throw new Error('grant proof expected');
 const browserHash=hash(p.sessionNonce),c=await currentGrantSigningChallenge(db,{requestId:req.id,browserNonceHash:browserHash,rpId:RP});
 return ()=>completeGrantSigning(db,{requestId:req.id,ceremonyId:c.ceremonyId,browserNonceHash:browserHash,credentialId:signerKey.credentialId,
  assertion:signerKey.assert({payload:Buffer.alloc(0),rawChallenge:Buffer.from(c.challenge,'base64url'),origin:ORIGIN,rpId:RP})});
}
async function pendingPerson(){return resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'USER',reason:'test protection race'}},ctx());}
async function activateFixture(grantId:string){
 await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
  await tx.$executeRaw`UPDATE grants SET activated_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 minute',issuer_user_id=${userId},verified_by=${userId},verification_kind='passkey' WHERE id=${grantId}`;
  await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
 });
}
describe('#3999 protection activation and read defenses',()=>{
 it('forced-live self-issued client is refused at read without spending a use',async()=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});const c=await pendingPerson();await activateFixture(c.grantId);
  expect((await revealForPersonHolder(ctx(),c.clientId)).value).toBe(JSON.stringify('original'));
  // Direct SQL models a missed protection transition: neither the client nor grant was ended.
  await db.secret.update({where:{id:secretId},data:{protected:true}});
  await expect(revealForPersonHolder(ctx(),c.clientId)).rejects.toMatchObject({extensions:{code:'SECRET_PROTECTED_TWO_PERSON_REQUIRED'}});
  expect((await db.grant.findUniqueOrThrow({where:{id:c.grantId}})).useCount).toBe(1);
 });
 it('refuses a self-issued activation when protection committed first',async()=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});const c=await pendingPerson(),activate=await prepareClientActivation(c.grantId);
  await db.secret.update({where:{id:secretId},data:{protected:true}});
  await expect(activate()).rejects.toMatchObject({extensions:{code:'SECRET_PROTECTED_TWO_PERSON_REQUIRED'}});
  expect((await db.grant.findUniqueOrThrow({where:{id:c.grantId}})).activatedAt).toBeNull();
 });
 it('a different person and the issuer own worker survive protection and still read',async()=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});
  const other=await db.user.create({data:{email:`${generateId()}@s4.test`}});await db.appMember.create({data:{appId,userId:other.id,role:'member'}});
  const agent=await db.agent.create({data:{name:'ownworkeragent',urn:`${generateId()}:a`,ownerUserId:userId}});
  const worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,name:'ownworker',slug:'ownworker',appId,agentId:agent.id,heldByUserId:userId,heldAt:new Date()}});
  const person=await resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'USER',holderRef:other.id,reason:'second person'}},ctx());
  const machine=await resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'WORKER',holderRef:worker.id,reason:'own worker'}},ctx());
  await activateFixture(person.grantId);await activateFixture(machine.grantId);
  const e=await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:true},ctx()));await complete(e.extensions.requestId,await proof(e.extensions.requestId));
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:person.clientId}})).endedAt).toBeNull();
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:machine.clientId}})).selfIssued).toBe(false);
  expect((await revealForPersonHolder({...ctx(),userId:other.id},person.clientId)).value).toBe(JSON.stringify('original'));
  const v=await runAsActor({workerId:worker.id,agentId:null},()=>resolvers.Mutation.revealSecret({}, {clientId:machine.clientId},ctx()));expect(v.value).toBe(JSON.stringify('original'));
 });
 it.each(['activation','protection'])('both-order real completions: %s holds the secret first',async first=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});const c=await pendingPerson(),activate=await prepareClientActivation(c.grantId);
  const e=await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:true},ctx())),p=await proof(e.extensions.requestId);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const original=secretRows.lockSecretRow;let paused=false;
  const spy=vi.spyOn(secretRows,'lockSecretRow').mockImplementation(async(tx,id)=>{const ok=await original(tx,id);if(!paused){paused=true;entered();await gate;}return ok;});
  const protect=()=>complete(e.extensions.requestId,p);
  let a:Promise<unknown>|undefined,b:Promise<unknown>|undefined;
  try{
   a=(first==='activation'?activate():protect());a.catch(()=>undefined);await started;
   b=(first==='activation'?protect():activate());b.catch(()=>undefined);
   let waited=false;for(let i=0;i<200;i++){
    const [{n}]=await db.$queryRaw<Array<{n:bigint}>>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`;
    if(Number(n)>0){waited=true;break;}await new Promise(r=>setTimeout(r,10));
   }
   expect(waited,'second real completion waited before first commit').toBe(true);release();
   const results=await Promise.allSettled([a,b]);expect(results[0].status).toBe('fulfilled');
   if(first==='activation')expect(results[1].status).toBe('fulfilled');else expect(results[1].status).toBe('rejected');
   expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).protected).toBe(true);
   expect((await db.secretReadClient.findUniqueOrThrow({where:{id:c.clientId}})).endReason).toBe('PROTECTED');
   await expect(revealForPersonHolder(ctx(),c.clientId)).rejects.toThrow();
  }finally{release();await Promise.allSettled([a,b].filter(Boolean) as Promise<unknown>[]);spy.mockRestore();}
 },30000);
});

describe('#3999 R22 own-worker issue marker',()=>{
 it.each([true,false])('the issue event retains own-worker=%s across protection',async own=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});
  const agent=await db.agent.create({data:{name:'R22agent',urn:`${generateId()}:r22`,ownerUserId:userId}});
  const worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,name:'r22worker',slug:'r22worker',appId,agentId:agent.id,...(own?{heldByUserId:userId,heldAt:new Date()}:{})}});
  const c=await resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'WORKER',holderRef:worker.id,reason:'R22 marker'}},ctx());
  await (await prepareClientActivation(c.grantId))();
  const e=await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:true},ctx()));await complete(e.extensions.requestId,await proof(e.extensions.requestId));
  const events=await db.$queryRaw<Array<{marker:boolean|null}>>`SELECT (to_jsonb(c)->>'issued_to_own_worker')::boolean AS marker FROM grant_events e JOIN secret_read_clients c ON c.grant_id=e.grant_id WHERE e.grant_id=${c.grantId} AND e.action='ACTIVATE'`;
  expect(events).toEqual([{marker:own}]);
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:c.clientId}})).endedAt).toBeNull();
 });
});

describe('#3999 R22 actual signer provenance',()=>{
 it.each([true,false])('captures ownership relative to the signer rather than requester (%s)',async heldBySigner=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});
  const signer=await db.user.create({data:{email:`${generateId()}@s4.test`}});await db.appMember.create({data:{appId,userId:signer.id,role:'owner'}});
  const signerKey=softPasskey();await insertSoftPasskey(db,signer.id,signerKey,{rpId:RP});
  const agent=await db.agent.create({data:{name:'R22signer',urn:`${generateId()}:r22signer`,ownerUserId:userId}});
  const worker=await db.worker.create({data:{...WORKER_SIGNATURE_DEFAULTS,name:'r22signer',slug:'r22signer',appId,agentId:agent.id,heldByUserId:heldBySigner?signer.id:userId,heldAt:new Date()}});
  const c=await resolvers.Mutation.issueSecretReadClient({}, {input:{secretRef:secretId,holderKind:'WORKER',holderRef:worker.id,reason:'actual signer'}},ctx());
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:c.clientId}})).issuedToOwnWorker).toBeNull();
  await(await prepareClientActivation(c.grantId,signer.id,signerKey))();
  const g=await db.grant.findUniqueOrThrow({where:{id:c.grantId}});expect(g.issuerUserId).toBe(signer.id);
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:c.clientId}})).issuedToOwnWorker).toBe(heldBySigner);
  await db.worker.update({where:{id:worker.id},data:{heldByUserId:heldBySigner?userId:signer.id}});
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:c.clientId}})).issuedToOwnWorker).toBe(heldBySigner);
  await expect(db.secretReadClient.update({where:{id:c.clientId},data:{issuedToOwnWorker:!heldBySigner}})).rejects.toThrow();
 });
});

describe('#3999 first end stands through protection',()=>{
 it('keeps an expired client expiry as its first end, without a second revoke or PROTECTED stamp',async()=>{
  await db.secret.update({where:{id:secretId},data:{protected:false}});const c=await pendingPerson();
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
   await tx.$executeRaw`UPDATE grants SET expires_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 minute' WHERE id=${c.grantId}`;
   await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
  const e=await error(resolvers.Mutation.setSecretProtected({}, {ref:secretId,protected:true},ctx()));await complete(e.extensions.requestId,await proof(e.extensions.requestId));
  expect((await db.grant.findUniqueOrThrow({where:{id:c.grantId}})).revokedAt).toBeNull();
  expect((await db.secretReadClient.findUniqueOrThrow({where:{id:c.clientId}})).endReason).toBeNull();
  expect(await db.grantEvent.count({where:{grantId:c.grantId,action:'REVOKE'}})).toBe(0);
 });
});
