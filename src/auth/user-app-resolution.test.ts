import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import {
  resolveUserApps,
  resolveAppForRequest,
  resolveUserAppsWithMeta,
  resolveAppIdentifier,
} from './user-app-resolution.js';

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

  // ── Spec 026: resolveUserAppsWithMeta + resolveAppIdentifier ────────

  describe('resolveUserAppsWithMeta (spec 026 — richer list)', () => {
    it('returns urn, name, organizationId, role per accessible App', async () => {
      const id = await createAppWithMember('alpha', user.id);
      const apps = await resolveUserAppsWithMeta(user.id, db);
      expect(apps).toHaveLength(1);
      expect(apps[0]).toEqual({
        id,
        urn: `${org.urn}:alpha`,
        name: 'alpha',
        organizationId: org.id,
        role: 'owner',
      });
    });

    it('preserves createdAt-ASC ordering across multiple Apps', async () => {
      const a = await createAppWithMember('alpha', user.id);
      const b = await createAppWithMember('beta', user.id);
      const c = await createAppWithMember('gamma', user.id);
      const apps = await resolveUserAppsWithMeta(user.id, db);
      expect(apps.map((x) => x.id)).toEqual([a, b, c]);
    });

    it('applies the same soft-delete + soft-uninstall filter as resolveUserApps', async () => {
      const activeId = await createAppWithMember('alpha', user.id);
      const delId = await createAppWithMember('beta-deleted', user.id);
      const uninstId = await createAppWithMember('gamma-uninstalled', user.id);
      await db.app.update({ where: { id: delId }, data: { deletedAt: new Date() } });
      await db.app.update({
        where: { id: uninstId },
        data: { uninstalledAt: new Date() },
      });
      const apps = await resolveUserAppsWithMeta(user.id, db);
      expect(apps).toHaveLength(1);
      expect(apps[0].id).toBe(activeId);
    });
  });

  describe('resolveAppIdentifier (spec 026 §Clarifications Q2)', () => {
    it('returns not-found for empty input', async () => {
      await createAppWithMember('alpha', user.id);
      expect(await resolveAppIdentifier('', user.id, db)).toEqual({
        kind: 'not-found',
      });
      expect(await resolveAppIdentifier('   ', user.id, db)).toEqual({
        kind: 'not-found',
      });
    });

    it('resolves a bare canonical URN exact-match', async () => {
      const id = await createAppWithMember('alpha', user.id);
      const r = await resolveAppIdentifier(`${org.urn}:alpha`, user.id, db);
      expect(r.kind).toBe('resolved');
      if (r.kind === 'resolved') {
        expect(r.app.id).toBe(id);
        expect(r.app.urn).toBe(`${org.urn}:alpha`);
        expect(r.app.role).toBe('owner');
      }
    });

    it('resolves a prefixed urn:app: URN', async () => {
      const id = await createAppWithMember('alpha', user.id);
      const r = await resolveAppIdentifier(`urn:app:${org.urn}:alpha`, user.id, db);
      expect(r.kind).toBe('resolved');
      if (r.kind === 'resolved') {
        expect(r.app.id).toBe(id);
      }
    });

    it('trims surrounding whitespace on URN form', async () => {
      const id = await createAppWithMember('alpha', user.id);
      const r = await resolveAppIdentifier(
        `   urn:app:${org.urn}:alpha   `,
        user.id,
        db,
      );
      expect(r.kind).toBe('resolved');
      if (r.kind === 'resolved') expect(r.app.id).toBe(id);
    });

    it('returns not-member when the URN names a real App the caller is not a member of', async () => {
      const otherUser = await db.user.create({
        data: { id: generateId(), handle: 'bob', githubUsername: 'bob' },
      });
      await createAppWithMember('alpha', otherUser.id); // bob owns it
      const r = await resolveAppIdentifier(`${org.urn}:alpha`, user.id, db);
      expect(r).toEqual({ kind: 'not-member' });
    });

    it('returns unavailable.deleted when the URN names a soft-deleted App', async () => {
      const id = await createAppWithMember('alpha', user.id);
      await db.app.update({ where: { id }, data: { deletedAt: new Date() } });
      const r = await resolveAppIdentifier(`${org.urn}:alpha`, user.id, db);
      expect(r).toEqual({ kind: 'unavailable', reason: 'deleted' });
    });

    it('returns unavailable.uninstalled when the URN names a soft-uninstalled App', async () => {
      const id = await createAppWithMember('alpha', user.id);
      await db.app.update({ where: { id }, data: { uninstalledAt: new Date() } });
      const r = await resolveAppIdentifier(`${org.urn}:alpha`, user.id, db);
      expect(r).toEqual({ kind: 'unavailable', reason: 'uninstalled' });
    });

    // Regression for the spec-021 partial-uniqueness gotcha. `App.urn` is
    // unique only across active rows (`apps_urn_active_uniq WHERE
    // uninstalled_at IS NULL`). A re-installed App produces an active
    // row + the original uninstalled history row sharing the same URN.
    // Before the active-row-preferring lookup, `findFirst({ where:
    // { urn: bare } })` could non-deterministically return the
    // history row, misclassifying an active App as `unavailable.
    // uninstalled`.
    it('returns the active row, not the uninstalled history row, after a re-install', async () => {
      // Install, uninstall (history row).
      const historyId = await createAppWithMember('alpha', user.id);
      await db.app.update({
        where: { id: historyId },
        data: { uninstalledAt: new Date() },
      });
      // Re-install — new row, same URN, active.
      const activeId = await createAppWithMember('alpha', user.id);

      const r = await resolveAppIdentifier(`${org.urn}:alpha`, user.id, db);
      // Resolves to the active row, with full membership intact.
      expect(r.kind).toBe('resolved');
      if (r.kind === 'resolved') {
        expect(r.app.id).toBe(activeId);
        expect(r.app.id).not.toBe(historyId);
        expect(r.app.role).toBe('owner');
      }
    });

    it('returns not-found when the URN names no real App', async () => {
      await createAppWithMember('alpha', user.id);
      const r = await resolveAppIdentifier(`${org.urn}:nonexistent`, user.id, db);
      expect(r).toEqual({ kind: 'not-found' });
    });

    it('resolves an unambiguous short-form (App name) case-insensitively', async () => {
      // App.name is set from the slug in our test helper, so "alpha" is the name.
      const id = await createAppWithMember('alpha', user.id);
      const r = await resolveAppIdentifier('ALPHA', user.id, db);
      expect(r.kind).toBe('resolved');
      if (r.kind === 'resolved') expect(r.app.id).toBe(id);
    });

    it('trims surrounding whitespace on short form', async () => {
      const id = await createAppWithMember('alpha', user.id);
      const r = await resolveAppIdentifier('  alpha  ', user.id, db);
      expect(r.kind).toBe('resolved');
      if (r.kind === 'resolved') expect(r.app.id).toBe(id);
    });

    it('returns ambiguous when a short form matches 2+ accessible Apps across orgs', async () => {
      // Two orgs, two Apps with the same display name. The caller is a
      // member of both → ambiguous.
      const org2 = await db.organization.create({
        data: { id: generateId(), name: 'Beta Co', urn: 'beta-co' },
      });
      const aId = await createAppWithMember('shared-name', user.id);
      const bApp = await db.app.create({
        data: {
          id: generateId(),
          organizationId: org2.id,
          name: 'shared-name',
          urn: `${org2.urn}:shared-name`,
        },
      });
      await db.appMember.create({
        data: { appId: bApp.id, userId: user.id, role: 'owner' },
      });

      const r = await resolveAppIdentifier('shared-name', user.id, db);
      expect(r.kind).toBe('ambiguous');
      if (r.kind === 'ambiguous') {
        expect(r.candidates).toHaveLength(2);
        const urns = r.candidates.map((c) => c.urn).sort();
        expect(urns).toEqual(
          [`${org.urn}:shared-name`, `${org2.urn}:shared-name`].sort(),
        );
        expect(r.candidates.every((c) => c.name === 'shared-name')).toBe(true);
      }
    });

    it('returns not-found for short-form that does not match any accessible App', async () => {
      await createAppWithMember('alpha', user.id);
      const r = await resolveAppIdentifier('not-an-app', user.id, db);
      expect(r).toEqual({ kind: 'not-found' });
    });

    it('does NOT match a short form against an App the user has no AppMember row for', async () => {
      // user has 'alpha'; otherUser has 'beta'. Searching 'beta' as user
      // must NOT resolve, because the resolver is scoped to accessible Apps.
      const otherUser = await db.user.create({
        data: { id: generateId(), handle: 'bob', githubUsername: 'bob' },
      });
      await createAppWithMember('alpha', user.id);
      await createAppWithMember('beta', otherUser.id);
      const r = await resolveAppIdentifier('beta', user.id, db);
      expect(r).toEqual({ kind: 'not-found' });
    });

    it('does NOT match a short form against a soft-deleted accessible App', async () => {
      const id = await createAppWithMember('alpha', user.id);
      await db.app.update({ where: { id }, data: { deletedAt: new Date() } });
      const r = await resolveAppIdentifier('alpha', user.id, db);
      expect(r).toEqual({ kind: 'not-found' });
    });
  });
});
