/** #3998 split B+C: client metadata has its own audience and uses current grant identities. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { judgeSecretReadClientIssuer } from '../../../lib/secrets/readClientIssuer.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { deploymentSchema } from './deploymentSchema.js';
import { buildSchema } from 'graphql';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
beforeAll(() => server.start());
afterAll(() => server.stop());
let ownerId: string; let orgId: string; let appId: string; let secretId: string;
let workerId: string; let otherWorkerId: string; let clientId: string; let grantId: string;
const ctx = (userId = ownerId, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra });
const asWorker = <T>(id: string | null, fn: () => Promise<T>) => runAsActor({ workerId: id, agentId: null }, fn);

async function issue(holderRef = workerId, issuer = ownerId) {
  return resolvers.Mutation.issueSecretReadClient({}, { input: {
    secretRef: secretId, holderKind: 'WORKER', holderRef, autoDelete: false, maxReads: 2, reason: 'test',
  } }, ctx(issuer));
}
async function activate(id = grantId, issuer = ownerId) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRawUnsafe(`UPDATE grants SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute',
      verification_kind = 'passkey', verified_by = $2, issuer_user_id = $2 WHERE id = $1`, id, issuer);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
}
async function exec(source: string, caller = ctx()) {
  const r = await server.executeOperation({ query: source }, { contextValue: caller });
  if (r.body.kind !== 'single') throw new Error('single result required');
  return r.body.singleResult;
}
const clients = (args = '', caller = ctx()) => exec(`{ secret(ref:"${secretId}") {
  readClients(${args || 'limit:20'}) { total hasMore items { clientId clientPrefix grantId startsAt expiresAt maxReads readCount destroyOnEnd endReason } }
} }`, caller);

beforeEach(async () => {
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  ownerId = (await db.user.create({ data: { handle: `bc-${generateId()}` } })).id;
  orgId = (await db.organization.create({ data: { name: 'B+C', urn: `bc-${generateId()}.test` } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: ownerId, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { name: 'B+C', urn: `bc-${generateId()}:app`, organizationId: orgId } })).id;
  const agent = await db.agent.create({ data: { name: 'Worker agent', urn: `bc-${generateId()}:agent`, organizationId: orgId } });
  const worker = async (slug: string) => (await db.worker.create({ data: {
    ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: slug, slug,
  } })).id;
  workerId = await worker('one'); otherWorkerId = await worker('two');
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'bc', kind: 'generic', value: 'bc-canary' }, ctx())).id;
  const created = await issue(); clientId = created.clientId; grantId = created.grantId;
});

describe('#3998 B client audience and grant-derived projections', () => {
  it('shows managers only a prefix for another issuer/holder client, and the issuer its full id', async () => {
    const manager = await db.user.create({ data: { handle: `mgr-${generateId()}` } });
    await db.appMember.create({ data: { appId, userId: manager.id, role: 'owner' } });
    const theirs = await clients('', ctx(manager.id));
    expect(theirs.errors).toBeUndefined();
    const page = (theirs.data?.secret as any).readClients;
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ clientId: null, clientPrefix: clientId.slice(0, 8), maxReads: 2, readCount: 0, destroyOnEnd: false });
    const mine = await clients();
    expect(mine.errors).toBeUndefined();
    expect((mine.data?.secret as any).readClients.items[0].clientId).toBe(clientId);
    const countOnly = await clients('limit:0');
    expect(countOnly.errors).toBeUndefined();
    expect((countOnly.data?.secret as any).readClients).toMatchObject({ items: [], total: 1, hasMore: true });
  });

  it('does not give ordinary members the client list, and activeOnly follows the grant counter', async () => {
    const member = await db.user.create({ data: { handle: `member-${generateId()}` } });
    await db.appMember.create({ data: { appId, userId: member.id, role: 'member' } });
    const hidden = await clients('', ctx(member.id));
    expect(hidden.errors).toBeUndefined();
    expect((hidden.data?.secret as any).readClients).toMatchObject({ items: [], total: 0 });
    await activate();
    const live = await clients('activeOnly:true');
    expect(live.errors).toBeUndefined();
    expect((live.data?.secret as any).readClients.total).toBe(1);
    await db.$executeRaw`UPDATE grants SET use_count = use_count + 1 WHERE id = ${grantId}`;
    await db.$executeRaw`UPDATE grants SET use_count = use_count + 1 WHERE id = ${grantId}`;
    const spent = await clients('activeOnly:true');
    expect(spent.errors).toBeUndefined();
    expect((spent.data?.secret as any).readClients.total).toBe(0);
    const history = await clients();
    expect((history.data?.secret as any).readClients.items[0]).toMatchObject({ readCount: 2, endReason: 'SPENT' });
  });

  it('a bound worker discovers only its own holder clients, not its driver\'s other clients', async () => {
    await issue(otherWorkerId);
    const mine = await asWorker(workerId, () => resolvers.Query.mySecretReadClients({}, {}, ctx()));
    expect(mine.map((r: any) => r.clientId)).toEqual([clientId]);
  });

  it('App keys and impersonation see no client ids, including nested fields', async () => {
    await activate();
    for (const extra of [{ appId, appKeyId: 'test-key' }, { impersonation: { by: 'operator' } }]) {
      const caller = ctx(ownerId, extra as Partial<Context>);
      expect(await resolvers.Query.mySecretReadClients({}, {}, caller)).toEqual([]);
      const result = await clients('', caller);
      expect(result.errors).toBeUndefined();
      expect(result.data?.secret).toBeNull();
      await expect(asWorker(workerId, () => resolvers.Mutation.revealSecret({}, { clientId }, caller))).rejects.toBeDefined();
    }
    const permitted = await asWorker(workerId, () => resolvers.Mutation.revealSecret({}, { clientId }, ctx()));
    expect(permitted).toMatchObject({ value: expect.stringContaining('bc-canary') });
  });

  it('removes secret signing-dependent doors from the deployment schema when signing is off', () => {
    const previous = process.env.PASSKEY_SIGNING_ENABLED;
    process.env.PASSKEY_SIGNING_ENABLED = 'false';
    try {
      const fields = buildSchema(deploymentSchema().typeDefs).getMutationType()!.getFields();
      expect(fields).not.toHaveProperty('issueSecretReadClient');
      expect(fields).not.toHaveProperty('revealSecret');
    } finally {
      if (previous === undefined) delete process.env.PASSKEY_SIGNING_ENABLED;
      else process.env.PASSKEY_SIGNING_ENABLED = previous;
    }
  });
});

describe('#3998 B+C org deletion and current identities', () => {
  it('a deleted org hides secret/client metadata and refuses a reveal without spending', async () => {
    await activate();
    await db.appMember.create({ data: { appId, userId: ownerId, role: 'owner' } });
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    await expect(judgeSecretReadClientIssuer(ctx(), ownerId, secretId)).rejects.toBeDefined();
    expect(await resolvers.Query.secret({}, { ref: secretId }, ctx())).toBeNull();
    expect(await resolvers.Query.mySecretReadClients({}, {}, ctx())).toEqual([]);
    await expect(asWorker(workerId, () => resolvers.Mutation.revealSecret({}, { clientId }, ctx()))).rejects.toBeDefined();
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(0);
  });

  it('account erasure keeps sealed attribution but removes current issuer visibility and refuses spending', async () => {
    await activate();
    const survivor = await db.user.create({ data: { handle: `remaining-${generateId()}` } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: survivor.id, role: 'ADMIN' } });
    await deleteUserAccount(db, { targetUserId: ownerId, actorUserId: ownerId });
    expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } })).issuerUserId).toBe(ownerId);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).issuerUserId).toBeNull();
    expect(await resolvers.Query.mySecretReadClients({}, {}, ctx(ownerId))).toEqual([]);
    const history = await clients('', ctx(survivor.id));
    expect(history.errors).toBeUndefined();
    expect((history.data?.secret as any).readClients.items[0]).toMatchObject({ clientId: null, endReason: 'ISSUER_GONE' });
    await expect(asWorker(workerId, () => resolvers.Mutation.revealSecret({}, { clientId }, ctx(survivor.id)))).rejects.toBeDefined();
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
  });

  it('judges the named issuer, never the holder\'s or driver\'s manager authority', async () => {
    const outsider = await db.user.create({ data: { handle: `out-${generateId()}` } });
    await expect(judgeSecretReadClientIssuer(ctx(), outsider.id, secretId)).rejects.toBeDefined();
  });

  it('a real merge retargets the current grant issuer while sealed client attribution stays put', async () => {
    await activate();
    const target = await db.user.create({ data: { handle: `survivor-${generateId()}` } });
    await mergeUsers(db, { sourceUserId: ownerId, targetUserId: target.id });
    expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } })).issuerUserId).toBe(ownerId);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).issuerUserId).toBe(target.id);
    const mine = await resolvers.Query.mySecretReadClients({}, {}, ctx(target.id));
    expect(mine.map((r: any) => r.clientId)).toContain(clientId);
    expect(await resolvers.Query.mySecretReadClients({}, {}, ctx(ownerId))).toEqual([]);
  });
});
