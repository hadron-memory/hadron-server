/** #4000: the run's use spend is atomic with its ticket and never grants another App or agent access. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from '../grants/actions.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import type { RunToolContext } from '../runner/tools/types.js';
import { prepareSecretUse } from './readClientReveal.js';
let runCtx: RunToolContext;
let grantId: string; let clientId: string; let orgId: string; let appId: string;
beforeEach(async () => {
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  const user = await db.user.create({ data: { handle: `s5-${generateId()}` } });
  const org = await db.organization.create({ data: { name: 'S5', urn: `s5-${generateId()}.test` } }); orgId = org.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'S5', urn: `s5-${generateId()}.test:app`, organizationId: org.id } }); appId = app.id;
  const agent = await db.agent.create({ data: { name: 'S5', urn: `s5-${generateId()}.test:agent`, organizationId: org.id } });
  const ctx: Context = { db, userId: user.id, roles: [] };
  const secret = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: app.id, name: 'token', kind: 'webfetch-auth',
    metadata: { urlPrefix: 'https://api.example.test/v1' }, value: { type: 'bearer', token: 'synthetic-canary' } }, ctx);
  grantId = generateId(); clientId = generateId();
  await db.$executeRaw`INSERT INTO grants (id, app_id, grantee_app_id, action, action_values, reason, max_uses, created_at, updated_at)
    VALUES (${grantId}, ${app.id}, ${app.id}, 'secret.use', ${JSON.stringify({ secret: secret.id, 'auto-delete': 'keep', 'binding-prefix': 'https://api.example.test/v1', 'binding-header': 'Authorization' })}::jsonb, 'test', 1, now(), now())`;
  await db.secretReadClient.create({ data: { id: clientId, grantId, appId: app.id, secretId: secret.id, secretName: 'token', issuerUserId: user.id, selfIssued: false } });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRaw`UPDATE grants SET activated_at = now(), verification_kind = 'passkey', verified_by = ${user.id}, issuer_user_id = ${user.id} WHERE id = ${grantId}`;
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, agentId: agent.id, triggerKind: 'MANUAL', status: 'RUNNING', budgetActions: 3, entryNodeUrn: 'hrn:node:example.test:flows:start' } });
  runCtx = { db, run, principal: { db, appId: app.id, organizationId: org.id, clientId: `run:${run.id}`, roles: [] }, log: () => {} };
});
const prepare = (ctx = runCtx) => prepareSecretUse(ctx, clientId, 'https://api.example.test/v1/orders', {});
describe('transactional secret.use (#4000)', () => {
  it('refuses without a ticket and spends neither grant nor event', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'comm.outbound', mintedBy: 'test' } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'ACTION_TICKET_REQUIRED' } });
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(0);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } })).budgetActions).toBe(3);
  });
  it('refuses targets and model-supplied bound headers without spending a ticket', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await expect(prepareSecretUse(runCtx, clientId, 'https://api.example.test/v10', {})).rejects.toBeDefined();
    await expect(prepareSecretUse(runCtx, clientId, 'https://api.example.test/v1', { AUTHORIZATION: 'override' })).rejects.toBeDefined();
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('does not let later metadata widen the signed path or disagree with the encrypted kind', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    const client = await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } });
    await db.secret.update({ where: { id: client.secretId }, data: { metadata: { type: 'bearer', urlPrefix: 'https://api.example.test/' } } });
    await expect(prepareSecretUse(runCtx, clientId, 'https://api.example.test/admin', {})).rejects.toBeDefined();
    await db.secret.update({ where: { id: client.secretId }, data: { metadata: { type: 'basic', urlPrefix: 'https://api.example.test/' } } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('conceals wrong-holder, wrong-action and cross-App runs without spending', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    const other = await db.app.create({ data: { name: 'other', urn: `other-${generateId()}.test:app`, organizationId: orgId } });
    const foreignRun = await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId: other.id, agentId: runCtx.run.agentId, triggerKind: 'MANUAL', status: 'RUNNING', entryNodeUrn: 'hrn:node:example.test:flows:start' } });
    const foreign: RunToolContext = { ...runCtx, run: foreignRun, principal: { ...runCtx.principal, appId: other.id, clientId: `run:${foreignRun.id}` } };
    await expect(prepare(foreign)).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    const holder = await db.user.create({ data: { handle: `s5-holder-${generateId()}` } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET grantee_app_id = NULL, user_id = ${holder.id} WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET grantee_app_id = ${appId}, user_id = NULL, action = 'secret.reveal' WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('accepts the run agent only and refuses a different agent holder', async () => {
    const other = await db.agent.create({ data: { name: 'other', urn: `other-${generateId()}.test:agent`, organizationId: orgId } });
    await db.actionTicket.createMany({ data: [generateId(), generateId()].map((id) => ({ id, organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' })) });
    const setHolder = (id: string) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET grantee_app_id = NULL, agent_id = ${id} WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await setHolder(other.id);
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
    await setHolder(runCtx.run.agentId!);
    await expect(prepare()).resolves.toMatchObject({ auth: { type: 'bearer' } });
  });
  it('serializes a one-use grant against concurrent uses without spending a second ticket', async () => {
    await db.actionTicket.createMany({ data: [generateId(), generateId()].map((id) => ({ id, organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' })) });
    const outcomes = await Promise.allSettled([prepare(), prepare()]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(1);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(1);
  });
  it('commits exactly one grant use and one matching ticket before returning auth', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await expect(prepare()).resolves.toMatchObject({ auth: { type: 'bearer', token: 'synthetic-canary' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(1);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(1);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } })).budgetActions).toBe(2);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, action: 'secret.use', consumedByRunId: runCtx.run.id } })).toBe(1);
    await expect(prepare()).rejects.toBeDefined();
  });
});
