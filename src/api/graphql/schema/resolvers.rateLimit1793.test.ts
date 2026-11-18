import { beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
const READ = `query { rateLimitPolicies { fieldClass principalLimit keyLimit ipLimit windowSeconds retentionSeconds enforcementMode version } }`;
const SET = `mutation($input: SetRateLimitPolicyInput!) { setRateLimitPolicy(input:$input) { fieldClass principalLimit keyLimit ipLimit enforcementMode version } }`;
let userId: string;
async function gql(query: string, input?: unknown, extra: Partial<Context> = {}) {
  const r = await server.executeOperation({ query, variables: input ? { input } : undefined },
    { contextValue: { db, userId, roles: ['ADMIN'], ...extra } as Context });
  if (r.body.kind !== 'single') throw new Error('single response required');
  return r.body.singleResult;
}
beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { id: generateId(), githubId: 179300, githubUsername: 'rate-admin', roles: ['ADMIN'] } })).id;
});
describe('#1793 admin policy contract', () => {
  it('deploys five configured classes LOG_ONLY without public counters', async () => {
    const r = await gql(READ);
    expect(r.errors).toBeUndefined();
    const rows = (r.data as any).rateLimitPolicies;
    expect(rows).toHaveLength(5);
    expect(rows.every((p: any) => p.enforcementMode === 'LOG_ONLY')).toBe(true);
    expect(rows.find((p: any) => p.fieldClass === 'FAN_OUT_READS')).toMatchObject({ principalLimit: 300, keyLimit: 120, ipLimit: 600, windowSeconds: 60, retentionSeconds: 86400 });
  });
  it('null mode preserves and a no-op never bumps version; a stale writer conflicts', async () => {
    const initial = await gql(READ);
    expect(initial.errors).toBeUndefined();
    const p = (initial.data as any).rateLimitPolicies.find((p: any) => p.fieldClass === 'FAN_OUT_READS');
    const input = { fieldClass: p.fieldClass, expectedVersion: p.version, principalLimit: p.principalLimit, keyLimit: p.keyLimit, ipLimit: p.ipLimit, enforcementMode: null, changeReference: 'test review' };
    const noop = await gql(SET, input);
    expect(noop.errors).toBeUndefined();
    expect((noop.data as any).setRateLimitPolicy).toMatchObject({ enforcementMode: 'LOG_ONLY', version: p.version });
    expect(await db.rateLimitPolicyAudit.count()).toBe(0);
    const changed = await gql(SET, { ...input, principalLimit: 2, enforcementMode: 'ENFORCING' });
    expect(changed.errors).toBeUndefined();
    expect((changed.data as any).setRateLimitPolicy).toMatchObject({ principalLimit: 2, enforcementMode: 'ENFORCING', version: p.version + 1 });
    expect((await gql(SET, input)).errors?.[0].extensions?.code).toBe('CONFLICT');
    const keep = await gql(SET,{...input,expectedVersion:p.version+1,principalLimit:2,enforcementMode:null});
    expect(keep.errors).toBeUndefined();
    expect((keep.data as any).setRateLimitPolicy).toMatchObject({enforcementMode:'ENFORCING',version:p.version+1});
    expect(await db.rateLimitPolicyAudit.count()).toBe(1);
  });
  it('records the successful policy edit with its actor, exact before/after and change reference', async () => {
    expect((await gql(READ)).errors).toBeUndefined();
    const before = await db.rateLimitPolicy.findUniqueOrThrow({ where: { fieldClass: 'FAN_OUT_READS' } });
    const input = { fieldClass: before.fieldClass, expectedVersion: before.version,
      principalLimit: 27, keyLimit: 13, ipLimit: 41, enforcementMode: 'ENFORCING',
      changeReference: 'approved-change-1793-audit' };
    expect((await gql(SET, input)).errors).toBeUndefined();
    const after = await db.rateLimitPolicy.findUniqueOrThrow({ where: { fieldClass: before.fieldClass } });
    const projection = (p: typeof before) => ({ fieldClass: p.fieldClass,
      principalLimit: p.principalLimit, keyLimit: p.keyLimit, ipLimit: p.ipLimit,
      windowSeconds: p.windowSeconds, retentionSeconds: p.retentionSeconds,
      enforcementMode: p.enforcementMode, version: p.version,
      updatedAt: p.updatedAt.toISOString(), ipGroupingVersion: 'v1-ipv6-56' });
    const audit = await db.rateLimitPolicyAudit.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: userId, fieldClass: before.fieldClass,
      before: projection(before), after: projection(after), changeReference: input.changeReference });
    expect(after).toMatchObject({ principalLimit: 27, keyLimit: 13, ipLimit: 41,
      enforcementMode: 'ENFORCING', version: before.version + 1 });
  });
  it.each(['role', 'key'] as const)('refuses a policy mutation after its precheck when the presented %s is revoked, without policy or audit writes', async kind => {
    expect((await gql(READ)).errors).toBeUndefined();
    const before = await db.rateLimitPolicy.findMany({ orderBy: { fieldClass: 'asc' } });
    const policy = before.find(p => p.fieldClass === 'FAN_OUT_READS')!;
    const key = kind === 'key' ? await db.userApiKey.create({ data: { id: generateId(), userId,
      keyHash: 'rate-write-revocation-key', keyPreview: 'test', oauthScopes: [] } }) : null;
    let enteredTransaction = false;
    // The resolver reaches $transaction only AFTER requireRateAdmin(ctx).
    // Persist the demotion at that seam, before the real authorized transaction
    // reloads roles. No gate or transaction result is mocked.
    const demotingDb = new Proxy(db, { get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof db.$transaction>) => {
        expect(enteredTransaction).toBe(false);
        enteredTransaction = true;
        if (key) await db.userApiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
        else await db.user.update({ where: { id: userId }, data: { roles: ['READER'] } });
        return (db.$transaction as (...values: unknown[]) => Promise<unknown>)(...args);
      };
    } });
    const result = await gql(SET, { fieldClass: policy.fieldClass, expectedVersion: policy.version,
      principalLimit: 2, keyLimit: 3, ipLimit: 4, changeReference: 'must-not-be-written' }, { db: demotingDb, ...(key ? { apiKeyId: key.id } : {}) });
    expect(enteredTransaction).toBe(true);
    expect(result.errors?.[0].extensions?.code).toBe('FORBIDDEN');
    expect(await db.rateLimitPolicy.findMany({ orderBy: { fieldClass: 'asc' } })).toEqual(before);
    expect(await db.rateLimitPolicyAudit.count()).toBe(0);
  });
  it.each([{ appId: 'not-a-human' }, { sessionId: 'bound' }, { clientId: 'run:untrusted' }])('denies non-human admin context %j before policy reads', async extra => {
    const r = await gql(READ, undefined, extra);
    expect(r.errors?.[0].extensions?.code).toBe('FORBIDDEN');
  });
});

describe('#1793 real consumer refusals', () => {
  it('queues sibling search admissions before acquiring another pool transaction',async()=>{
    expect((await gql(READ)).errors).toBeUndefined();
    let calls=0,entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
    const countedDb=new Proxy(db,{get(target,key,receiver){
      if(key!=='$transaction')return Reflect.get(target,key,receiver);
      return async(callback:any,options:any)=>{
        const first=++calls===1;
        return db.$transaction(async tx=>{if(first){entered();await gate;}return callback(tx);},options);
      };
    }});
    const result=gql('query { first: findNodes(limit:0) { total } second: findNodes(limit:0) { total } }',undefined,{db:countedDb});
    await ready;
    let beforeRelease=0;
    try {await new Promise<void>(r=>setImmediate(r));beforeRelease=calls;}
    finally {release();}
    const response=await result;
    expect(beforeRelease).toBe(1);
    expect(response.errors).toBeUndefined();
    expect((await db.rateLimitBucket.findMany({where:{dimension:'principal'}})).map(r=>r.used)).toEqual([2n]);
  });
  it('charges aliases once each and refuses search before any retrieval', async () => {
    await gql(READ);
    await db.rateLimitPolicy.update({where:{fieldClass:'FAN_OUT_READS'},data:{principalLimit:1,enforcementMode:'ENFORCING'}});
    const r=await gql(`query { first: findNodes(limit:0) { total } second: findNodes(limit:0) { total } }`);
    expect(r.errors?.filter(e=>e.extensions?.code==='RATE_LIMITED')).toHaveLength(1);
    expect(r.errors?.find(e=>e.extensions?.code==='RATE_LIMITED')?.extensions).toMatchObject({fieldClass:'FAN_OUT_READS',retryAfterSeconds:expect.any(Number)});
    const buckets=await db.rateLimitBucket.findMany({where:{fieldClass:'FAN_OUT_READS'}});
    expect(buckets).toHaveLength(1);expect(buckets[0].used).toBe(1n);
  });
  it('consent admission shares the proof transaction and preserves its cap', async () => {
    const { transportRateIdentity }=await import('../../../lib/rateLimit/identity.js');
    const peer=(await db.user.create({data:{id:generateId(),githubId:179301,githubUsername:'rate-peer'}})).id;
    await gql(READ);
    await db.rateLimitPolicy.update({where:{fieldClass:'CREDENTIALS'},data:{principalLimit:1,enforcementMode:'ENFORCING'}});
    const c={limiterIdentity:transportRateIdentity({userId},'192.0.2.10')};
    const query=`mutation { beginMergeUsersConsent(source:"${userId}", target:"${peer}") { proof expiresAt } }`;
    expect((await gql(query,undefined,c)).errors).toBeUndefined();
    expect((await gql(query,undefined,c)).errors?.[0].extensions?.code).toBe('RATE_LIMITED');
    expect(await db.userMergeConsent.count()).toBe(1);
    expect((await db.rateLimitBucket.findMany()).every(r=>r.used===1n)).toBe(true);
  });
  it('real stored-role and presented-key revocation beat a claimed admin role', async () => {
    await db.user.update({where:{id:userId},data:{roles:['READER']}});
    expect((await gql(READ)).errors?.[0].extensions?.code).toBe('FORBIDDEN');
    await db.user.update({where:{id:userId},data:{roles:['ADMIN']}});
    const key=await db.userApiKey.create({data:{id:generateId(),userId,keyHash:'rate-test-hash',keyPreview:'test',oauthScopes:[],revokedAt:new Date()}});
    expect((await gql(READ,undefined,{apiKeyId:key.id})).errors?.[0].extensions?.code).toBe('FORBIDDEN');
  });
});

it('#1793 refuses invalid limits, immutable settings and arbitrary classes without edits',async()=>{
  const first=await gql(READ);expect(first.errors).toBeUndefined();
  const input={fieldClass:'FAN_OUT_READS',expectedVersion:1,principalLimit:1,keyLimit:1,ipLimit:1,changeReference:'reviewed'};
  expect((await gql(SET,{...input,principalLimit:0})).errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  expect((await gql(SET,{...input,windowSeconds:1})).errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  expect((await gql(SET,{...input,fieldClass:'ARBITRARY'})).errors).toBeDefined();
  expect((await gql(READ)).data).toEqual(first.data);
  expect(await db.rateLimitPolicyAudit.count()).toBe(0);
});

it.each([{sessionBindingRefused:true},{impersonation:{actorUserId:'actor',orgId:'org',sessionId:'imp',expiresAt:new Date()}}])('#1793 does not downgrade refused binding/impersonation into human admin: %j',async extra=>{
  expect((await gql(READ,undefined,extra)).errors?.[0].extensions?.code).toBe('FORBIDDEN');
});
it('#1793 live OWNER and live user-key may read without an org-admin substitute',async()=>{
  await db.user.update({where:{id:userId},data:{roles:['OWNER']}});
  const key=await db.userApiKey.create({data:{id:generateId(),userId,keyHash:'rate-live-key',keyPreview:'live',oauthScopes:[]}});
  expect((await gql(READ,undefined,{apiKeyId:key.id,roles:['OWNER']})).errors).toBeUndefined();
});
