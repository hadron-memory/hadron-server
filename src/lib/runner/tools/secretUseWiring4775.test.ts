/**
 * #4775 (S5 follow-up to #4000): the secret-use path through the real `web_request` run tool.
 * Only the outbound capability tool (`httpRequest`) is mocked; the grant, ticket, budget and audit rows are real.
 * Specs: cor:sec:030:01 (an injected value never enters model context), cor:sec:010:02 (origin binding),
 * cor:web:010:02 (no redirect carries the value), cor:sec:060:02 Proposed (one answer for every lookup miss).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { upsertPlatformActions } from '../../grants/actions.js';
import { resolvers, type Context } from '../../../api/graphql/schema/resolvers.js';
import type { RunToolContext } from './types.js';
vi.mock('../../webfetchClient.js', () => ({ httpRequest: vi.fn(), fetchUrl: vi.fn() }));
import { httpRequest } from '../../webfetchClient.js';
import { webRequest } from './webTools.js';
import { admitAndExecuteTool } from '../toolAdmission.js';

const CANARY = 'canary-s5-4775-VALUE';
const URL_OK = 'https://api.example.test/v1/orders';
let ctx: RunToolContext; let clientId: string; let orgId: string; let appId: string; let grantId: string; let otherClientId: string;

async function makeClient(app: { id: string }, userId: string, secretId: string) {
  const gid = generateId(); const cid = generateId();
  await db.$executeRaw`INSERT INTO grants (id, app_id, grantee_app_id, action, action_values, reason, max_uses, created_at, updated_at)
    VALUES (${gid}, ${app.id}, ${app.id}, 'secret.use', ${JSON.stringify({ secret: secretId, 'auto-delete': 'keep', 'binding-prefix': 'https://api.example.test/v1', 'binding-header': 'Authorization' })}::jsonb, 'test', 50, now(), now())`;
  await db.secretReadClient.create({ data: { id: cid, grantId: gid, appId: app.id, secretId, secretName: 'token', issuerUserId: userId, selfIssued: false } });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRaw`UPDATE grants SET activated_at = now(), verification_kind = 'passkey', verified_by = ${userId}, issuer_user_id = ${userId} WHERE id = ${gid}`;
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
  return { gid, cid };
}
const tickets = (n: number) => db.actionTicket.createMany({ data: Array.from({ length: n }, () => ({ id: generateId(), organizationId: orgId, appId, action: 'secret.use', mintedBy: 'test' })) });
const call = (extra: Record<string, unknown> = {}) => webRequest.execute(ctx, { method: 'GET', url: URL_OK, secretClientId: clientId, ...extra });
const budget = async () => (await db.appRun.findUniqueOrThrow({ where: { id: ctx.run.id } })).budgetActions;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.SECRET_ROOT_KEY = '33'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  const user = await db.user.create({ data: { handle: `s5w-${generateId()}` } });
  const org = await db.organization.create({ data: { name: 'S5W', urn: `s5w-${generateId()}.test` } }); orgId = org.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'S5W', urn: `s5w-${generateId()}.test:app`, organizationId: org.id } }); appId = app.id;
  const app2 = await db.app.create({ data: { name: 'S5W2', urn: `s5w2-${generateId()}.test:app`, organizationId: org.id } });
  const agent = await db.agent.create({ data: { name: 'S5W', urn: `s5w-${generateId()}.test:agent`, organizationId: org.id } });
  const rctx: Context = { db, userId: user.id, roles: [] };
  const mk = (a: { id: string }) => resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: a.id, name: 'token', kind: 'webfetch-auth',
    metadata: { type: 'bearer', urlPrefix: 'https://api.example.test/v1' }, value: { type: 'bearer', token: CANARY } }, rctx);
  const s1 = await mk(app); const s2 = await mk(app2);
  const c1 = await makeClient(app, user.id, s1.id); clientId = c1.cid; grantId = c1.gid;
  otherClientId = (await makeClient(app2, user.id, s2.id)).cid;
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, agentId: agent.id, triggerKind: 'MANUAL', status: 'RUNNING', budgetActions: 20, entryNodeUrn: 'hrn:node:example.test:flows:start' } });
  ctx = { db, run, log: vi.fn(), principal: { db, appId: app.id, organizationId: org.id, clientId: `run:${run.id}`, roles: [] } };
  vi.mocked(httpRequest).mockResolvedValue({ method: 'GET', finalUrl: URL_OK, status: 200, headers: {}, contentType: null, body: 'ok', truncated: false } as never);
});

describe('#4775 the use path is wired', () => {
  it('sends the injected auth, the bound url and redirects:none, and returns the response', async () => {
    await tickets(1);
    await expect(call()).resolves.toMatchObject({ status: 200, body: 'ok' });
    expect(httpRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: URL_OK, auth: { type: 'bearer', token: CANARY }, redirects: 'none' }));
  });
  it('an anonymous request never asks the tool for redirects:none (existing contract unchanged)', async () => {
    await webRequest.execute(ctx, { method: 'GET', url: URL_OK });
    expect(httpRequest).toHaveBeenCalledExactlyOnceWith({ method: 'GET', url: URL_OK });
  });
});

describe('#4775 echo redaction (acceptance 1)', () => {
  it('a remote that echoes the injected header back leaves no value in the result, the log or the hop record', async () => {
    await tickets(1);
    vi.mocked(httpRequest).mockResolvedValue({ method: 'GET', finalUrl: `${URL_OK}?t=${CANARY}`, status: 200, headers: { 'x-echo': `Bearer ${CANARY}` }, contentType: 'application/json',
      body: { echoed: { authorization: `Bearer ${CANARY}` }, raw: `Bearer ${CANARY}` }, truncated: false } as never);
    const records: unknown[] = [];
    const out = await admitAndExecuteTool(webRequest, { method: 'GET', url: URL_OK, secretClientId: clientId }, { toolCtx: ctx, record: (e) => records.push(e) });
    expect(JSON.stringify(out)).not.toContain(CANARY);
    expect(JSON.stringify(out)).toContain('[REDACTED]');
    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain(CANARY);
    expect(JSON.stringify(records)).not.toContain(CANARY);
  });
});

describe('#4775 capability-tool error text (acceptance 2)', () => {
  it('an error that carries the value reaches the run failure with none of it, in message or cause', async () => {
    await tickets(1);
    vi.mocked(httpRequest).mockRejectedValue(Object.assign(new GraphQLError(`upstream said Bearer ${CANARY} is bad`, { extensions: { code: 'WEBFETCH_TOOL_ERROR', webfetchErrorCode: 'fetch_failed', status: 502, cause: `Bearer ${CANARY}` } }), { cause: new Error(CANARY) }));
    const err = (await admitAndExecuteTool(webRequest, { method: 'GET', url: URL_OK, secretClientId: clientId }, { toolCtx: ctx }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    const seen = JSON.stringify({ m: err.message, c: err.cause, x: (err.cause as GraphQLError)?.extensions, cm: (err.cause as Error)?.message, cc: ((err.cause as Error)?.cause as Error)?.message });
    expect(seen).not.toContain(CANARY);
    expect((err.cause as GraphQLError).extensions).toMatchObject({ code: 'WEBFETCH_TOOL_ERROR', webfetchErrorCode: 'fetch_failed' });
  });
});

describe('#4775 client lookup refusals (item 6)', () => {
  it('an unknown id, a malformed reference and another App\'s client all get SECRET_READ_CLIENT_NOT_FOUND and send nothing', async () => {
    await tickets(2);
    for (const secretClientId of [generateId(), null, '', 17, otherClientId]) {
      await expect(call({ secretClientId })).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    }
    expect(httpRequest).not.toHaveBeenCalled();
  });
});

describe('#4775 refused attempts are metered and their audit capped (item 3)', () => {
  it('each refused attempt spends one action and a looping caller runs out of budget; the ticket and grant stay unspent', async () => {
    const before = await budget();
    await expect(call()).rejects.toMatchObject({ extensions: { code: 'ACTION_TICKET_REQUIRED' } });
    await expect(call({ secretClientId: generateId() })).rejects.toMatchObject({ extensions: { code: 'SECRET_READ_CLIENT_NOT_FOUND' } });
    expect(await budget()).toBe(before! - 2);
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
    await db.appRun.update({ where: { id: ctx.run.id }, data: { budgetActions: 0 } });
    await expect(call()).rejects.toBeDefined();
    expect(await budget()).toBe(0);
  });
  it('past the per-client bound a refusal is counted and not stored; the answer is unchanged and a success is still recorded', async () => {
    const secretId = (await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } })).secretId;
    await db.secretEvent.createMany({ data: Array.from({ length: 100 }, () => ({ ownerType: 'app', ownerId: appId, secretId, secretName: 'token', clientId, kind: 'USE', outcome: 'ACTION_TICKET_REQUIRED', runId: ctx.run.id })) });
    await expect(call()).rejects.toMatchObject({ extensions: { code: 'ACTION_TICKET_REQUIRED' } });
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE' } })).toBe(100);
    await tickets(1);
    await expect(call()).resolves.toMatchObject({ status: 200 });
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE', outcome: 'OK' } })).toBe(1);
  });
});
