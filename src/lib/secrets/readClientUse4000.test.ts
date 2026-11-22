/** #4000: the run's use spend is atomic with its ticket and never grants another App or agent access. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { upsertPlatformActions } from '../grants/actions.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import type { RunToolContext } from '../runner/tools/types.js';
import { prepareSecretUse, revealForPersonHolder } from './readClientReveal.js';
let runCtx: RunToolContext;
let grantId: string; let clientId: string; let orgId: string; let appId: string; let ownerId: string;
beforeEach(async () => {
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  const user = await db.user.create({ data: { handle: `s5-${generateId()}` } }); ownerId = user.id;
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
  it('refuses without a ticket, recording only the refusal audit', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'comm.outbound', mintedBy: 'test' } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'ACTION_TICKET_REQUIRED' } });
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(0);
    const audit = await db.secretEvent.findMany({ where: { clientId, kind: 'USE' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: 'ACTION_TICKET_REQUIRED', runId: runCtx.run.id });
    expect(JSON.stringify(audit)).not.toContain('synthetic-canary');
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } })).budgetActions).toBe(3);
  });
  it('refuses policy denial and exhausted budget without spending a ticket or grant', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await db.appRun.update({ where: { id: runCtx.run.id }, data: { policy: { allow: ['tool.unrelated'] } } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'TOOL_DENIED' } });
    await db.appRun.update({ where: { id: runCtx.run.id }, data: { policy: { allow: ['tool.web_request'] }, budgetActions: 0 } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'TOOL_DENIED' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('refuses targets and model-supplied bound headers without spending a ticket', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await expect(prepareSecretUse(runCtx, clientId, 'https://api.example.test/v10', {})).rejects.toBeDefined();
    await expect(prepareSecretUse(runCtx, clientId, 'https://api.example.test/v1', { AUTHORIZATION: 'override' })).rejects.toBeDefined();
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('audits a known ended client refusal without spending', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await db.secretReadClient.update({ where: { id: clientId }, data: { endedAt: new Date(), endReason: 'PROTECTED' } });
    await expect(prepare()).rejects.toBeDefined();
    const audit = await db.secretEvent.findMany({ where: { clientId, kind: 'USE' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].outcome).toBe('SECRET_READ_CLIENT_PROTECTED');
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('audits a known client even when its secret has been deleted', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    const client = await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } });
    await db.secret.delete({ where: { id: client.secretId } });
    await expect(prepare()).rejects.toBeDefined();
    const audit = await db.secretEvent.findMany({ where: { clientId, kind: 'USE' } });
    expect(audit).toHaveLength(1);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('conceals deletion from a run that does not hold the known client', async () => {
    const client = await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } });
    const holder = await db.user.create({ data: { handle: `s5-wrong-${generateId()}` } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET grantee_app_id = NULL, user_id = ${holder.id} WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await db.secret.delete({ where: { id: client.secretId } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
  });
  it('audits refusal when the issuer has been erased', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET issuer_user_id = NULL WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_ISSUER_GONE' } });
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE', outcome: 'SECRET_READ_CLIENT_ISSUER_GONE' } })).toBe(1);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('refuses an expired grant without consuming a ticket or run budget', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET expires_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_EXPIRED' } });
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } })).budgetActions).toBe(3);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE', outcome: 'SECRET_READ_CLIENT_EXPIRED' } })).toBe(1);
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
    const runForPerson = await db.appRun.update({ where: { id: runCtx.run.id }, data: { userId: holder.id } });
    const onBehalf: RunToolContext = { ...runCtx, run: runForPerson, principal: { ...runCtx.principal, userId: holder.id } };
    await expect(prepare(onBehalf)).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: runCtx.run.agentId!, name: 'S5 worker', slug: `s5-${generateId()}` } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET user_id = NULL, worker_id = ${worker.id} WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await expect(prepare(onBehalf)).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET grantee_app_id = ${appId}, user_id = NULL, worker_id = NULL, action = 'secret.reveal' WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
  });
  it('does not let a secret.use client be revealed, even by the person its grant names', async () => {
    const holder = await db.user.create({ data: { handle: `s5-reveal-${generateId()}` } });
    await db.appMember.create({ data: { appId, userId: holder.id, role: 'READER' } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET grantee_app_id = NULL, user_id = ${holder.id} WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await expect(revealForPersonHolder({ db, userId: holder.id, roles: [] }, clientId))
      .rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
  });
  it('does not let a worker-held grant reach a run that has no person behind it', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: runCtx.run.agentId!, name: 'S5 held', slug: `s5-held-${generateId()}` } });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET grantee_app_id = NULL, user_id = NULL, worker_id = ${worker.id} WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    expect(runCtx.run.userId).toBeNull();
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(0);
  });
  it('refuses a client whose secret was altered away from the signed grant', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    const original = await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } });
    const other = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'other', kind: 'webfetch-auth', metadata: { urlPrefix: 'https://api.example.test/v1' }, value: { type: 'bearer', token: 'other-synthetic' } }, { db, userId: ownerId, roles: [] });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE secret_read_clients DISABLE TRIGGER secret_read_client_guard');
      await tx.$executeRaw`UPDATE secret_read_clients SET secret_id = ${other.id} WHERE id = ${clientId}`;
      await tx.$executeRawUnsafe('ALTER TABLE secret_read_clients ENABLE TRIGGER secret_read_client_guard');
    });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    expect(original.secretId).not.toBe(other.id);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
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
  it('rolls back ticket and budget if the locked grant becomes unspendable at the final guard', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    const live = await import('../grants/live.js');
    const guard = vi.spyOn(live, 'chargeGrantUse').mockResolvedValueOnce(false);
    try {
      await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_SPENT' } });
      expect(guard).toHaveBeenCalledOnce();
      expect((await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } })).budgetActions).toBe(3);
      expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
      expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    } finally { guard.mockRestore(); }
  });
  it('serializes a one-use grant against concurrent uses without spending a second ticket', async () => {
    await db.actionTicket.createMany({ data: [generateId(), generateId()].map((id) => ({ id, organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' })) });
    const outcomes = await Promise.allSettled([prepare(), prepare()]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(1);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(1);
  });
  it('admits five uses at a five-use limit and refuses the sixth without spending another ticket', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET max_uses = 5 WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await db.appRun.update({ where: { id: runCtx.run.id }, data: { budgetActions: 6 } });
    await db.actionTicket.createMany({ data: Array.from({ length: 6 }, () => ({ id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' })) });
    for (let i = 0; i < 5; i++) await expect(prepare()).resolves.toMatchObject({ auth: { type: 'bearer' } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_SPENT' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(5);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } })).budgetActions).toBe(1);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, action: 'secret.use', consumedAt: { not: null } } })).toBe(5);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(5);
  });
  it('shares a five-use App grant across five distinct runs and refuses a sixth', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
      await tx.$executeRaw`UPDATE grants SET max_uses = 5 WHERE id = ${grantId}`;
      await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
    });
    await db.actionTicket.createMany({ data: Array.from({ length: 6 }, () => ({ id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' })) });
    const runs: RunToolContext[] = [];
    for (let i = 0; i < 6; i++) {
      const run = await db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId: runCtx.run.agentId,
        triggerKind: 'MANUAL', status: 'RUNNING', budgetActions: 1, entryNodeUrn: 'hrn:node:example.test:flows:start' } });
      runs.push({ ...runCtx, run, principal: { ...runCtx.principal, clientId: `run:${run.id}` } });
    }
    for (const ctx of runs.slice(0, 5)) await expect(prepare(ctx)).resolves.toMatchObject({ auth: { type: 'bearer' } });
    await expect(prepare(runs[5])).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_SPENT' } });
    const events = await db.grantEvent.findMany({ where: { grantId, action: 'USE' } });
    expect(new Set(events.map((e) => e.runId))).toEqual(new Set(runs.slice(0, 5).map((c) => c.run.id)));
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runs[5].run.id } })).budgetActions).toBe(1);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, action: 'secret.use', consumedAt: { not: null } } })).toBe(5);
  });
  const spentNothing = async () => {
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } })).budgetActions).toBe(3);
  };
  it('re-judges the issuer at each use: an issuer who no longer qualifies injects nothing (U12)', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await db.orgMember.deleteMany({ where: { organizationId: orgId, userId: ownerId } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await spentNothing();
  });
  it('spends only a ticket of this App or an org-wide one, never another App\'s ticket in the same org (T2)', async () => {
    const other = await db.app.create({ data: { name: 'Other', urn: `s5-other-${generateId()}.test:app`, organizationId: orgId } });
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId: other.id, action: 'secret.use', mintedBy: 'test' } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'ACTION_TICKET_REQUIRED' } });
    await spentNothing();
    expect(await db.actionTicket.count({ where: { appId: other.id, consumedAt: { not: null } } })).toBe(0);
  });
  it('refuses a run that is no longer RUNNING (U15)', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await db.appRun.update({ where: { id: runCtx.run.id }, data: { status: 'CANCELLED' } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    await spentNothing();
  });
  it('refuses a caller whose principal is not this run, or is another App (P1)', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await expect(prepare({ ...runCtx, principal: { ...runCtx.principal, clientId: `run:${generateId()}` } })).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    await expect(prepare({ ...runCtx, principal: { ...runCtx.principal, appId: generateId() } })).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    await spentNothing();
  });
  it('refuses a run with a NULL action budget TOOL_DENIED and spends no ticket or grant use (as main\'s activationVerdict does)', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await db.appRun.update({ where: { id: runCtx.run.id }, data: { budgetActions: null, budgetTokens: null } });
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'TOOL_DENIED' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, consumedAt: { not: null } } })).toBe(0);
    const after = await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } });
    expect(after.budgetActions).toBeNull();
    expect(after.actionsSpent).toBe(0);
  });
  it('commits exactly one grant use and one matching ticket before returning auth', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await expect(prepare()).resolves.toMatchObject({ auth: { type: 'bearer', token: 'synthetic-canary' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(1);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(1);
    expect((await db.appRun.findUniqueOrThrow({ where: { id: runCtx.run.id } })).budgetActions).toBe(2);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, action: 'secret.use', consumedByRunId: runCtx.run.id } })).toBe(1);
    await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_SPENT' } });
  });
  describe('auto-delete mark (cor:sec:060:03)', () => {
    const mark = async (maxUses: number) => {
      await db.$transaction(async (tx) => {
        // A signed grant needs a real ceremony row; replica mode skips only the FK to it, this file tests the use path, not signing.
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRaw`UPDATE grants SET action_values = jsonb_set(action_values, '{auto-delete}', '"delete"'), signature_id = 'sig-1', max_uses = ${maxUses} WHERE id = ${grantId}`;
      });
      for (let i = 0; i < maxUses; i++) await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    };
    it('deletes the secret inside the use that spends the last permitted use, returning the value once', async () => {
      await mark(1);
      const client = await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } });
      await expect(prepare()).resolves.toMatchObject({ auth: { type: 'bearer', token: 'synthetic-canary' } });
      expect(await db.secret.count({ where: { id: client.secretId } })).toBe(0);
      expect(await db.secretVersion.count({ where: { secretId: client.secretId } })).toBe(0);
      expect((await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } })).endedAt).not.toBeNull();
      expect(await db.secretEvent.count({ where: { secretId: client.secretId, kind: 'USE', outcome: 'OK' } })).toBe(1);
      expect(await db.secretEvent.count({ where: { secretId: client.secretId, kind: 'DELETE' } })).toBe(1);
      expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(1);
      await expect(prepare()).rejects.toBeDefined();
    });
    it('keeps the secret before the last permitted use', async () => {
      await mark(2);
      const client = await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } });
      await prepare();
      expect(await db.secret.count({ where: { id: client.secretId } })).toBe(1);
      expect(await db.secretEvent.count({ where: { secretId: client.secretId, kind: 'DELETE' } })).toBe(0);
      await prepare();
      expect(await db.secret.count({ where: { id: client.secretId } })).toBe(0);
    });
  });
});
