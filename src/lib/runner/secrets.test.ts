/**
 * Run-time secret resolution (#677, narrowed to org/user by #696) — what this
 * file pins:
 *   - the CSS cascade order (user → org) and first-match wins;
 *   - scope pinning and the no-user skip;
 *   - hadron_read_secret: value → model, trail line never carries the value;
 *   - loadWebFetchAuthSecret kind assertion + origin binding
 *     (assertUrlWithinPrefix evil-origin / near-miss cases).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../id.js';
import { encryptToken } from '../tokenCrypto.js';
import { cleanDb } from '../../test/helpers.js';
import { assertUrlWithinPrefix, loadWebFetchAuthSecret, resolveRunSecret } from './secrets.js';
import { hadronReadSecret } from './tools/secretTools.js';
import type { RunToolContext } from './tools/types.js';

function enc(payload: unknown): string {
  return encryptToken(JSON.stringify(payload));
}

let org: { id: string };
let app: { id: string };
let user: { id: string };
let memory: { id: string; urn: string };
let ctx: RunToolContext;

async function seedGeneric(ownerType: string, ownerId: string, value: string, name = 'api-key') {
  return db.secret.create({
    data: { ownerType, ownerId, name, kind: 'generic', metadata: {}, valueEncrypted: enc(value) },
  });
}

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  await cleanDb(db);

  org = await db.organization.create({
    data: { id: generateId(), name: 'Secret Org', urn: `secret-${generateId()}` },
  });
  const orgUrn = (await db.organization.findUniqueOrThrow({ where: { id: org.id } })).urn;
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${orgUrn}::flows`,
      name: 'flows',
      class: 'knowledge',
    },
  });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${orgUrn}::secret-agent`,
      name: 'Secret agent',
      visibility: 'ORGANIZATION',
    },
  });
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, urn: `${orgUrn}::secret-app`, name: 'Secret App' },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: memory.id, role: 'read' } });
  user = await db.user.create({
    data: { id: generateId(), email: 'runner@secret.test', name: 'Runner' },
  });
  const run = await db.appRun.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      appId: app.id,
      agentId: agent.id,
      userId: user.id,
      triggerKind: 'MANUAL',
      entryNodeUrn: `${memory.urn}::flow:start`,
      status: 'RUNNING',
    },
  });
  ctx = {
    db,
    run,
    log: vi.fn(),
    principal: { db, appId: app.id, organizationId: org.id, clientId: `run:${run.id}` },
  };
});

describe('resolveRunSecret — the CSS cascade', () => {
  it('resolves most-specific-first: user → org', async () => {
    await seedGeneric('org', org.id, 'org-value');
    await seedGeneric('user', user.id, 'user-value');

    for (const [ownerType, value] of [
      ['user', 'user-value'],
      ['org', 'org-value'],
    ] as const) {
      const hit = await resolveRunSecret(ctx, { name: 'api-key' });
      expect(hit).toMatchObject({ ownerType, value });
      await db.secret.deleteMany({ where: { ownerType } });
    }
    expect(await resolveRunSecret(ctx, { name: 'api-key' })).toBeNull();
  });

  it('pins resolution to one scope when asked', async () => {
    await seedGeneric('user', user.id, 'user-value');
    await seedGeneric('org', org.id, 'org-value');
    expect(await resolveRunSecret(ctx, { name: 'api-key', scope: 'org' })).toMatchObject({
      ownerType: 'org',
      value: 'org-value',
    });
    expect(await resolveRunSecret(ctx, { name: 'api-key', scope: 'user' })).toMatchObject({
      ownerType: 'user',
      value: 'user-value',
    });
    // A scope with no secret of that name resolves to null.
    expect(await resolveRunSecret(ctx, { name: 'missing', scope: 'org' })).toBeNull();
  });

  it('skips the user scope when the run has no on-behalf-of user', async () => {
    await seedGeneric('user', user.id, 'user-value');
    ctx.run = await db.appRun.update({ where: { id: ctx.run.id }, data: { userId: null } });
    expect(await resolveRunSecret(ctx, { name: 'api-key' })).toBeNull();
  });
});

describe('hadron_read_secret', () => {
  it('returns the decrypted value + winning scope, and the trail line never carries the value', async () => {
    await seedGeneric('user', user.id, 'sk-super-secret');
    const out = await hadronReadSecret.execute(ctx, { name: 'api-key' });
    expect(out).toEqual({
      name: 'api-key',
      kind: 'generic',
      scope: 'user',
      metadata: {},
      value: 'sk-super-secret',
    });
    const log = vi.mocked(ctx.log).mock.calls[0]![0];
    expect(log).toContain('api-key');
    expect(log).not.toContain('sk-super-secret');
  });

  it('fails loud on an unresolvable name and on a bad scope', async () => {
    await expect(hadronReadSecret.execute(ctx, { name: 'nope' })).rejects.toThrow(
      /no secret named "nope"/,
    );
    await expect(hadronReadSecret.execute(ctx, { name: 'x', scope: 'planet' })).rejects.toThrow(
      /"scope" must be one of/,
    );
  });

  it('refuses an inject-only kind (webfetch-auth) — never returns its value to the model', async () => {
    await db.secret.create({
      data: {
        ownerType: 'user',
        ownerId: user.id,
        name: 'poll-cred',
        kind: 'webfetch-auth',
        metadata: { type: 'bearer', urlPrefix: 'https://api.example.test/' },
        valueEncrypted: enc({ type: 'bearer', token: 'inject-only-secret' }),
      },
    });
    await expect(hadronReadSecret.execute(ctx, { name: 'poll-cred' })).rejects.toThrow(
      /kind "webfetch-auth"\) is inject-only/,
    );
    // A nearer inject-only secret shadows a farther readable one LOUD (the
    // cascade contract), so it can't be bypassed by name collision.
    await seedGeneric('org', org.id, 'readable-at-org', 'poll-cred');
    await expect(hadronReadSecret.execute(ctx, { name: 'poll-cred' })).rejects.toThrow(
      /inject-only/,
    );
    // Pinning the readable org scope reaches the generic secret.
    const pinned = await hadronReadSecret.execute(ctx, { name: 'poll-cred', scope: 'org' });
    expect(pinned).toMatchObject({ scope: 'org', value: 'readable-at-org' });
  });
});

describe('loadWebFetchAuthSecret + assertUrlWithinPrefix', () => {
  it('resolves, kind-asserts, origin-binds, and decrypts for the inject path', async () => {
    await db.secret.create({
      data: {
        ownerType: 'org',
        ownerId: org.id,
        name: 'portal-cred',
        kind: 'webfetch-auth',
        metadata: { type: 'header', urlPrefix: 'https://portal.example.test/api/' },
        valueEncrypted: enc({ type: 'header', name: 'X-Api-Key', value: 'shh' }),
      },
    });
    const resolved = await loadWebFetchAuthSecret(
      ctx,
      'portal-cred',
      undefined,
      'https://portal.example.test/api/status',
    );
    expect(resolved.auth).toEqual({ type: 'header', name: 'X-Api-Key', value: 'shh' });
    expect(resolved.urlPrefix).toBe('https://portal.example.test/api/');
    expect(resolved.secretId).toBeTruthy();

    await expect(
      loadWebFetchAuthSecret(ctx, 'portal-cred', undefined, 'https://portal.example.test.evil/api/status'),
    ).rejects.toThrow(/outside the secret urlPrefix/);
  });

  it('a nearer-scope wrong-kind match shadows instead of falling through', async () => {
    await seedGeneric('user', user.id, 'opaque', 'portal-cred');
    await db.secret.create({
      data: {
        ownerType: 'org',
        ownerId: org.id,
        name: 'portal-cred',
        kind: 'webfetch-auth',
        metadata: { type: 'bearer', urlPrefix: 'https://portal.example.test/' },
        valueEncrypted: enc({ type: 'bearer', token: 'shh' }),
      },
    });
    await expect(
      loadWebFetchAuthSecret(ctx, 'portal-cred', undefined, 'https://portal.example.test/x'),
    ).rejects.toThrow(/kind "generic", not "webfetch-auth"/);
    // Pinning the scope reaches the org credential explicitly.
    const pinned = await loadWebFetchAuthSecret(ctx, 'portal-cred', 'org', 'https://portal.example.test/x');
    expect(pinned.auth).toEqual({ type: 'bearer', token: 'shh' });
  });

  it('assertUrlWithinPrefix rejects near misses and malformed prefixes', () => {
    expect(() => assertUrlWithinPrefix('https://a.test/v1/x', 'https://a.test/v1/')).not.toThrow();
    expect(() => assertUrlWithinPrefix('https://a.test/v1', 'https://a.test/v1')).not.toThrow();
    expect(() => assertUrlWithinPrefix('https://a.test/v10/x', 'https://a.test/v1')).toThrow(
      /outside the secret urlPrefix/,
    );
    expect(() => assertUrlWithinPrefix('https://a.test.evil/v1/x', 'https://a.test/v1/')).toThrow(
      /outside the secret urlPrefix/,
    );
    expect(() => assertUrlWithinPrefix('https://a.test/v1/x', 'https://a.test/v1/?q=1')).toThrow(
      /without userinfo, query, or fragment/,
    );
  });
});
