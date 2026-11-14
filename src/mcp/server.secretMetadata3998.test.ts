/** S3 #3998 MCP is metadata-only; requesting a grant never reveals or activates it. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { runAsActor } from '../lib/requestActor.js';
import { secretMutations, secretQueries } from '../api/graphql/schema/resolvers.secret.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
beforeAll(() => { vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); vi.stubEnv('SECRET_ROOT_KEY', '22'.repeat(32)); });
afterAll(async () => { await cleanDb(db); vi.unstubAllEnvs(); });
let userId: string; let appId: string; let orgId: string; let secretId: string; let workerId: string;
const CANARY = 'S3-PRIVATE-VALUE-NEVER-IN-MCP';
const auth = (extra: Partial<AuthContext> = {}): AuthContext => ({ userId, appId, organizationId: orgId, roles: [], clientId: `user:${userId}`, ...extra });
const server = (extra: Partial<AuthContext> = {}) => createTestableMcpServer(auth(extra), { cachedAppResolution: { kind: 'multi-app' } });
const context = (): Context => ({ db, userId, roles: [] });

/** Walk every result field, including parsed JSON carried in MCP text, for secret bytes and storage columns. */
function noValue(value: unknown): void {
  if (typeof value === 'string') {
    expect(value).not.toContain(CANARY);
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { return; }
    if (typeof parsed !== 'string') noValue(parsed);
  } else if (Array.isArray(value)) value.forEach(noValue);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    expect(['value', 'valueEncrypted', 'ciphertext', 'valueJson']).not.toContain(key);
    noValue(item);
  }
}

beforeEach(async () => {
  await cleanDb(db); await upsertPlatformActions(db);
  userId = (await db.user.create({ data: { handle: `meta-${generateId()}` } })).id;
  orgId = (await db.organization.create({ data: { name: 'S3 MCP', urn: `meta-${generateId()}.test` } })).id;
  await db.orgMember.create({ data: { userId, organizationId: orgId, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { name: 'Metadata', urn: `meta-${generateId()}:app`, organizationId: orgId } })).id;
  const agent = await db.agent.create({ data: { name: 'Agent', urn: `meta-${generateId()}:agent`, organizationId: orgId } });
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: agent.id, name: 'holder', slug: 'holder' } })).id;
  secretId = (await secretMutations.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'token', kind: 'generic', metadata: { purpose: 'public' }, value: CANARY }, context())).id;
});

describe('#3998 MCP metadata and manager request arm', () => {
  it('walks every registered secret tool result: metadata only, no read/store/use/reveal door', async () => {
    const inject = await secretMutations.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'inject-only', kind: 'webfetch-auth', metadata: { urlPrefix: 'https://example.test/api' }, value: { type: 'bearer', token: CANARY } }, context());
    const s = server();
    const names = s.toolNames().filter(n => /secret/i.test(n));
    expect(names.sort()).toEqual(['hadron_get_secret', 'hadron_list_secrets']);
    for (const name of names) {
      const result = await s.callTool(name, name === 'hadron_get_secret' ? { ref: secretId } : { app: appId });
      noValue(result);
      expect(JSON.stringify(result)).toContain('token');
    }
    noValue(await s.callTool('hadron_get_secret', { ref: inject.id }));
    expect(await db.secretEvent.count({ where: { secretId, kind: 'REVEAL' } })).toBe(0);
  });

  it('returns paged App metadata and conceals org/user scopes and unknown refs', async () => {
    const s = server();
    const page = JSON.parse(await s.callToolText('hadron_list_secrets', { app: appId, limit: 0 }));
    expect(page).toMatchObject({ items: [], total: 1, hasMore: true });
    const own = await secretMutations.createSecret({}, { ownerType: 'user', name: 'personal', kind: 'generic', value: CANARY }, context());
    expect(JSON.parse(await s.callToolText('hadron_get_secret', { ref: own.id }))).toBeNull();
    expect(await s.callToolText('hadron_get_secret', { ref: generateId() })).toBe('null');
  });

  it('App keys (even carrying a user), runs, impersonation and strangers discover nothing', async () => {
    const stranger = (await db.user.create({ data: { handle: `outsider-${generateId()}` } })).id;
    for (const extra of [
      { userId: undefined, appKeyId: 'app-key' }, { appKeyId: 'app-key' },
      { clientId: 'run:synthetic' }, { impersonation: { by: 'operator' } }, { userId: stranger },
    ]) {
      const s = server(extra as Partial<AuthContext>);
      expect(JSON.parse(await s.callToolText('hadron_list_secrets', { app: appId }))).toMatchObject({ items: [], total: 0 });
      expect(await s.callToolText('hadron_get_secret', { ref: secretId })).toBe('null');
    }
  });

  it('explicitly projects metadata even when resolver rows carry value-shaped storage fields', async () => {
    const row = await db.secret.findUniqueOrThrow({ where: { id: secretId } });
    const poison = { ...row, value: CANARY, valueEncrypted: CANARY, ciphertext: CANARY };
    const get = vi.spyOn(secretQueries, 'secret').mockResolvedValue(poison);
    const list = vi.spyOn(secretQueries, 'secrets').mockResolvedValue({ items: [poison], total: 1 });
    try {
      const s = server();
      noValue(await s.callTool('hadron_get_secret', { ref: secretId }));
      noValue(await s.callTool('hadron_list_secrets', { app: appId }));
    } finally { get.mockRestore(); list.mockRestore(); }
  });

  it('manager hadron_create_grant requests a pending reveal grant, never a value or active client, even with a published worker actor', async () => {
    const result = await runAsActor({ workerId, agentId: null }, () => server().callTool('hadron_create_grant', {
      app: appId, action: 'secret.reveal', values: { secret: secretId, 'auto-delete': 'keep' },
      holderKind: 'WORKER', holderRef: workerId, maxUses: 1, reason: 'manager asks',
    }));
    noValue(result);
    const grant = await db.grant.findFirstOrThrow({ where: { action: 'secret.reveal' } });
    expect(grant).toMatchObject({ requestedByUserId: userId, requestedByWorkerId: null, requestedBySessionId: null, activatedAt: null, issuerUserId: null, useCount: 0 });
    expect(await db.secretReadClient.count({ where: { grantId: grant.id } })).toBe(0);
    expect(await db.grantEvent.count({ where: { grantId: grant.id, action: 'USE' } })).toBe(0);
  });

  it('deleted orgs hide metadata and signing-off removes grant requests but keeps safe metadata reads', async () => {
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    try {
      const s = server();
      expect(s.toolNames()).not.toContain('hadron_create_grant');
      noValue(await s.callTool('hadron_get_secret', { ref: secretId }));
    } finally { vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true'); }
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    expect(await server().callToolText('hadron_get_secret', { ref: secretId })).toBe('null');
  });
});
