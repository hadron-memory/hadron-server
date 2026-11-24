/** #3998 S3: issueSecretReadClient makes the pending secret.reveal grant and its client together, for a person who may issue. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { createPendingGrant } from '../../../lib/grants/create.js';
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
  it('issues an App-held use client with signed binding, and rejects a mismatched header', async () => {
    const s = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'fetch', kind: 'webfetch-auth', metadata: { urlPrefix: 'https://api.example.test/v1/' }, value: { type: 'bearer', token: 'private' } }, ctxOf(ownerId));
    const binding = { secretRef: s.id, mode: 'USE', holderKind: 'APP', holderRef: appId, bindingPrefix: 'https://api.example.test/v1/', bindingHeader: 'Authorization' };
    const result: any = await issue(ownerId, binding);
    const grant = await db.grant.findUniqueOrThrow({ where: { id: result.grantId } });
    expect(grant).toMatchObject({ action: 'secret.use', granteeAppId: appId, activatedAt: null });
    expect(grant.values).toEqual({ secret: s.id, 'auto-delete': 'keep', 'binding-prefix': binding.bindingPrefix, 'binding-header': binding.bindingHeader });
    expect(await db.secretReadClient.count({ where: { grantId: result.grantId, secretId: s.id } })).toBe(1);
    expect(await code(issue(ownerId, { ...binding, bindingHeader: 'X-Other' }))).toBe('GRANT_VALUES_INVALID');
    expect(await db.secretReadClient.count({ where: { secretId: s.id } })).toBe(1);
  });

  it('the generic grant door also rejects a use header that does not match the payload', async () => {
    const s = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'fetch', kind: 'webfetch-auth', metadata: { urlPrefix: 'https://api.example.test/v1/' }, value: { type: 'bearer', token: 'private' } }, ctxOf(ownerId));
    await expect(db.$transaction((tx) => createPendingGrant(tx, { appId, requester: { userId: ownerId, workerId: null, sessionId: null }, holder: { kind: 'app', id: appId }, action: 'secret.use', values: { secret: s.id, 'auto-delete': 'keep', 'binding-prefix': 'https://api.example.test/v1/', 'binding-header': 'X-Other' }, reason: 'r', canReadMemory: async () => false }))).rejects.toMatchObject({ code: 'GRANT_VALUES_INVALID' });
    expect(await db.grant.count()).toBe(0);
  });

  it('does not allow a use client for a person, worker, or another App', async () => {
    const binding = { mode: 'USE', bindingPrefix: 'https://api.example.test/v1/', bindingHeader: 'Authorization' };
    for (const holderKind of ['USER', 'WORKER']) {
      expect(await code(issue(ownerId, { ...binding, holderKind }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    }
    const s = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'fetch', kind: 'webfetch-auth', metadata: { urlPrefix: 'https://api.example.test/v1/' }, value: { type: 'bearer', token: 'private' } }, ctxOf(ownerId));
    expect(await code(issue(ownerId, { ...binding, secretRef: s.id, holderKind: 'APP', holderRef: generateId() }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await db.grant.count()).toBe(0);
  });

  it('issues a use client for an installed agent, but not an unknown agent', async () => {
    const org = await db.organization.create({ data: { name: 's5', urn: `${generateId().toLowerCase()}.test` } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: ownerId, role: 'ADMIN' } });
    await db.app.update({ where: { id: appId }, data: { organizationId: org.id, ownerUserId: null } });
    const agent = await db.agent.create({ data: { organizationId: org.id, name: 's5', urn: `${org.urn}:a`, visibility: 'ORGANIZATION' } });
    await db.appAgent.create({ data: { appId, agentId: agent.id } });
    const s = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'fetch', kind: 'webfetch-auth', metadata: { urlPrefix: 'https://api.example.test/v1/' }, value: { type: 'bearer', token: 'private' } }, ctxOf(ownerId));
    const binding = { secretRef: s.id, mode: 'USE', holderKind: 'AGENT', bindingPrefix: 'https://api.example.test/v1/', bindingHeader: 'Authorization' };
    const result: any = await issue(ownerId, { ...binding, holderRef: agent.id });
    expect(await db.grant.findUniqueOrThrow({ where: { id: result.grantId } })).toMatchObject({ agentId: agent.id, action: 'secret.use' });
    expect(await code(issue(ownerId, { ...binding, holderRef: generateId() }))).toBe('GRANT_HOLDER_NOT_ALLOWED');
  });
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

  it('S6 admits a bounded mark and refuses an unbounded mark without writing', async () => {
    expect(await code(issue(ownerId, { autoDelete: true }))).toBe('SECRET_AUTO_DELETE_NEEDS_LIMIT');
    expect(await db.grant.count()).toBe(0);
    expect(await db.secretReadClient.count()).toBe(0);
    expect(await code(issue(ownerId, { autoDelete: true, maxReads: 1 }))).toBe('OK');
  });

  it('the S6 finite-limit rule distinguishes marked and unmarked terms', () => {
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
      // #4434: an agent holder is no longer an input refusal, so an outsider gets the plain uniform FORBIDDEN for it, existing secret or not.
      ['agent holder', { holderKind: 'AGENT', holderRef: generateId() }, 'FORBIDDEN'],
      ['app holder', { holderKind: 'APP' }, 'GRANT_HOLDER_NOT_ALLOWED'],
      ['auto-delete without a limit', { autoDelete: true }, 'SECRET_AUTO_DELETE_NEEDS_LIMIT'],
      ['auto-delete with a limit', { autoDelete: true, maxReads: 1 }, 'SECRET_AUTO_DELETE_NOT_ALLOWED'],
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
