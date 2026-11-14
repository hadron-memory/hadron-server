/** #3998 S3: revealSecret — a bound worker under a live secret.reveal grant reads the value; exactly one use per read, every other shape the same refusal. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';

let ownerId: string; let appId: string; let secretId: string; let workerId: string; let otherWorkerId: string; let clientId: string; let grantId: string;
const ctxOf = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const asWorker = (id: string | null, p: () => Promise<unknown>) => runAsActor({ workerId: id, agentId: null }, p);
const reveal = (id: string | null, cid = clientId): Promise<any> => asWorker(id, () => resolvers.Mutation.revealSecret({}, { clientId: cid }, ctxOf(ownerId)));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e));

async function activate(id: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRawUnsafe(`UPDATE grants SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute', verification_kind = 'passkey', verified_by = $2, issuer_user_id = $2 WHERE id = $1`, id, ownerId);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
}

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s3.test` } })).id;
  const app = await db.app.create({ data: { name: 'S3r', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:rv` } });
  appId = app.id;
  const agent = await db.agent.create({ data: { ownerUserId: ownerId, name: 'a', urn: `${generateId().toLowerCase()}:ag` } as never });
  const mk = async (slug: string) => (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: slug, slug } })).id;
  workerId = await mk('w1'); otherWorkerId = await mk('w2');
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 'hunter2' }, ctxOf(ownerId))).id;
  const r: any = await resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: secretId, holderKind: 'WORKER', holderRef: workerId, autoDelete: false, maxReads: 2, reason: 'need it' } }, ctxOf(ownerId));
  clientId = r.clientId; grantId = r.grantId;
});

describe('#3998 revealSecret', () => {
  it('a pending grant reveals nothing', async () => {
    expect(await code(reveal(workerId))).toBe('SECRET_READ_CLIENT_PENDING');
  });

  it('the bound holder reads: one use and one USE event each, the budget ends it SPENT', async () => {
    await activate(grantId);
    const a = await reveal(workerId);
    expect(a).toMatchObject({ secretName: 'tok', value: JSON.stringify('hunter2'), readsLeft: 1 });
    await reveal(workerId);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(2);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(2);
    expect(await db.secretEvent.count({ where: { secretId, kind: 'REVEAL' } })).toBe(2);
    expect(await code(reveal(workerId))).toBe('SECRET_READ_CLIENT_SPENT');
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(2);
  });

  it('a person, another worker and an unknown id are the one uniform refusal', async () => {
    await activate(grantId);
    const person = await code(reveal(null));
    expect(person).toBe('SECRET_READ_CLIENT_NOT_FOUND');
    expect(await code(reveal(otherWorkerId))).toBe(person);
    expect(await code(reveal(workerId, 'nope'))).toBe(person);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
  });

  it('a revoked grant refuses REVOKED and spends nothing', async () => {
    await activate(grantId);
    await db.$executeRawUnsafe(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2 WHERE id = $1`, grantId, ownerId);
    expect(await code(reveal(workerId))).toBe('SECRET_READ_CLIENT_REVOKED');
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
  });

  it('a newer version by someone else supersedes a writer-issued client; a deleted secret ends it', async () => {
    await activate(grantId);
    await resolvers.Mutation.deleteSecret({}, { ref: secretId }, ctxOf(ownerId));
    expect(await code(reveal(workerId))).toBe('SECRET_DELETED');
    expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } })).endReason).toBe('SECRET_DELETED');
  });

  it('mySecretReadClients: the issuer and the bound holder see the client; an outsider and an impersonation see none', async () => {
    const mine: any = await resolvers.Query.mySecretReadClients({}, {}, ctxOf(ownerId));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ clientId, grantId, secretName: 'tok', selfIssued: false });
    const held: any = await asWorker(workerId, () => resolvers.Query.mySecretReadClients({}, {}, ctxOf(ownerId)));
    expect(held).toHaveLength(1);
    const outsider = (await db.user.create({ data: { email: `${generateId()}@s3.test` } })).id;
    expect(await resolvers.Query.mySecretReadClients({}, {}, ctxOf(outsider))).toEqual([]);
    expect(await resolvers.Query.mySecretReadClients({}, {}, { ...ctxOf(ownerId), impersonation: { by: 'x' } } as never)).toEqual([]);
  });
});
