/**
 * #4003 (S8 of #3991), acceptance: "A read client pinned to a version keeps refusing with the superseded code open question 21
 * settles (`SECRET_READ_CLIENT_SUPERSEDED`) after its version is purged, never with `NOT_FOUND`."
 *
 * A former writer's client is judged again at every read (Q21). Before S8 the judge proved "this person wrote an earlier
 * version" from the surviving version rows alone, so once the retention purge deleted the writer's version, the client fell
 * through to the generic refusal (ISSUER_GONE on the reveal, the uniform authorization refusal on a new issue). The writer's
 * STORE / VERSION events outlive the purge (kept for the App's life, R25), and they are the proof that survives.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from '../grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { runAsActor } from '../requestActor.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { purgeSupersededVersions } from './purge.js';

let ownerId: string; let memberId: string; let bystanderId: string; let appId: string; let secretId: string; let workerId: string;
let clientId: string; let grantId: string;
const ctxOf = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e));
const reveal = () => runAsActor({ workerId, agentId: null }, () => resolvers.Mutation.revealSecret({}, { clientId }, ctxOf(ownerId)));
const issueAs = (userId: string) => resolvers.Mutation.issueSecretReadClient({}, {
  input: { secretRef: secretId, holderKind: 'USER', autoDelete: false, reason: 'need it' },
}, ctxOf(userId));

async function activate(id: string, issuer: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRawUnsafe(`UPDATE grants SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute', verification_kind = 'passkey', verified_by = $2, issuer_user_id = $2 WHERE id = $1`, id, issuer);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
}

/** Age every superseded version of the secret past the 30-day window, then run the purge. */
async function purgeOld() {
  await db.$executeRaw`UPDATE secret_versions SET superseded_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '31 days'
    WHERE secret_id = ${secretId} AND superseded_at IS NOT NULL`;
  return purgeSupersededVersions(db);
}

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  delete process.env.SECRET_VERSION_RETENTION_DAYS;
  await cleanDb(db); await upsertPlatformActions(db);
  const mk = async () => (await db.user.create({ data: { email: `${generateId()}@s8.test` } })).id;
  [ownerId, memberId, bystanderId] = [await mk(), await mk(), await mk()];
  appId = (await db.app.create({ data: { name: 'S8', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:pr` } })).id;
  for (const u of [memberId, bystanderId]) await db.appMember.create({ data: { appId, userId: u, role: 'reader' } });
  const agent = await db.agent.create({ data: { ownerUserId: ownerId, name: 'a', urn: `${generateId().toLowerCase()}:ag` } as never });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'w1', slug: 'w1' } })).id;
  // The member writes version 1 and issues a client for it as its writer.
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 'v1' }, ctxOf(memberId))).id;
  const r: any = await resolvers.Mutation.issueSecretReadClient({}, {
    input: { secretRef: secretId, holderKind: 'WORKER', holderRef: workerId, autoDelete: false, maxReads: 5, reason: 'need it' },
  }, ctxOf(memberId));
  clientId = r.clientId; grantId = r.grantId;
  await activate(grantId, memberId);
  // The owner writes version 2: the member's client is now superseded.
  await resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'v2' }, ctxOf(ownerId));
});

describe('#4003 a superseded writer\'s client after its version is purged', () => {
  it('the reveal keeps refusing SECRET_READ_CLIENT_SUPERSEDED once version 1 is purged', async () => {
    expect(await code(reveal())).toBe('SECRET_READ_CLIENT_SUPERSEDED');
    expect((await purgeOld()).purged).toBe(1);
    expect(await db.secretVersion.count({ where: { secretId, versionNo: 1 } })).toBe(0);
    expect(await code(reveal())).toBe('SECRET_READ_CLIENT_SUPERSEDED');
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
  });

  it('a new issue by the former writer is refused SECRET_READ_CLIENT_SUPERSEDED after the purge too', async () => {
    await purgeOld();
    expect(await code(issueAs(memberId))).toBe('SECRET_READ_CLIENT_SUPERSEDED');
  });

  it('a member who never wrote still gets the uniform refusal after the purge (the events prove only authorship)', async () => {
    await purgeOld();
    const bystander = await code(issueAs(bystanderId));
    expect(bystander).not.toBe('OK');
    expect(bystander).not.toBe('SECRET_READ_CLIENT_SUPERSEDED');
  });

  // #4573 (#4553 §10 F3, mutants I2 and I3): the bystander never wrote. Any other event of theirs, or a write that did not happen, proves nothing.
  it.each([
    ['another kind', { kind: 'PURGE', outcome: 'OK' }],
    ['a refused store', { kind: 'STORE', outcome: 'REFUSED' }],
    ['a refused version', { kind: 'VERSION', outcome: 'REFUSED' }],
  ])('%s naming the caller is no proof of authorship', async (_n, event) => {
    await purgeOld();
    const add = (e: { kind: string; outcome: string }) => db.secretEvent.create({
      data: { ownerType: 'app', ownerId: appId, secretId, secretName: 'tok', versionNo: 1, actorUserId: bystanderId, ...e },
    });
    const plain = await code(issueAs(bystanderId));
    await add(event);
    expect(await code(issueAs(bystanderId))).toBe(plain);
    expect(plain).not.toBe('SECRET_READ_CLIENT_SUPERSEDED');
    // Control: the same row with a write kind and an OK outcome IS the proof, so the assertion above is not vacuous.
    await add({ kind: 'VERSION', outcome: 'OK' });
    expect(await code(issueAs(bystanderId))).toBe('SECRET_READ_CLIENT_SUPERSEDED');
  });

  it('a version a worker wrote proves nothing for its driver after the purge', async () => {
    // The member drives a worker that writes version 3 (a worker write has no person writer, Q21); the owner then writes 4.
    await runAsActor({ workerId, agentId: null }, () => resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'v3' }, ctxOf(bystanderId)));
    await resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'v4' }, ctxOf(ownerId));
    await purgeOld();
    expect(await code(issueAs(bystanderId))).not.toBe('SECRET_READ_CLIENT_SUPERSEDED');
  });
});
