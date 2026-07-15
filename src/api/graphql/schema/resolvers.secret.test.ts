/**
 * General secret store (#677) — the Secret registry GraphQL surface.
 *
 * What this file pins:
 *   - createSecret: the per-owner-scope gate matrix (user strict-owner,
 *     org ADMIN, app owner/org-ADMIN, memory WRITE), name grammar,
 *     per-kind validation, value encryption at rest (plaintext never
 *     lands in a column), per-owner name uniqueness.
 *   - updateSecret: value rotation + metadata re-validation, immutable
 *     name/kind/owner, no-disclosure NOT_FOUND for outsiders.
 *   - deleteSecret: hard delete, write-gated.
 *   - secret(ref): null for missing AND for non-entitled.
 *   - secrets: per-owner page, empty page for non-entitled (no disclosure).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string };
let admin: { id: string };
let contributor: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string };
let memory: { id: string };

function ctxFor(userId: string, roles: Context['roles'] = ['READER']): Context {
  return { db, roles, userId } as Context;
}

async function createUser(
  name: string,
  orgId: string | null,
  role: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER' = 'READER',
) {
  const user = await db.user.create({
    data: { id: generateId(), email: `${name}@secret.test`, name },
  });
  if (orgId) {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: user.id, role },
    });
  }
  return user;
}

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  await cleanDb(db);

  org = await db.organization.create({
    data: { id: generateId(), name: 'secret-org', urn: 'secret-org' },
  });
  admin = await createUser('admin', org.id, 'ADMIN');
  contributor = await createUser('contributor', org.id, 'CONTRIBUTOR');
  member = await createUser('member', org.id, 'READER');
  outsider = await createUser('outsider', null);
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, urn: 'secret-org::app', name: 'App' },
  });
  memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: 'secret-org::kb',
      name: 'kb',
      class: 'knowledge',
    },
  });
});

async function createSecret(overrides: Record<string, unknown> = {}, ctx?: Context) {
  return resolvers.Mutation.createSecret(
    {},
    {
      ownerType: 'org',
      ownerRef: org.id,
      name: 'api-key',
      kind: 'generic',
      value: 'sk-secret-123',
      ...overrides,
    } as never,
    ctx ?? ctxFor(admin.id),
  );
}

describe('createSecret — gate matrix', () => {
  it('org scope: ADMIN creates, plain member is Forbidden', async () => {
    const secret = await createSecret();
    expect(secret).toMatchObject({ ownerType: 'org', ownerId: org.id, name: 'api-key', kind: 'generic' });
    await expect(createSecret({}, ctxFor(member.id))).rejects.toThrow('Forbidden');
  });

  it('user scope: strict owner-only — self ok (ownerRef optional), admins and others Forbidden', async () => {
    const own = await createSecret({ ownerType: 'user', ownerRef: null }, ctxFor(member.id));
    expect(own).toMatchObject({ ownerType: 'user', ownerId: member.id });
    // Another user, an org admin, and even a PLATFORM admin cannot manage it.
    await expect(
      createSecret({ ownerType: 'user', ownerRef: member.id, name: 'x' }, ctxFor(outsider.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      createSecret({ ownerType: 'user', ownerRef: member.id, name: 'x' }, ctxFor(admin.id, ['ADMIN'])),
    ).rejects.toThrow('Forbidden');
  });

  it('app scope: org ADMIN creates, plain member is Forbidden', async () => {
    const secret = await createSecret({ ownerType: 'app', ownerRef: app.id }, ctxFor(admin.id));
    expect(secret).toMatchObject({ ownerType: 'app', ownerId: app.id });
    await expect(
      createSecret({ ownerType: 'app', ownerRef: app.id, name: 'x' }, ctxFor(member.id)),
    ).rejects.toThrow('Forbidden');
  });

  it('memory scope: memory WRITE (org CONTRIBUTOR+) creates, READER is Forbidden', async () => {
    const secret = await createSecret({ ownerType: 'memory', ownerRef: memory.id }, ctxFor(contributor.id));
    expect(secret).toMatchObject({ ownerType: 'memory', ownerId: memory.id });
    await expect(
      createSecret({ ownerType: 'memory', ownerRef: memory.id, name: 'x' }, ctxFor(member.id)),
    ).rejects.toThrow('Forbidden');
  });

  // Regression (Codex P2): the memory READ gate (canSeeSecretOwner) must match
  // the WRITE gate (requireMemoryWriteAccess) across principal types. An
  // App-key caller with memory write via an installed agent could otherwise
  // CREATE a memory-scoped secret it then couldn't see/update/delete, because
  // the portal getAccessibleMemoryIds grants an App key no memory access
  // outside an active session — canReadMemory closes that drift.
  it('memory scope: an App-key writer can also see/update/delete its own secret (gate parity)', async () => {
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'secret-org::agent',
        name: 'Agent',
        visibility: 'ORGANIZATION',
      },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: memory.id, role: 'read-write' } });
    const appCtx = { db, appId: app.id, roles: [] } as unknown as Context;

    const secret = await createSecret({ ownerType: 'memory', ownerRef: memory.id }, appCtx);
    expect(secret).toMatchObject({ ownerType: 'memory', ownerId: memory.id });
    // Previously NOT_FOUND for the very principal that created it.
    expect(await resolvers.Query.secret({}, { ref: secret.id }, appCtx)).toMatchObject({ id: secret.id });
    const page = await resolvers.Query.secrets({}, { ownerType: 'memory', ownerRef: memory.id }, appCtx);
    expect(page.total).toBe(1);
    await expect(
      resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'rot' } as never, appCtx),
    ).resolves.toBeTruthy();
    await expect(resolvers.Mutation.deleteSecret({}, { ref: secret.id }, appCtx)).resolves.toBe(true);
  });
});

describe('createSecret — validation + encryption', () => {
  it('encrypts the value at rest — the plaintext never lands in a column', async () => {
    const secret = await createSecret();
    const raw = await db.secret.findUniqueOrThrow({ where: { id: secret.id } });
    expect(JSON.stringify(raw)).not.toContain('sk-secret-123');
    expect(JSON.parse(decryptToken(raw.valueEncrypted))).toBe('sk-secret-123');
  });

  it('rejects a bad ownerType, a bad name, an unknown kind, and a missing value', async () => {
    await expect(createSecret({ ownerType: 'galaxy' })).rejects.toThrow(/ownerType must be one of/);
    await expect(createSecret({ name: 'has_underscore' })).rejects.toThrow(/name must be lowercase/);
    await expect(createSecret({ kind: 'aws-creds' })).rejects.toThrow(/Unknown secret kind/);
    await expect(createSecret({ value: null })).rejects.toThrow(/value is required/);
  });

  it('validates the webfetch-auth kind: payload shape, urlPrefix presence + shape, type derivation', async () => {
    const good = await createSecret({
      kind: 'webfetch-auth',
      metadata: { urlPrefix: 'https://api.example.test/v1/' },
      value: { type: 'bearer', token: 'tok' },
    });
    // metadata.type is derived from the payload so the halves cannot drift.
    expect(good.metadata).toEqual({ urlPrefix: 'https://api.example.test/v1/', type: 'bearer' });

    await expect(
      createSecret({ name: 'b', kind: 'webfetch-auth', metadata: { urlPrefix: 'https://x.test/' }, value: { type: 'bearer' } }),
    ).rejects.toThrow(/webfetch-auth value must be/);
    await expect(
      createSecret({ name: 'c', kind: 'webfetch-auth', value: { type: 'bearer', token: 't' } }),
    ).rejects.toThrow(/requires metadata.urlPrefix/);
    await expect(
      createSecret({
        name: 'd',
        kind: 'webfetch-auth',
        metadata: { urlPrefix: 'https://x.test/?q=1' },
        value: { type: 'bearer', token: 't' },
      }),
    ).rejects.toThrow(/without userinfo, query, or fragment/);
    await expect(
      createSecret({
        name: 'e',
        kind: 'webfetch-auth',
        metadata: { urlPrefix: 'https://x.test/', type: 'basic' },
        value: { type: 'bearer', token: 't' },
      }),
    ).rejects.toThrow(/metadata.type must match/);
  });

  it('rejects a duplicate name at the same owner, allows it at another scope', async () => {
    await createSecret();
    await expect(createSecret()).rejects.toThrow(/already exists/);
    const other = await createSecret({ ownerType: 'app', ownerRef: app.id });
    expect(other).toMatchObject({ ownerType: 'app', name: 'api-key' });
  });
});

describe('updateSecret', () => {
  it('rotates the value and re-validates metadata; outsiders get no-disclosure NOT_FOUND; viewers without write get Forbidden', async () => {
    const secret = await createSecret();
    const rotated = await resolvers.Mutation.updateSecret(
      {},
      { ref: secret.id, value: 'sk-rotated' } as never,
      ctxFor(admin.id),
    );
    expect(JSON.parse(decryptToken(rotated.valueEncrypted))).toBe('sk-rotated');
    expect(rotated.updatedBy).toBe(admin.id);

    await expect(
      resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'x' } as never, ctxFor(outsider.id)),
    ).rejects.toThrow('Secret not found.');
    // An org member can SEE the org secret but not write it.
    await expect(
      resolvers.Mutation.updateSecret({}, { ref: secret.id, value: 'x' } as never, ctxFor(member.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      resolvers.Mutation.updateSecret({}, { ref: secret.id } as never, ctxFor(admin.id)),
    ).rejects.toThrow(/Pass metadata and\/or value/);
  });

  it('re-validates the webfetch-auth pair when only one half changes', async () => {
    const secret = await createSecret({
      kind: 'webfetch-auth',
      metadata: { urlPrefix: 'https://api.example.test/' },
      value: { type: 'bearer', token: 'tok' },
    });
    // Metadata-only update: stored value is decrypted server-side and the
    // pair re-validated — a prefix with a query string still fails.
    await expect(
      resolvers.Mutation.updateSecret(
        {},
        { ref: secret.id, metadata: { urlPrefix: 'https://api.example.test/?q=1' } } as never,
        ctxFor(admin.id),
      ),
    ).rejects.toThrow(/without userinfo, query, or fragment/);
    const moved = await resolvers.Mutation.updateSecret(
      {},
      { ref: secret.id, metadata: { urlPrefix: 'https://api.example.test/v2/' } } as never,
      ctxFor(admin.id),
    );
    expect(moved.metadata).toEqual({ urlPrefix: 'https://api.example.test/v2/', type: 'bearer' });
    expect(JSON.parse(decryptToken(moved.valueEncrypted))).toEqual({ type: 'bearer', token: 'tok' });
  });
});

describe('deleteSecret', () => {
  it('hard-deletes (write-gated); outsiders get NOT_FOUND, members Forbidden', async () => {
    const secret = await createSecret();
    await expect(
      resolvers.Mutation.deleteSecret({}, { ref: secret.id }, ctxFor(outsider.id)),
    ).rejects.toThrow('Secret not found.');
    await expect(
      resolvers.Mutation.deleteSecret({}, { ref: secret.id }, ctxFor(member.id)),
    ).rejects.toThrow('Forbidden');
    await expect(resolvers.Mutation.deleteSecret({}, { ref: secret.id }, ctxFor(admin.id))).resolves.toBe(true);
    expect(await db.secret.findUnique({ where: { id: secret.id } })).toBeNull();
  });
});

describe('secret(ref) + secrets list', () => {
  it('secret(ref): inspectable half for the entitled, null for outsiders and for missing', async () => {
    const secret = await createSecret();
    const seen = await resolvers.Query.secret({}, { ref: secret.id }, ctxFor(member.id));
    expect(seen).toMatchObject({ id: secret.id, kind: 'generic' });
    expect(await resolvers.Query.secret({}, { ref: secret.id }, ctxFor(outsider.id))).toBeNull();
    expect(await resolvers.Query.secret({}, { ref: 'missing' }, ctxFor(admin.id))).toBeNull();

    const personal = await createSecret({ ownerType: 'user', ownerRef: null, name: 'mine' }, ctxFor(member.id));
    expect(await resolvers.Query.secret({}, { ref: personal.id }, ctxFor(admin.id))).toBeNull();
    expect(await resolvers.Query.secret({}, { ref: personal.id }, ctxFor(member.id))).toMatchObject({
      name: 'mine',
    });
  });

  it('secrets: per-owner page for the entitled, empty page for non-entitled (no disclosure)', async () => {
    await createSecret();
    await createSecret({ name: 'zeta-key' });
    await createSecret({ ownerType: 'user', ownerRef: null, name: 'mine' }, ctxFor(member.id));

    const page = await resolvers.Query.secrets(
      {},
      { ownerType: 'org', ownerRef: org.id },
      ctxFor(member.id),
    );
    expect(page.total).toBe(2);
    expect(page.items.map((s: { name: string }) => s.name)).toEqual(['api-key', 'zeta-key']);

    const denied = await resolvers.Query.secrets(
      {},
      { ownerType: 'org', ownerRef: org.id },
      ctxFor(outsider.id),
    );
    expect(denied).toEqual({ items: [], total: 0 });

    // ownerType user defaults to the caller.
    const own = await resolvers.Query.secrets({}, { ownerType: 'user' }, ctxFor(member.id));
    expect(own.total).toBe(1);
    expect(own.items[0]).toMatchObject({ name: 'mine', ownerId: member.id });

    const countOnly = await resolvers.Query.secrets(
      {},
      { ownerType: 'org', ownerRef: org.id, limit: 0 },
      ctxFor(member.id),
    );
    expect(countOnly).toMatchObject({ items: [], total: 2 });
  });
});

// #677 follow-up: an owner's secrets must not outlive its deletion as live,
// resolvable credentials (secret resolution doesn't re-check owner deletedAt).
describe('owner deletion cleans up secrets', () => {
  it('deleteApp hard-deletes the app-scoped secrets', async () => {
    const secret = await createSecret({ ownerType: 'app', ownerRef: app.id }, ctxFor(admin.id));
    expect(await db.secret.findUnique({ where: { id: secret.id } })).not.toBeNull();
    await expect(resolvers.Mutation.deleteApp({}, { id: app.id }, ctxFor(admin.id))).resolves.toBe(true);
    expect(await db.secret.findUnique({ where: { id: secret.id } })).toBeNull();
  });

  it('deleteOrganization hard-deletes the org-scoped secrets', async () => {
    const secret = await createSecret({ ownerType: 'org', ownerRef: org.id }, ctxFor(admin.id));
    // deleteOrganization requires platform ADMIN (requireRole).
    await expect(
      resolvers.Mutation.deleteOrganization({}, { id: org.id }, ctxFor(admin.id, ['ADMIN'])),
    ).resolves.toBe(true);
    expect(await db.secret.findUnique({ where: { id: secret.id } })).toBeNull();
  });

  it('deleteMemory hard-deletes the memory-scoped secrets', async () => {
    const personal = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: 'secret-org::mine',
        name: 'mine',
        class: 'personal',
        userId: member.id,
      },
    });
    const secret = await createSecret(
      { ownerType: 'memory', ownerRef: personal.id, name: 'k' },
      ctxFor(member.id),
    );
    await expect(
      resolvers.Mutation.deleteMemory({}, { id: personal.id }, ctxFor(member.id)),
    ).resolves.toBe(true);
    expect(await db.secret.findUnique({ where: { id: secret.id } })).toBeNull();
  });
});
