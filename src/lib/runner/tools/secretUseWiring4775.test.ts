/**
 * #4775 (S5 follow-up to #4000): the secret-use path through the real `web_request` run tool.
 * Only the outbound capability tool (`httpRequest`) is mocked; the grant, ticket, budget and audit rows are real.
 * Specs: cor:sec:030:01 (an injected value never enters model context), cor:sec:010:02 (origin binding),
 * cor:web:010:02 (no redirect carries the value), cor:sec:060:02 Proposed (one answer for every lookup miss).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { isStoreFault } from '../../secrets/storeFault.js';
import { meterRefusedSecretUse } from '../../secrets/readClientReveal.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { upsertPlatformActions } from '../../grants/actions.js';
import { resolvers, type Context } from '../../../api/graphql/schema/resolvers.js';
import type { RunToolContext } from './types.js';
const fault = vi.hoisted(() => ({ on: false }));
vi.mock('../../secrets/appSecrets.js', async (orig) => {
  const actual = await orig<typeof import('../../secrets/appSecrets.js')>();
  const { Prisma: P } = await import('../../../generated/prisma/index.js');
  return { ...actual, currentAppSecretValue: (...a: Parameters<typeof actual.currentAppSecretValue>) => {
    if (fault.on) return Promise.reject(new P.PrismaClientInitializationError('db down', 't'));
    return actual.currentAppSecretValue(...a);
  } };
});
vi.mock('../../webfetchClient.js', () => ({ httpRequest: vi.fn(), fetchUrl: vi.fn(), getWebfetchContract: vi.fn().mockResolvedValue({ contract: 'webfetch@2', capabilities: ['redirects-none'] }) }));
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
  fault.on = false;
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
    vi.mocked(httpRequest).mockResolvedValue({ method: 'GET', finalUrl: URL_OK, status: 200, headers: { 'x-echo': `Bearer ${CANARY}` }, contentType: 'application/json',
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
    // The tool's own error is never kept: no originalError and no deeper cause survive on the rebuilt one (its free text may echo the value).
    expect((err.cause as GraphQLError).originalError).toBeUndefined();
    expect((err.cause as Error).cause).toBeUndefined();
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
    await tickets(1);
    const exhausted = await admitAndExecuteTool(webRequest, { method: 'GET', url: URL_OK, secretClientId: clientId }, { toolCtx: ctx }).catch((e: unknown) => e);
    // Budget zero: the use is refused with a budget code, not merely "something rejected", and nothing is sent, spent or decremented below zero.
    expect(exhausted).toBeInstanceOf(Error);
    expect(((exhausted as Error).cause as GraphQLError | undefined)?.extensions?.code ?? (exhausted as GraphQLError).extensions?.code).toBe('TOOL_DENIED');
    expect(await budget()).toBe(0);
    expect(httpRequest).not.toHaveBeenCalled();
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
  });
  it('past the per-client bound a refusal is counted and not stored; the answer is unchanged and a success is still recorded', async () => {
    const secretId = (await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } })).secretId;
    await db.secretEvent.createMany({ data: Array.from({ length: 100 }, () => ({ ownerType: 'app', ownerId: appId, secretId, secretName: 'token', clientId, kind: 'USE', outcome: 'ACTION_TICKET_REQUIRED', runId: ctx.run.id })) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(call()).rejects.toMatchObject({ extensions: { code: 'ACTION_TICKET_REQUIRED' } });
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE' } })).toBe(100);
    expect(warn).toHaveBeenCalledExactlyOnceWith('[secretUse] refusal audit cap reached', expect.objectContaining({ clientId, outcome: 'ACTION_TICKET_REQUIRED', cap: 100 }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
    warn.mockRestore();
    await tickets(1);
    await expect(call()).resolves.toMatchObject({ status: 200 });
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE', outcome: 'OK' } })).toBe(1);
  });
});

describe('#4775 cap counts refusals only, and delete-at-last-use works through web_request', () => {
  it('successful uses never count toward the refusal cap', async () => {
    const secretId = (await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } })).secretId;
    await db.secretEvent.createMany({ data: Array.from({ length: 100 }, () => ({ ownerType: 'app', ownerId: appId, secretId, secretName: 'token', clientId, kind: 'USE', outcome: 'OK', runId: ctx.run.id })) });
    await expect(call()).rejects.toMatchObject({ extensions: { code: 'ACTION_TICKET_REQUIRED' } });
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE', outcome: 'ACTION_TICKET_REQUIRED' } })).toBe(1);
  });
  it('a signed delete-marked client spends its last use through web_request, the response is returned and the secret is gone', async () => {
    const secretId = (await db.secretReadClient.findUniqueOrThrow({ where: { id: clientId } })).secretId;
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE grants SET action_values = jsonb_set(action_values, '{auto-delete}', '"delete"'), signature_id = 'sig-1', max_uses = 1 WHERE id = ${grantId}`;
    });
    await tickets(1);
    await expect(call()).resolves.toMatchObject({ status: 200, body: 'ok' });
    expect(await db.secret.count({ where: { id: secretId } })).toBe(0);
    const second = (await call().catch((e: unknown) => e)) as GraphQLError;
    expect(second.extensions?.code).toBe('SECRET_READ_CLIENT_SECRET_DELETED');
    expect(httpRequest).toHaveBeenCalledTimes(1);
    // The delete removes the secret, not the record of its use: the grant row and the OK event survive.
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(1);
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE', outcome: 'OK' } })).toBe(1);
  });
});

describe('#4775 a store fault is not a refusal (blind P2)', () => {
  it('classifies only connection-class Prisma errors as faults; a missing row or a constraint is a judgment', () => {
    const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 't' });
    for (const c of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']) expect(isStoreFault(known(c))).toBe(true);
    for (const c of ['P2025', 'P2002', 'P2003']) expect(isStoreFault(known(c))).toBe(false);
    expect(isStoreFault(new Prisma.PrismaClientInitializationError('x', 't'))).toBe(true);
    expect(isStoreFault(new Error('x'))).toBe(false);
  });
  it('an outage reading the secret inside the use propagates as itself: not metered, not audited, nothing sent', async () => {
    await tickets(1);
    const before = await budget();
    fault.on = true;
    const err = await call().catch((e: unknown) => e);
    fault.on = false;
    expect(err).toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect(await budget()).toBe(before);
    expect(await db.secretEvent.count({ where: { clientId, kind: 'USE' } })).toBe(0);
    expect(httpRequest).not.toHaveBeenCalled();
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
  });
  it('the meter itself skips a store fault but charges any other refusal', async () => {
    const before = await budget();
    await meterRefusedSecretUse(ctx, new Prisma.PrismaClientInitializationError('db down', 't'));
    expect(await budget()).toBe(before);
    await meterRefusedSecretUse(ctx, new GraphQLError('refused'));
    expect(await budget()).toBe(before! - 1);
  });
});

describe('#4775 a followed redirect withholds the response (blind P1, defense in depth)', () => {
  it('a result from another origin is refused, never returned, and carries no value', async () => {
    await tickets(1);
    vi.mocked(httpRequest).mockResolvedValue({ method: 'GET', finalUrl: 'https://evil.example.test/steal', status: 200, headers: {}, contentType: null, body: `echo ${CANARY}`, truncated: false } as never);
    const err = (await call().catch((e: unknown) => e)) as GraphQLError;
    expect(err.extensions).toMatchObject({ code: 'WEBFETCH_REDIRECT_FOLLOWED' });
    expect(JSON.stringify({ m: err.message, x: err.extensions })).not.toContain(CANARY);
  });
  it('a result on the same origin but another path or query is refused too (the comparison is the whole URL, not the origin)', async () => {
    for (const finalUrl of ['https://api.example.test/v1/other', `${URL_OK}?x=1`, 'https://api.example.test/']) {
      await tickets(1);
      vi.mocked(httpRequest).mockResolvedValue({ method: 'GET', finalUrl, status: 200, headers: {}, contentType: null, body: `echo ${CANARY}`, truncated: false } as never);
      const err = (await call().catch((e: unknown) => e)) as GraphQLError;
      expect(err.extensions).toMatchObject({ code: 'WEBFETCH_REDIRECT_FOLLOWED' });
      expect(JSON.stringify({ m: err.message, x: err.extensions })).not.toContain(CANARY);
    }
    // A withheld response still spends the use: the credential was sent.
    expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(3);
  });
  it('a result with no finalUrl is refused the same way (fail closed) and raises the operator line', async () => {
    await tickets(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(httpRequest).mockResolvedValue({ method: 'GET', status: 200, headers: {}, contentType: null, body: 'ok', truncated: false } as never);
    await expect(call()).rejects.toMatchObject({ extensions: { code: 'WEBFETCH_REDIRECT_FOLLOWED' } });
    expect(warn).toHaveBeenCalledWith('[secretUse] redirect followed or finalUrl missing; response withheld', { runId: ctx.run.id });
    warn.mockRestore();
  });
});
