import { ApolloServer } from '@apollo/server';
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
import { openSecretProof, proveSecretChange, completeSecretChange } from './changeCeremony.js';
import { type ChangeRequest, sweepExpiredSecretChanges } from './changeRequests.js';
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
 await cleanDb(db);
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
  for(let i=0;i<5;i++)expect(await stage()).toBeTruthy();
  expect((await error(resolvers.Mutation.updateSecret({}, {ref:secretId,value:'six'},ctx()))).extensions.code).toBe('SECRET_CHANGE_REQUEST_LIMIT');
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
 it('a protected metadata-only edit keeps the current version unchanged',async()=>{
  const id=(await error(resolvers.Mutation.updateSecret({}, {ref:secretId,metadata:{label:'chosen'}},ctx()))).extensions.requestId;
  await complete(id,await proof(id));expect(await db.secretVersion.count({where:{secretId}})).toBe(1);
  expect((await db.secret.findUniqueOrThrow({where:{id:secretId}})).metadata).toEqual({label:'chosen'});
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
   expect(JSON.stringify(await db.secretEvent.findMany({where:{secretId}}))).not.toContain(canary);
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
