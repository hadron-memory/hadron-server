/**
 * hadrontool-home-assistant — the HomeAssistantInstance registry GraphQL
 * surface (hadron-server#640, mirrors resolvers.mcpServer.test.ts).
 *
 * What this file pins:
 *   - createHomeAssistantInstance: org-ADMIN gate, slug grammar + per-org
 *     uniqueness, URL validation, token encryption (plaintext never lands
 *     in a column), opAllowlist validation against the closed catalog.
 *   - updateHomeAssistantInstance: field updates, token replace,
 *     no-disclosure NOT_FOUND for outsiders.
 *   - deleteHomeAssistantInstance: hard delete, ADMIN-gated.
 *   - homeAssistantInstance(ref): null for missing AND for non-member.
 *   - homeAssistantInstances: uniform page scoped to member orgs (cor:api:120).
 *   - homeAssistantInstanceOps: static catalog filtered by allowlist,
 *     run-tool name composition, disabled → typed error.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { HA_OPS } from '../../../lib/homeAssistant.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };

function ctxFor(userId: string): Context {
  return { db, roles: ['READER'], userId } as Context;
}

async function createUser(name: string, orgId: string | null, role: 'OWNER' | 'ADMIN' | 'READER' = 'READER') {
  const user = await db.user.create({
    data: { id: generateId(), email: `${name}@ha.test`, name },
  });
  if (orgId) {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: user.id, role },
    });
  }
  return user;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'ha-org', urn: 'ha-org' } });
  admin = await createUser('admin', org.id, 'ADMIN');
  member = await createUser('member', org.id, 'READER');
  outsider = await createUser('outsider', null);
});

async function createInstance(overrides: Record<string, unknown> = {}, ctx?: Context) {
  return resolvers.Mutation.createHomeAssistantInstance(
    {},
    {
      orgRef: org.id,
      slug: 'home',
      name: 'Holger home',
      url: 'https://ha.example.com',
      accessToken: 'eyJhbGciOi.long-lived.token',
      ...overrides,
    } as never,
    ctx ?? ctxFor(admin.id),
  );
}

describe('createHomeAssistantInstance', () => {
  it('registers an instance (org ADMIN) with defaults', async () => {
    const instance = await createInstance();
    expect(instance).toMatchObject({
      organizationId: org.id,
      slug: 'home',
      name: 'Holger home',
      url: 'https://ha.example.com',
      opAllowlist: [],
      enabled: true,
    });
  });

  it('encrypts the access token at rest — the plaintext never lands in a column', async () => {
    const instance = await createInstance({ accessToken: 'sk-ha-secret-456' });
    const raw = await db.homeAssistantInstance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(JSON.stringify(raw)).not.toContain('sk-ha-secret-456');
    expect(decryptToken(raw.tokenEncrypted)).toBe('sk-ha-secret-456');
  });

  it('requires org ADMIN (plain member is Forbidden)', async () => {
    await expect(createInstance({}, ctxFor(member.id))).rejects.toThrow('Forbidden');
  });

  it('rejects a bad slug, a bad URL, credentialed URLs, whitespace tokens, and unknown ops', async () => {
    await expect(createInstance({ slug: 'Has_Underscore' })).rejects.toThrow(/slug/);
    await expect(createInstance({ url: 'not-a-url' })).rejects.toThrow(/absolute URL/);
    await expect(createInstance({ url: 'https://user:pw@ha.example.com' })).rejects.toThrow(/credentials/);
    await expect(createInstance({ url: 'https://ha.example.com/?query=1' })).rejects.toThrow(/base URL/);
    await expect(createInstance({ url: 'https://ha.example.com/#frag' })).rejects.toThrow(/base URL/);
    await expect(createInstance({ accessToken: 'has space' })).rejects.toThrow(/accessToken/);
    await expect(createInstance({ accessToken: '' })).rejects.toThrow(/accessToken/);
    await expect(createInstance({ opAllowlist: ['call_service', 'reboot_house'] })).rejects.toThrow(
      /Unknown op/,
    );
  });

  it('rejects a duplicate slug in the same org, allows it in another org', async () => {
    await createInstance();
    await expect(createInstance()).rejects.toThrow(/already exists/);

    const org2 = await db.organization.create({ data: { id: generateId(), name: 'o2', urn: 'ha-org-2' } });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org2.id, userId: admin.id, role: 'ADMIN' },
    });
    const other = await createInstance({ orgRef: org2.id });
    expect(other.organizationId).toBe(org2.id);
  });
});

describe('updateHomeAssistantInstance', () => {
  it('updates fields and replaces the token', async () => {
    const instance = await createInstance({ accessToken: 'token-one' });

    const renamed = await resolvers.Mutation.updateHomeAssistantInstance(
      {},
      { ref: instance.id, name: 'Home v2', accessToken: 'token-two', opAllowlist: ['get_state'] } as never,
      ctxFor(admin.id),
    );
    expect(renamed.name).toBe('Home v2');
    expect(renamed.opAllowlist).toEqual(['get_state']);
    expect(decryptToken(renamed.tokenEncrypted)).toBe('token-two');
  });

  it('answers NOT_FOUND identically for missing and for an outsider (no disclosure)', async () => {
    const instance = await createInstance();
    await expect(
      resolvers.Mutation.updateHomeAssistantInstance({}, { ref: 'nope', name: 'x' } as never, ctxFor(admin.id)),
    ).rejects.toThrow('Home Assistant instance not found.');
    await expect(
      resolvers.Mutation.updateHomeAssistantInstance(
        {},
        { ref: instance.id, name: 'x' } as never,
        ctxFor(outsider.id),
      ),
    ).rejects.toThrow('Home Assistant instance not found.');
  });
});

describe('deleteHomeAssistantInstance', () => {
  it('hard-deletes (ADMIN); member is Forbidden', async () => {
    const instance = await createInstance();
    await expect(
      resolvers.Mutation.deleteHomeAssistantInstance({}, { ref: instance.id }, ctxFor(member.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      resolvers.Mutation.deleteHomeAssistantInstance({}, { ref: instance.id }, ctxFor(admin.id)),
    ).resolves.toBe(true);
    expect(await db.homeAssistantInstance.findUnique({ where: { id: instance.id } })).toBeNull();
  });
});

describe('homeAssistantInstance / homeAssistantInstances reads', () => {
  it('find-one: member sees it, outsider and missing both get null', async () => {
    const instance = await createInstance();
    expect(
      await resolvers.Query.homeAssistantInstance({}, { ref: instance.id }, ctxFor(member.id)),
    ).toMatchObject({ slug: 'home' });
    expect(await resolvers.Query.homeAssistantInstance({}, { ref: instance.id }, ctxFor(outsider.id))).toBeNull();
    expect(await resolvers.Query.homeAssistantInstance({}, { ref: 'missing' }, ctxFor(member.id))).toBeNull();
  });

  it('list: scoped to member orgs (non-member gets an empty page)', async () => {
    const instance = await createInstance();
    const page = await resolvers.Query.homeAssistantInstances({}, {}, ctxFor(member.id));
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe(instance.id);

    const outsiderPage = await resolvers.Query.homeAssistantInstances(
      {},
      { orgId: org.id },
      ctxFor(outsider.id),
    );
    expect(outsiderPage).toEqual({ items: [], total: 0 });
  });
});

describe('homeAssistantInstanceOps', () => {
  it('returns the full closed catalog with composed run-tool names when no allowlist', async () => {
    const instance = await createInstance();
    const ops = await resolvers.Query.homeAssistantInstanceOps({}, { ref: instance.id }, ctxFor(member.id));
    expect(ops).toHaveLength(HA_OPS.length);
    expect(ops!.map((o: { runToolName: string }) => o.runToolName)).toContain('ha__home__call_service');
  });

  it('filters by the op allowlist (read-only registration)', async () => {
    const instance = await createInstance({ opAllowlist: ['get_state', 'list_states'] });
    const ops = await resolvers.Query.homeAssistantInstanceOps({}, { ref: instance.id }, ctxFor(member.id));
    expect(ops!.map((o: { op: string }) => o.op).sort()).toEqual(['get_state', 'list_states']);
  });

  it('returns null for an outsider; errors typed on a disabled instance', async () => {
    const instance = await createInstance({ enabled: false });
    expect(
      await resolvers.Query.homeAssistantInstanceOps({}, { ref: instance.id }, ctxFor(outsider.id)),
    ).toBeNull();
    await expect(
      resolvers.Query.homeAssistantInstanceOps({}, { ref: instance.id }, ctxFor(member.id)),
    ).rejects.toThrow(/disabled/);
  });
});
