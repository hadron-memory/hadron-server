/** #3998 S3: issueSecretReadClient makes the pending secret.reveal grant and its client together, for a person who may issue. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { resolvers, type Context } from './resolvers.js';

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

  it('an auto-delete mark needs a window or a budget, and then stores the delete mark', async () => {
    expect(await code(issue(ownerId, { autoDelete: true }))).toBe('SECRET_AUTO_DELETE_NEEDS_LIMIT');
    const r: any = await issue(ownerId, { autoDelete: true, maxReads: 1 });
    expect((await db.grant.findUniqueOrThrow({ where: { id: r.grantId } })).values).toEqual({ secret: secretId, 'auto-delete': 'delete' });
  });

  it('a person holder is only the issuer themself', async () => {
    expect(await code(issue(ownerId, { holderRef: memberId }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
  });

  it('refuses a missing secret exactly as it refuses someone who may not issue', async () => {
    const missing = await code(resolvers.Mutation.issueSecretReadClient({}, { input: { secretRef: generateId(), holderKind: 'USER', autoDelete: false, reason: 'r' } }, ctxOf(ownerId)));
    expect(missing).toBe(await code(issue(outsiderId)));
  });
});
