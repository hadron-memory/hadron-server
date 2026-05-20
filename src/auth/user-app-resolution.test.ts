import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolveUserApps, resolveAppForRequest } from './user-app-resolution.js';

let user: { id: string };
let org: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: { id: generateId(), handle: 'alice', githubUsername: 'alice' },
  });
  org = await db.organization.create({
    data: { id: generateId(), name: 'Acme', urn: 'acme' },
  });
});

async function createAppWithMember(slug: string, userId: string): Promise<string> {
  const app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: slug,
      urn: `${org.urn}:${slug}`,
    },
  });
  await db.appMember.create({
    data: { appId: app.id, userId, role: 'owner' },
  });
  return app.id;
}

describe('resolveUserApps', () => {
  it('returns an empty array for a user with no AppMember rows', async () => {
    const apps = await resolveUserApps(user.id, db);
    expect(apps).toEqual([]);
  });

  it('returns a single App for a user with exactly one AppMember', async () => {
    const appId = await createAppWithMember('alpha', user.id);
    const apps = await resolveUserApps(user.id, db);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toEqual({ id: appId, organizationId: org.id });
  });

  it('returns multiple Apps for a user with multiple AppMembers', async () => {
    const a = await createAppWithMember('alpha', user.id);
    const b = await createAppWithMember('beta', user.id);
    const c = await createAppWithMember('gamma', user.id);

    const apps = await resolveUserApps(user.id, db);
    expect(apps).toHaveLength(3);
    // Set comparison — order is by createdAt ASC, deterministic but
    // not load-bearing for the multi-App rejection logic.
    expect(apps.map((a) => a.id).sort()).toEqual([a, b, c].sort());
  });

  it('does not return Apps the user does not belong to (other-user isolation)', async () => {
    // user has 1 App; otherUser has 2 Apps. resolveUserApps for user
    // must NOT see otherUser's Apps.
    const otherUser = await db.user.create({
      data: { id: generateId(), handle: 'bob', githubUsername: 'bob' },
    });
    const userApp = await createAppWithMember('alpha', user.id);
    await createAppWithMember('beta', otherUser.id);
    await createAppWithMember('gamma', otherUser.id);

    const userApps = await resolveUserApps(user.id, db);
    expect(userApps).toHaveLength(1);
    expect(userApps[0].id).toBe(userApp);

    const otherApps = await resolveUserApps(otherUser.id, db);
    expect(otherApps).toHaveLength(2);
  });

  it('selects only id + organizationId (defense in depth — avoid leaking other App fields)', async () => {
    await createAppWithMember('alpha', user.id);
    const apps = await resolveUserApps(user.id, db);
    // The function's return type is { id, organizationId }, but
    // Prisma might return extra fields if select{} is misconfigured.
    // Verify the runtime shape matches the type contract exactly.
    const keys = Object.keys(apps[0]).sort();
    expect(keys).toEqual(['id', 'organizationId']);
  });

  // ── Soft-delete / soft-uninstall filter (PR #150 review) ──────────

  it('excludes soft-deleted Apps (App.deletedAt IS NOT NULL)', async () => {
    // User belongs to two Apps; one is soft-deleted. Without the
    // filter, FR-020's multi-App dispatch would 409 the user for a
    // historical row that the portal correctly hides.
    const activeAppId = await createAppWithMember('alpha', user.id);
    const deletedAppId = await createAppWithMember('beta-deleted', user.id);
    await db.app.update({
      where: { id: deletedAppId },
      data: { deletedAt: new Date() },
    });

    const apps = await resolveUserApps(user.id, db);
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe(activeAppId);
  });

  it('excludes soft-uninstalled Apps (App.uninstalledAt IS NOT NULL, spec 021 FR-025)', async () => {
    // App is alive (deletedAt: null) but marked uninstalled — the
    // AppMember row may persist across uninstall, but FR-020 must
    // treat the App as gone for the cardinality count.
    const activeAppId = await createAppWithMember('alpha', user.id);
    const uninstalledAppId = await createAppWithMember('beta-uninstalled', user.id);
    await db.app.update({
      where: { id: uninstalledAppId },
      data: { uninstalledAt: new Date() },
    });

    const apps = await resolveUserApps(user.id, db);
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe(activeAppId);
  });

  // ── resolveAppForRequest dispatch shape ───────────────────────────

  describe('resolveAppForRequest (FR-020 dispatch helper)', () => {
    it('returns { kind: "no-app" } when the user has no Apps', async () => {
      const r = await resolveAppForRequest(user.id, db);
      expect(r).toEqual({ kind: 'no-app' });
    });

    it('returns { kind: "resolved", appId, organizationId } for a single-App user', async () => {
      const appId = await createAppWithMember('alpha', user.id);
      const r = await resolveAppForRequest(user.id, db);
      expect(r).toEqual({
        kind: 'resolved',
        appId,
        organizationId: org.id,
      });
    });

    it('returns { kind: "multi-app" } for a 2+ App user', async () => {
      await createAppWithMember('alpha', user.id);
      await createAppWithMember('beta', user.id);
      const r = await resolveAppForRequest(user.id, db);
      expect(r).toEqual({ kind: 'multi-app' });
    });

    it('treats a soft-deleted-second App as single-App "resolved" (does not 409 false-positive)', async () => {
      const activeId = await createAppWithMember('alpha', user.id);
      const deletedId = await createAppWithMember('beta-deleted', user.id);
      await db.app.update({
        where: { id: deletedId },
        data: { deletedAt: new Date() },
      });

      const r = await resolveAppForRequest(user.id, db);
      expect(r).toEqual({
        kind: 'resolved',
        appId: activeId,
        organizationId: org.id,
      });
    });
  });
});
