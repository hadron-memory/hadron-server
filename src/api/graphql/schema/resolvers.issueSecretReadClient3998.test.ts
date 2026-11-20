/** #3998 S3: issueSecretReadClient makes the pending secret.reveal grant and its client together, for a person who may issue. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { autoDeleteLimitRefusal } from './resolvers.secret.js';

let ownerId: string; let memberId: string; let outsiderId: string; let appId: string; let secretId: string; let workerId: string;
const ctxOf = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const issue = (userId: string, over: Record<string, unknown> = {}) => resolvers.Mutation.issueSecretReadClient({}, {
  input: { secretRef: secretId, holderKind: 'USER', autoDelete: false, reason: 'need it', ...over },
}, ctxOf(userId));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: { extensions?: { code?: string } }) => e.extensions?.code ?? String(e));

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s3.test` } })).id;
  memberId = (await db.user.create({ data: { email: `${generateId()}@s3.test` } })).id;
  outsiderId = (await db.user.create({ data: { email: `${generateId()}@s3.test` } })).id;
  appId = (await db.app.create({ data: { name: 'S3', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:rc` } })).id;
  await db.appMember.create({ data: { appId, userId: memberId, role: 'reader' } });
  const s = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 'v1' }, ctxOf(memberId));
  secretId = s.id;
});

describe('#3998 issueSecretReadClient', () => {
  it('a manager issues to themself: one pending grant and one client, marked self-issued', async () => {
    const r: any = await issue(ownerId);
    expect(r).toMatchObject({ secretName: 'tok', selfIssued: true });
    const g = await db.grant.findUniqueOrThrow({ where: { id: r.grantId } });
    expect(g).toMatchObject({ action: 'secret.reveal', userId: ownerId, activatedAt: null, appId });
    expect(g.values).toEqual({ secret: secretId, 'auto-delete': 'keep' });
    expect(await db.secretReadClient.count({ where: { grantId: r.grantId, secretId, issuerUserId: ownerId } })).toBe(1);
  });

  it('the writer of the current version issues; a member who wrote nothing and an outsider are refused alike', async () => {
    await expect(issue(memberId)).resolves.toMatchObject({ selfIssued: true });
    const other = (await db.user.create({ data: { email: `${generateId()}@s3.test` } })).id;
    await db.appMember.create({ data: { appId, userId: other, role: 'reader' } });
    const a = await code(issue(other)); const b = await code(issue(outsiderId));
    expect(a).toBe(b);
    expect(await db.grant.count()).toBe(1);
  });

  it('a superseded writer is refused SECRET_READ_CLIENT_SUPERSEDED and stores nothing', async () => {
    await resolvers.Mutation.updateSecret({}, { ref: secretId, value: 'v2' }, ctxOf(ownerId));
    expect(await code(issue(memberId))).toBe('SECRET_READ_CLIENT_SUPERSEDED');
    expect(await db.grant.count()).toBe(0);
  });

  it('an auto-delete mark is refused until S6 consumes it (#4001), with or without a limit, and nothing is written', async () => {
    // NOT_AVAILABLE is judged first (#4443 item 6): a caller is not told to add a limit only to be refused after adding one. Signed but
    // not consumed: refused with a typed code, nothing written. S6 removes this guard; the NEEDS_LIMIT rule is pinned by the pure-function test below.
    expect(await code(issue(ownerId, { autoDelete: true }))).toBe('SECRET_AUTO_DELETE_NOT_AVAILABLE');
    expect(await code(issue(ownerId, { autoDelete: true, maxReads: 1 }))).toBe('SECRET_AUTO_DELETE_NOT_AVAILABLE');
    expect(await db.grant.count()).toBe(0);
    expect(await db.secretReadClient.count()).toBe(0);
  });

  it('the limit rule is pinned now, while NOT_AVAILABLE shadows it: S6 turns it on with a test already in place', () => {
    const NEEDS = { code: 'SECRET_AUTO_DELETE_NEEDS_LIMIT' };
    expect(autoDeleteLimitRefusal(true, null, null)).toMatchObject(NEEDS);
    expect(autoDeleteLimitRefusal(true, new Date(), null)).toBeNull();
    expect(autoDeleteLimitRefusal(true, null, 0)).toBeNull();
    expect(autoDeleteLimitRefusal(true, null, 1)).toBeNull();
    expect(autoDeleteLimitRefusal(false, null, null)).toBeNull();
  });

  it('S4 admits a different live person holder and refuses a nonmember', async () => {
    expect(await issue(ownerId, { holderRef: memberId })).toMatchObject({selfIssued:false});
    expect(await code(issue(ownerId, { holderRef: outsiderId }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
  });

  it.each(['former', 'deleted'])('refuses a %s person holder with the exact holder code and no writes', async state => {
    if(state === 'former') await db.appMember.deleteMany({where:{appId,userId:memberId}});
    else await db.user.update({where:{id:memberId},data:{deletedAt:new Date()}});
    expect(await code(issue(ownerId,{holderRef:memberId}))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await db.grant.count()).toBe(0);expect(await db.secretReadClient.count()).toBe(0);
  });

  it.each(['AGENT', 'APP'])('refuses a %s holder before any write (#4434: agent-held reads are not built)', async (holderKind) => {
    // A REAL worker of the App: without the early refusal the holder would be read as a worker and the client would be made.
    const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: `${generateId().toLowerCase()}.test` } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a`, visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId, agentId: agent.id } });
    workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Liam', slug: 'liam', heldByUserId: ownerId, heldAt: new Date() }, select: { id: true } })).id;
    const before = await db.grant.count();
    expect(await code(issue(ownerId, { holderKind, holderRef: workerId }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await db.grant.count()).toBe(before);
    expect(await db.secretReadClient.count()).toBe(0);
  });

  it('refuses a missing secret exactly as it refuses someone who may not issue', async () => {
    const missing = await code(resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: generateId(), holderKind: 'USER', autoDelete: false, reason: 'r' } }, ctxOf(ownerId)));
    expect(missing).toBe(await code(issue(outsiderId)));
  });

  it('input refusals do not tell an outsider whether a secret exists (existence oracle)', async () => {
    const as = (userId: string, ref: string, over: Record<string, unknown>) => code(resolvers.Mutation.issueSecretReadClient({}, {
      input: { secretRef: ref, holderKind: 'USER', autoDelete: false, reason: 'r', ...over },
    }, ctxOf(userId)));
    // Each row also names the SPECIFIC code it must get (#4443 item 5): removing one guard changes that row's code, so it cannot pass
    // vacuously as two equal FORBIDDENs. The 'bad time' row is refused by `asTime` (BAD_USER_INPUT) because the test calls the resolver
    // directly, so GraphQL DateTime coercion is not in play (item 9). The cases make 12 calls under one identity, well inside the
    // WRITES class limit of 600 a minute (item 8).
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['agent holder', { holderKind: 'AGENT', holderRef: generateId() }, 'GRANT_HOLDER_NOT_ALLOWED'],
      ['app holder', { holderKind: 'APP' }, 'GRANT_HOLDER_NOT_ALLOWED'],
      ['auto-delete without a limit', { autoDelete: true }, 'SECRET_AUTO_DELETE_NOT_AVAILABLE'],
      ['auto-delete with a limit', { autoDelete: true, maxReads: 1 }, 'SECRET_AUTO_DELETE_NOT_AVAILABLE'],
      ['bad time', { expiresAt: 'not-a-date' }, 'BAD_USER_INPUT'],
      ['plain', {}, 'FORBIDDEN'],
    ];
    for (const [label, over, expected] of cases) {
      const existing = await as(outsiderId, secretId, over);
      const missing = await as(outsiderId, generateId(), over);
      expect(existing, label).toBe(missing);
      expect(existing, `${label} code`).toBe(expected);
    }
  });
});
