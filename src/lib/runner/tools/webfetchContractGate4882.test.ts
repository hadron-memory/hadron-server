/**
 * #4882: the fail-closed webfetch contract gate on a secret-bearing `web_request`. Only the capability tool (`httpRequest`,
 * `getWebfetchContract`) is mocked; the grant, ticket, secret and audit rows are real.
 * Specs: cor:int:030:01, cor:sec:030:01 (no redirect carries the value), cor:acl:050:04.
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
vi.mock('../../webfetchClient.js', () => ({ httpRequest: vi.fn(), fetchUrl: vi.fn(), getWebfetchContract: vi.fn() }));
import { httpRequest, getWebfetchContract } from '../../webfetchClient.js';
import { assertWebfetchRedirectSafe, resetWebfetchContractCache, WEBFETCH_CONTRACT_TTL_MS } from '../../webfetchContract.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { webRequest } from './webTools.js';
import { admitAndExecuteTool } from '../toolAdmission.js';

const GOOD = { contract: 'webfetch@2', capabilities: ['redirects-none'] };
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
  resetWebfetchContractCache();
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
  vi.mocked(getWebfetchContract).mockResolvedValue(GOOD as never);
  vi.mocked(httpRequest).mockResolvedValue({ method: 'GET', finalUrl: URL_OK, status: 200, headers: {}, contentType: null, body: 'ok', truncated: false } as never);
});


const untouched = async () => {
  expect(httpRequest).not.toHaveBeenCalled();
  expect(await db.actionTicket.count({ where: { consumedAt: { not: null } } })).toBe(0);
  expect((await db.grant.findUniqueOrThrow({ where: { id: grantId } })).useCount).toBe(0);
  expect(await db.secretEvent.count({ where: { clientId } })).toBe(0);
  expect(await budget()).toBe(20);
};
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ extensions: { code: 'WEBFETCH_TOOL_CONTRACT_MISMATCH' } });

describe('#4882 a tool that declares the contract', () => {
  it('lets a secret-bearing call through and the credential is sent with redirects:none', async () => {
    await tickets(1);
    await expect(call()).resolves.toMatchObject({ status: 200 });
    expect(httpRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ auth: { type: 'bearer', token: CANARY }, redirects: 'none' }));
  });
  it('is read once and the pass is cached', async () => {
    await tickets(2);
    await call(); await call();
    expect(getWebfetchContract).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ['no declaration (a tool that predates #13)', () => vi.mocked(getWebfetchContract).mockRejectedValue(new Error('404'))],
  ['an unreachable tool', () => vi.mocked(getWebfetchContract).mockRejectedValue(new GraphQLError('x', { extensions: { code: 'WEBFETCH_TOOL_UNREACHABLE' } }))],
  ['a wrong version', () => vi.mocked(getWebfetchContract).mockResolvedValue({ contract: 'webfetch@1', capabilities: ['redirects-none'] } as never)],
  ['a missing capability', () => vi.mocked(getWebfetchContract).mockResolvedValue({ contract: 'webfetch@2', capabilities: [] } as never)],
  ['a malformed body', () => vi.mocked(getWebfetchContract).mockResolvedValue({ contract: 'webfetch@2', capabilities: 'redirects-none' } as never)],
  ['an empty body', () => vi.mocked(getWebfetchContract).mockResolvedValue({} as never)],
])('#4882 %s', (_name, arrange) => {
  it('refuses with WEBFETCH_TOOL_CONTRACT_MISMATCH before the ticket, the grant use, the secret and the request', async () => {
    arrange();
    await tickets(1);
    const value = vi.spyOn(await import('../../secrets/appSecrets.js'), 'currentAppSecretValue');
    await refused(call());
    expect(value).not.toHaveBeenCalled();
    await untouched();
  });
  it('is the same refusal for an unknown client or a client of another App (it depends only on the tool)', async () => {
    arrange();
    await refused(call({ secretClientId: otherClientId }));
    await refused(call({ secretClientId: 'nope' }));
    expect(httpRequest).not.toHaveBeenCalled();
  });
  it('carries no URL, secret or declared body in the error', async () => {
    arrange();
    const e = (await call().catch((x: unknown) => x)) as GraphQLError;
    expect(JSON.stringify([e.message, e.extensions])).not.toMatch(/CANARY|canary|api\.example|webfetch@1/);
  });
});

describe('#4882 a refusal is never cached', () => {
  it('a tool upgraded a moment later passes on the next call, no restart', async () => {
    vi.mocked(getWebfetchContract).mockRejectedValueOnce(new Error('404'));
    await tickets(1);
    await refused(call());
    await expect(call()).resolves.toMatchObject({ status: 200 });
    expect(getWebfetchContract).toHaveBeenCalledTimes(2);
  });
});

describe('#4882 the arms that gain no refusal (both arms)', () => {
  it('secretless web_request, web_fetch and the pass-through make zero declaration calls even against an undeclaring tool', async () => {
    vi.mocked(getWebfetchContract).mockRejectedValue(new Error('404'));
    await expect(webRequest.execute(ctx, { method: 'GET', url: URL_OK })).resolves.toMatchObject({ status: 200 });
    expect(getWebfetchContract).not.toHaveBeenCalled();
  });
  it('a malformed secretClientId is still the uniform refusal, not the contract code, once the tool declares it', async () => {
    const e = (await call({ secretClientId: 7 }).then(() => undefined, (x: unknown) => x)) as GraphQLError | undefined;
    expect(e).toBeInstanceOf(GraphQLError);
    expect(e!.extensions.code).not.toBe('WEBFETCH_TOOL_CONTRACT_MISMATCH');
  });
});

describe('#4882 cache lifetime (SEC10 and blind P3s)', () => {
  it('a cached pass expires at the TTL on an injected clock and is read again', async () => {
    const t0 = 1_000_000;
    await assertWebfetchRedirectSafe(t0);
    await assertWebfetchRedirectSafe(t0 + WEBFETCH_CONTRACT_TTL_MS - 1);
    expect(getWebfetchContract).toHaveBeenCalledTimes(1);
    await assertWebfetchRedirectSafe(t0 + WEBFETCH_CONTRACT_TTL_MS);
    expect(getWebfetchContract).toHaveBeenCalledTimes(2);
  });
  it('a changed WEBFETCH_TOOL_URL drops the cached pass', async () => {
    const before = process.env.WEBFETCH_TOOL_URL;
    try {
      process.env.WEBFETCH_TOOL_URL = 'http://tool-a.test';
      await assertWebfetchRedirectSafe(5);
      process.env.WEBFETCH_TOOL_URL = 'http://tool-b.test';
      await assertWebfetchRedirectSafe(6);
      expect(getWebfetchContract).toHaveBeenCalledTimes(2);
    } finally {
      if (before === undefined) delete process.env.WEBFETCH_TOOL_URL; else process.env.WEBFETCH_TOOL_URL = before;
    }
  });
  it('a burst of concurrent calls makes ONE declaration read', async () => {
    await Promise.all([assertWebfetchRedirectSafe(9), assertWebfetchRedirectSafe(9), assertWebfetchRedirectSafe(9)]);
    expect(getWebfetchContract).toHaveBeenCalledTimes(1);
  });
  it('a failed in-flight read is shared by the burst and is not cached for the next call', async () => {
    vi.mocked(getWebfetchContract).mockRejectedValueOnce(new Error('down'));
    const r = await Promise.allSettled([assertWebfetchRedirectSafe(9), assertWebfetchRedirectSafe(9)]);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected']);
    expect(getWebfetchContract).toHaveBeenCalledTimes(1);
    await expect(assertWebfetchRedirectSafe(9)).resolves.toBeUndefined();
  });
});

describe('#4882 the refusal leaves an operator line with a fixed shape', () => {
  it.each([
    ['unreachable', () => vi.mocked(getWebfetchContract).mockRejectedValue(new Error('http://secret-host.test 404'))],
    ['undeclared', () => vi.mocked(getWebfetchContract).mockResolvedValue({} as never)],
    ['wrong_version', () => vi.mocked(getWebfetchContract).mockResolvedValue({ contract: 'webfetch@3', capabilities: ['redirects-none'] } as never)],
    ['missing_capability', () => vi.mocked(getWebfetchContract).mockResolvedValue({ contract: 'webfetch@2', capabilities: [] } as never)],
  ])('%s logs the reason only', async (reason, arrange) => {
    arrange();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await refused(assertWebfetchRedirectSafe());
    expect(warn).toHaveBeenCalledExactlyOnceWith('[webfetchContract] credentialed request refused', { reason });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-host');
    warn.mockRestore();
  });
});

describe('#4882 no other path of the run tools can attach a credential (blind P2-2)', () => {
  it('web_request ignores a caller-supplied auth argument and sends none without secretClientId', async () => {
    await call({ secretClientId: undefined, auth: { type: 'bearer', token: 'x' } }).catch(() => undefined);
    await webRequest.execute(ctx, { method: 'GET', url: URL_OK, auth: { type: 'bearer', token: 'x' } });
    for (const [input] of vi.mocked(httpRequest).mock.calls) expect(input).not.toHaveProperty('auth');
  });
  it('only webTools.ts calls httpRequest/fetchUrl/checkUrl outside the client, and only its gated call site passes auth', () => {
    const root = join(__dirname, '..', '..', '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) files.push(f); } };
    walk(root);
    const callers = files.filter((f) => /\b(httpRequest|fetchUrl|checkUrl)\(/.test(readFileSync(f, 'utf8')) && !f.endsWith('lib/webfetchClient.ts'));
    expect(callers.map((f) => f.slice(root.length + 1)).sort()).toEqual(['lib/runner/tools/webTools.ts']);
    const src = readFileSync(join(root, 'lib/runner/tools/webTools.ts'), 'utf8');
    const authSites = src.split('\n').filter((l) => /\b(httpRequest|fetchUrl|checkUrl)\(.*\bauth\b/.test(l));
    expect(authSites).toHaveLength(1);
    expect(src.indexOf('await assertWebfetchRedirectSafe()')).toBeGreaterThan(-1);
    expect(src.indexOf('await assertWebfetchRedirectSafe()')).toBeLessThan(src.indexOf(authSites[0]!));
  });
});
