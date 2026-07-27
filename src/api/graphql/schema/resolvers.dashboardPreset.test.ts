/**
 * #806 — `DashboardWidgetPreset`: named, user-scoped widget configurations.
 *
 * Pins: CRUD round-trip; owner-only gating (a foreign presetRef is
 * indistinguishable from a missing one); the (user, type, name) unique
 * constraint; the name + config guards; the type allowlist; list filtering and
 * ordering; and that a preset is a COPY source, not a live link — deleting one
 * leaves the placements seeded from it alone.
 *
 * Real-DB integration, resolvers called directly (the resolvers.dashboard.test
 * pattern), so GraphQL's own arg validation is bypassed and the resolver's
 * defensive guards are reachable.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let user: { id: string };
let other: { id: string };
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

/** Create a preset for `user`, defaults filled in. */
const create = (over: Record<string, unknown> = {}, as = () => ctx(user.id)) =>
  M.createDashboardWidgetPreset(
    null,
    { type: 'USAGE_ACTIVITY', name: 'Team memories, 30 days', config: { windowDays: 30 }, ...over },
    as(),
  );

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: { id: generateId(), handle: `dwp-user-${generateId().slice(-8)}` },
  });
  other = await db.user.create({
    data: { id: generateId(), handle: `dwp-other-${generateId().slice(-8)}` },
  });
});

describe('createDashboardWidgetPreset', () => {
  it('saves a named configuration and reads it back', async () => {
    const saved = await create();
    expect(saved).toMatchObject({
      type: 'USAGE_ACTIVITY',
      name: 'Team memories, 30 days',
      config: { windowDays: 30 },
    });

    const list = await Q.dashboardWidgetPresets(null, {}, ctx(user.id));
    expect(list.map((p: { id: string }) => p.id)).toEqual([saved.id]);
  });

  it('trims the name and rejects an empty or over-long one', async () => {
    const saved = await create({ name: '   Padded   ' });
    expect(saved.name).toBe('Padded');

    await expect(create({ name: '   ' })).rejects.toThrow(/name is required/);
    await expect(create({ name: 'x'.repeat(61) })).rejects.toThrow(/name is too long/);
    // Exactly at the bound is fine.
    expect((await create({ name: 'y'.repeat(60) })).name).toHaveLength(60);
  });

  it('rejects a config that is not a JSON object, or is over the 4KB cap', async () => {
    await expect(create({ config: 'not-an-object' })).rejects.toThrow(/config must be a JSON object/);
    await expect(create({ config: [1, 2] })).rejects.toThrow(/config must be a JSON object/);
    await expect(create({ config: null })).rejects.toThrow(/config must be a JSON object/);
    await expect(create({ config: { blob: 'x'.repeat(5000) } })).rejects.toThrow(
      /config is too large/,
    );
  });

  it('rejects a widget type with no registered provider', async () => {
    // The same allowlist setDashboardWidgets uses — a preset must never name a
    // widget that cannot be rendered.
    await expect(create({ type: 'BOGUS' })).rejects.toThrow(/Unknown widget type/);
  });

  it('rejects a duplicate name for the same (user, type)', async () => {
    await create({ name: 'Shared' });
    await expect(create({ name: 'Shared' })).rejects.toThrow(/already exists/);
    // Trimming happens BEFORE the conflict check, so a padded repeat collides too.
    await expect(create({ name: '  Shared  ' })).rejects.toThrow(/already exists/);
  });

  it('allows the same name on a different widget type, and for a different user', async () => {
    await create({ name: 'Shared' });
    await expect(
      create({ name: 'Shared', type: 'MEMORY_STATS', config: {} }),
    ).resolves.toMatchObject({ type: 'MEMORY_STATS' });
    await expect(create({ name: 'Shared' }, () => ctx(other.id))).resolves.toMatchObject({
      name: 'Shared',
    });
  });

  it('lets the unique index settle a concurrent save of the same name', async () => {
    // A check-then-create would let both pass the check; the index is the real
    // arbiter, so exactly one wins and the loser gets the inline BAD_USER_INPUT.
    const results = await Promise.allSettled([create({ name: 'Race' }), create({ name: 'Race' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already exists/);
    expect(await db.dashboardWidgetPreset.count({ where: { name: 'Race' } })).toBe(1);
  });

  it('requires an authenticated user', async () => {
    await expect(create({}, () => ctx(undefined))).rejects.toThrow(/Authentication required/);
  });
});

describe('dashboardWidgetPresets — list', () => {
  it('is name-ordered and filtered by type', async () => {
    await create({ name: 'Zulu' });
    await create({ name: 'Alpha' });
    await create({ name: 'Mike', type: 'MEMORY_STATS', config: {} });

    const all = await Q.dashboardWidgetPresets(null, {}, ctx(user.id));
    expect(all.map((p: { name: string }) => p.name)).toEqual(['Alpha', 'Mike', 'Zulu']);

    const usage = await Q.dashboardWidgetPresets(null, { type: 'USAGE_ACTIVITY' }, ctx(user.id));
    expect(usage.map((p: { name: string }) => p.name)).toEqual(['Alpha', 'Zulu']);
  });

  it("never returns another user's presets, and is empty for a non-user caller", async () => {
    await create({ name: 'Mine' });
    expect(await Q.dashboardWidgetPresets(null, {}, ctx(other.id))).toEqual([]);
    expect(await Q.dashboardWidgetPresets(null, {}, ctx(undefined))).toEqual([]);
  });
});

describe('updateDashboardWidgetPreset', () => {
  it('renames and replaces the config independently', async () => {
    const saved = await create({ name: 'Before', config: { windowDays: 7 } });

    const renamed = await M.updateDashboardWidgetPreset(
      null,
      { presetRef: saved.id, name: 'After' },
      ctx(user.id),
    );
    expect(renamed).toMatchObject({ id: saved.id, name: 'After', config: { windowDays: 7 } });

    const reconfigured = await M.updateDashboardWidgetPreset(
      null,
      { presetRef: saved.id, config: { windowDays: 90, memoryRefs: ['m1'] } },
      ctx(user.id),
    );
    expect(reconfigured).toMatchObject({
      name: 'After',
      config: { windowDays: 90, memoryRefs: ['m1'] },
    });
  });

  it('leaves the row untouched when neither field is supplied', async () => {
    const saved = await create();
    const same = await M.updateDashboardWidgetPreset(null, { presetRef: saved.id }, ctx(user.id));
    expect(same).toMatchObject({ id: saved.id, name: saved.name, config: saved.config });
  });

  it('applies the same name and config guards as create', async () => {
    const saved = await create();
    await expect(
      M.updateDashboardWidgetPreset(null, { presetRef: saved.id, name: '  ' }, ctx(user.id)),
    ).rejects.toThrow(/name is required/);
    await expect(
      M.updateDashboardWidgetPreset(
        null,
        { presetRef: saved.id, config: 'not-an-object' },
        ctx(user.id),
      ),
    ).rejects.toThrow(/config must be a JSON object/);
  });

  it('rejects a rename onto an existing name for the same type', async () => {
    await create({ name: 'Taken' });
    const saved = await create({ name: 'Free' });
    await expect(
      M.updateDashboardWidgetPreset(null, { presetRef: saved.id, name: 'Taken' }, ctx(user.id)),
    ).rejects.toThrow(/already exists/);
    // Renaming a preset to its OWN current name is a no-op, not a conflict.
    await expect(
      M.updateDashboardWidgetPreset(null, { presetRef: saved.id, name: 'Free' }, ctx(user.id)),
    ).resolves.toMatchObject({ name: 'Free' });
  });
});

describe('deleteDashboardWidgetPreset', () => {
  it('deletes the caller own preset', async () => {
    const saved = await create();
    expect(await M.deleteDashboardWidgetPreset(null, { presetRef: saved.id }, ctx(user.id))).toBe(
      true,
    );
    expect(await Q.dashboardWidgetPresets(null, {}, ctx(user.id))).toEqual([]);
  });

  it('leaves a placement seeded from it alone — apply COPIES, there is no live link', async () => {
    const saved = await create({ config: { windowDays: 30 } });
    const [placement] = await M.setDashboardWidgets(
      null,
      { widgets: [{ type: 'USAGE_ACTIVITY', span: 4, rowSpan: 1, config: saved.config }] },
      ctx(user.id),
    );

    await M.deleteDashboardWidgetPreset(null, { presetRef: saved.id }, ctx(user.id));

    const widgets = await Q.dashboardWidgets(null, {}, ctx(user.id));
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toMatchObject({ id: placement.id, config: { windowDays: 30 } });
  });
});

describe('ownership gating', () => {
  it("another user's presetRef is indistinguishable from a missing one", async () => {
    const theirs = await create({ name: 'Theirs' }, () => ctx(other.id));
    const ghost = generateId();

    for (const presetRef of [theirs.id, ghost]) {
      await expect(
        M.updateDashboardWidgetPreset(null, { presetRef, name: 'Hijacked' }, ctx(user.id)),
      ).rejects.toThrow(/not found/i);
      await expect(
        M.deleteDashboardWidgetPreset(null, { presetRef }, ctx(user.id)),
      ).rejects.toThrow(/not found/i);
    }
    // Untouched.
    expect(await db.dashboardWidgetPreset.findUnique({ where: { id: theirs.id } })).toMatchObject({
      userId: other.id,
      name: 'Theirs',
    });
  });

  it('a non-user (App-key) caller cannot write presets', async () => {
    const saved = await create();
    await expect(
      M.updateDashboardWidgetPreset(null, { presetRef: saved.id, name: 'x' }, ctx(undefined)),
    ).rejects.toThrow(/Authentication required/);
    await expect(
      M.deleteDashboardWidgetPreset(null, { presetRef: saved.id }, ctx(undefined)),
    ).rejects.toThrow(/Authentication required/);
  });

  it('cascades on user deletion', async () => {
    await create();
    await db.user.delete({ where: { id: user.id } });
    expect(await db.dashboardWidgetPreset.count({ where: { userId: user.id } })).toBe(0);
  });
});
