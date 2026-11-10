import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveAppRef } from './appRef.js';
import { AppNotFoundError, UrnNotQualifiedError, AmbiguousLegacyUrnError } from './errors.js';
import { generateId } from '../id.js';

const db = new PrismaClient();

let orgId: string;

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.app.deleteMany({ where: { name: { startsWith: 'appref-test-' } } });
  await db.organization.deleteMany({ where: { name: { startsWith: 'appref-test-' } } });
  const org = await db.organization.create({
    data: { name: 'appref-test-org', urn: `appref-test-org-${Date.now()}` },
  });
  orgId = org.id;
});

describe('resolveAppRef', () => {
  it('resolves an ID-shaped reference', async () => {
    const app = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-test-app-id`,
        name: 'appref-test-app-id',
      },
    });
    expect(await resolveAppRef(db, app.id)).toEqual({ id: app.id });
  });

  it('resolves a bare URN', async () => {
    const app = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-test-app-urn`,
        name: 'appref-test-app-urn',
      },
    });
    expect(await resolveAppRef(db, app.urn)).toEqual({ id: app.id });
  });

  it('resolves a prefixed URN (urn:app: prefix stripped)', async () => {
    const app = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-test-app-prefixed`,
        name: 'appref-test-app-prefixed',
      },
    });
    expect(await resolveAppRef(db, `urn:app:${app.urn}`)).toEqual({ id: app.id });
  });

  it('throws AppNotFoundError on miss (ID)', async () => {
    // 32-char hex — ID-shape, bypasses the spec-022 qualification check
    // and goes straight to DB lookup, which misses.
    await expect(
      resolveAppRef(db, '0123456789abcdef0123456789abcdef'),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('throws AppNotFoundError on miss (URN)', async () => {
    await expect(resolveAppRef(db, 'no-such-org:no-such-app')).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });

  it('throws AppNotFoundError for a soft-deleted app', async () => {
    const app = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-test-app-deleted`,
        name: 'appref-test-app-deleted',
        deletedAt: new Date(),
      },
    });
    await expect(resolveAppRef(db, app.id)).rejects.toBeInstanceOf(AppNotFoundError);
    await expect(resolveAppRef(db, app.urn)).rejects.toBeInstanceOf(AppNotFoundError);
  });

  // ===================================================================
  // spec 022 — API-boundary URN qualification (FR-001, FR-002, FR-019)
  // ===================================================================

  it('rejects bare single-segment input as UrnNotQualifiedError (not an app URN)', async () => {
    await expect(resolveAppRef(db, 'dev-app')).rejects.toBeInstanceOf(UrnNotQualifiedError);
  });

  it('rejects empty input as UrnNotQualifiedError', async () => {
    await expect(resolveAppRef(db, '')).rejects.toBeInstanceOf(UrnNotQualifiedError);
  });

  it('rejects urn:agent: prefix (wrong type) as UrnNotQualifiedError', async () => {
    await expect(resolveAppRef(db, 'urn:agent:acme.com::coding-agent')).rejects.toBeInstanceOf(
      UrnNotQualifiedError,
    );
  });

  // ===================================================================
  // spec 021 FR-027 — partial unique index on `apps.urn`. URN lookups
  // resolve to the ACTIVE row only (`uninstalled_at IS NULL`); uninstall
  // history rows sharing the same URN are not found by `resolveAppRef`.
  // ID lookups still find any row regardless of uninstall status (the
  // PK has no partial filter).
  // ===================================================================

  it('returns the active row when the URN is also held by an uninstalled history row', async () => {
    const sharedUrn = `${orgId}:appref-shared-urn`;
    await db.app.create({
      data: {
        organizationId: orgId,
        urn: sharedUrn,
        name: 'appref-shared-urn (old)',
        uninstalledAt: new Date(),
      },
    });
    const active = await db.app.create({
      data: {
        organizationId: orgId,
        urn: sharedUrn,
        name: 'appref-shared-urn',
      },
    });
    const resolved = await resolveAppRef(db, sharedUrn);
    expect(resolved.id).toBe(active.id);
  });

  it('throws AppNotFoundError on URN lookup when only an uninstalled row matches', async () => {
    const sharedUrn = `${orgId}:appref-only-uninstalled`;
    await db.app.create({
      data: {
        organizationId: orgId,
        urn: sharedUrn,
        name: 'appref-only-uninstalled',
        uninstalledAt: new Date(),
      },
    });
    await expect(resolveAppRef(db, sharedUrn)).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('finds an uninstalled App by ID (PK lookup ignores uninstalled_at)', async () => {
    const uninstalled = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-byid-uninstalled`,
        name: 'appref-byid-uninstalled',
        uninstalledAt: new Date(),
      },
    });
    const resolved = await resolveAppRef(db, uninstalled.id);
    expect(resolved.id).toBe(uninstalled.id);
  });

  it('excludes a soft-deleted app by default; includeDeleted opts in', async () => {
    const app = await db.app.create({
      data: { organizationId: orgId, urn: `${orgId}:appref-test-deleted`, name: 'appref-test-deleted', deletedAt: new Date() },
    });
    await expect(resolveAppRef(db, app.id)).rejects.toBeInstanceOf(AppNotFoundError);
    await expect(resolveAppRef(db, app.id, { includeDeleted: true })).resolves.toEqual({ id: app.id });
  });
});

// #2314 — `scope` is a tenant-isolation defence of the resolver itself, pinned here directly. The whoami
// end-to-end tests cannot see it fail: their final session filter narrows rows even if a resolver drops `scope`.
describe('resolveAppRef — scope (#2314)', () => {
  const mkApp = (slug: string, extra: Record<string, unknown> = {}) =>
    db.app.create({ data: { organizationId: orgId, urn: `${orgId}:appref-test-${slug}`, name: `appref-test-${slug}`, ...extra } });

  it('behaves identically with no options and with empty options', async () => {
    const app = await mkApp('scope-default');
    expect(await resolveAppRef(db, app.urn)).toEqual({ id: app.id });
    expect(await resolveAppRef(db, app.urn, {})).toEqual({ id: app.id });
    expect(await resolveAppRef(db, app.id, {})).toEqual({ id: app.id });
  });

  it('applies scope to the primary URN and ID lookups', async () => {
    const mine = await mkApp('scope-mine');
    const other = await mkApp('scope-other');
    expect(await resolveAppRef(db, mine.urn, { scope: { id: mine.id } })).toEqual({ id: mine.id });
    await expect(resolveAppRef(db, other.urn, { scope: { id: mine.id } })).rejects.toBeInstanceOf(AppNotFoundError);
    await expect(resolveAppRef(db, other.id, { scope: { id: mine.id } })).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('lets an accessible legacy-URN holder resolve past an inaccessible primary-URN claimant', async () => {
    const u = `${orgId}:appref-test-claimed`;
    const inaccessible = await db.app.create({ data: { organizationId: orgId, urn: u, name: 'appref-test-x' } });
    const accessible = await mkApp('scope-y', { legacyUrn: u });
    expect(await resolveAppRef(db, u)).toEqual({ id: inaccessible.id });
    expect(await resolveAppRef(db, u, { scope: { id: accessible.id } })).toEqual({ id: accessible.id });
    await expect(resolveAppRef(db, u, { scope: { id: generateId() } })).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('does not let an inaccessible legacy-URN claimant create ambiguity', async () => {
    const u = `${orgId}:appref-test-legacy-shared`;
    const x = await mkApp('scope-lx', { legacyUrn: u });
    const y = await mkApp('scope-ly', { legacyUrn: u });
    await expect(resolveAppRef(db, u)).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
    expect(await resolveAppRef(db, u, { scope: { id: y.id } })).toEqual({ id: y.id });
    await expect(resolveAppRef(db, u, { scope: { id: { in: [x.id, y.id] } } })).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
  });

  it('constrains the rename-alias map to the scope', async () => {
    const u = `${orgId}:appref-test-renamed-from`;
    const x = await mkApp('scope-ax');
    const y = await mkApp('scope-ay');
    for (const app of [x, y]) {
      await db.urnAlias.create({ data: { reason: 'RENAME', entityType: 'APP', entityId: app.id, urn: u } });
    }
    await expect(resolveAppRef(db, u)).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
    expect(await resolveAppRef(db, u, { scope: { id: y.id } })).toEqual({ id: y.id });
    await expect(resolveAppRef(db, u, { scope: { id: { in: [x.id, y.id] } } })).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
    await expect(resolveAppRef(db, u, { scope: { id: generateId() } })).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('reads no alias rows when the scope admits no App', async () => {
    const spy = vi.spyOn(db.urnAlias, 'findMany');
    try {
      await expect(resolveAppRef(db, `${orgId}:appref-test-nothing`, { scope: { id: generateId() } }))
        .rejects.toBeInstanceOf(AppNotFoundError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps uninstalled and soft-deleted Apps excluded under a scope, and still ANDs the scope with includeDeleted', async () => {
    const uninstalled = await mkApp('scope-uninstalled', { uninstalledAt: new Date() });
    const deleted = await mkApp('scope-deleted', { deletedAt: new Date() });
    await expect(resolveAppRef(db, uninstalled.urn, { scope: { id: uninstalled.id } })).rejects.toBeInstanceOf(AppNotFoundError);
    await expect(resolveAppRef(db, deleted.id, { scope: { id: deleted.id } })).rejects.toBeInstanceOf(AppNotFoundError);
    expect(await resolveAppRef(db, deleted.id, { scope: { id: deleted.id }, includeDeleted: true })).toEqual({ id: deleted.id });
    await expect(resolveAppRef(db, deleted.id, { scope: { id: generateId() }, includeDeleted: true }))
      .rejects.toBeInstanceOf(AppNotFoundError);
  });
});
