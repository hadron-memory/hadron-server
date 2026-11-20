/** #4000: the run's use spend is atomic with its ticket and never grants another App or agent access. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from '../grants/actions.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import type { RunToolContext } from '../runner/tools/types.js';
import * as secretUse from './readClientReveal.js';
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
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, agentId: agent.id, triggerKind: 'MANUAL', status: 'RUNNING', entryNodeUrn: 'hrn:node:example.test:flows:start' } });
  runCtx = { db, run, principal: { db, appId: app.id, organizationId: org.id, clientId: `run:${run.id}`, roles: [] }, log: () => {} };
});
const prepare = (ctx = runCtx) => (secretUse as unknown as { prepareSecretUse: (ctx: RunToolContext, clientId: string, url: string, headers: Record<string, string>) => Promise<unknown> }).prepareSecretUse(ctx, clientId, 'https://api.example.test/v1/orders', {});
describe('transactional secret.use (#4000)', () => {
  it('refuses without a ticket and spends neither grant nor event', async () => {
    await expect(prepare()).rejects.toBeDefined();
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(0);
  });
  it('commits exactly one grant use and one matching ticket before returning auth', async () => {
    await db.actionTicket.create({ data: { id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' } });
    await expect(prepare()).resolves.toMatchObject({ auth: { type: 'bearer', token: 'synthetic-canary' } });
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(1);
    expect(await db.grantEvent.count({ where: { grantId, action: 'USE' } })).toBe(1);
    expect(await db.actionTicket.count({ where: { organizationId: orgId, action: 'secret.use', consumedByRunId: runCtx.run.id } })).toBe(1);
    await expect(prepare()).rejects.toBeDefined();
  });
});
