/**
 * #772 / #788 — per-user dashboard widgets.
 *
 * Pins: setDashboardWidgets replaces the whole selection (position = array
 * order, span/rowSpan clamped, config round-tripped); placements carrying a
 * caller-owned id are updated IN PLACE so instance ids survive saves, while
 * foreign/unknown/repeated ids create instead of capturing; rows omitted from
 * the input are deleted; dashboardWidgets reads it back; the selection is
 * strictly user-scoped (a non-user caller has none, a stranger can't see it);
 * dashboardWidgetData returns one data payload per activated TYPE, with
 * memory-stats' memoryCount matching the caller's memories() total.
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

/** The full placement shape the portal always sends (span/rowSpan are non-null). */
const w = (over: Record<string, unknown> = {}) => ({
  type: 'MEMORY_STATS',
  span: 4,
  rowSpan: 1,
  ...over,
});

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: { id: generateId(), handle: `dw-user-${generateId().slice(-8)}` } });
  other = await db.user.create({ data: { id: generateId(), handle: `dw-other-${generateId().slice(-8)}` } });
});

describe('setDashboardWidgets + dashboardWidgets', () => {
  it('persists the selection with array-order positions and reads it back', async () => {
    const saved = await M.setDashboardWidgets(
      null,
      { widgets: [w({ span: 6, rowSpan: 2 })] },
      ctx(user.id),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ type: 'MEMORY_STATS', span: 6, rowSpan: 2, position: 0 });

    const read = await Q.dashboardWidgets(null, {}, ctx(user.id));
    expect(read.map((r: any) => ({ type: r.type, span: r.span, rowSpan: r.rowSpan, position: r.position }))).toEqual([
      { type: 'MEMORY_STATS', span: 6, rowSpan: 2, position: 0 },
    ]);
  });

  it('replaces the whole selection — rows omitted from the input are deleted', async () => {
    const saved = await M.setDashboardWidgets(
      null,
      { widgets: [w(), w({ type: 'AGENT_STATS' })] },
      ctx(user.id),
    );
    expect(saved).toHaveLength(2);

    // Save again keeping only the first placement → the second is gone.
    const kept = await M.setDashboardWidgets(
      null,
      { widgets: [w({ id: saved[0].id })] },
      ctx(user.id),
    );
    expect(kept.map((r: any) => r.id)).toEqual([saved[0].id]);
    expect(await db.dashboardWidget.count({ where: { userId: user.id } })).toBe(1);

    // Empty selection → nothing remains.
    expect(await M.setDashboardWidgets(null, { widgets: [] }, ctx(user.id))).toEqual([]);
    expect(await Q.dashboardWidgets(null, {}, ctx(user.id))).toEqual([]);
  });

  it('upsert-by-id preserves instance ids across saves (reorder + resize in place)', async () => {
    const saved = await M.setDashboardWidgets(
      null,
      { widgets: [w({ span: 4 }), w({ type: 'AGENT_STATS', span: 4 })] },
      ctx(user.id),
    );
    const [a, b] = saved;

    // Reorder and resize, sending the ids back → same rows, updated placement.
    const again = await M.setDashboardWidgets(
      null,
      {
        widgets: [
          w({ id: b.id, type: 'AGENT_STATS', span: 8, rowSpan: 3 }),
          w({ id: a.id, span: 6 }),
        ],
      },
      ctx(user.id),
    );
    expect(again.map((r: any) => r.id)).toEqual([b.id, a.id]);
    expect(again[0]).toMatchObject({ type: 'AGENT_STATS', span: 8, rowSpan: 3, position: 0 });
    expect(again[1]).toMatchObject({ type: 'MEMORY_STATS', span: 6, position: 1 });
  });

  it("a foreign id (another user's row) creates instead of capturing", async () => {
    const theirs = await M.setDashboardWidgets(null, { widgets: [w()] }, ctx(other.id));

    const mine = await M.setDashboardWidgets(
      null,
      { widgets: [w({ id: theirs[0].id, span: 12 })] },
      ctx(user.id),
    );
    // A fresh row was minted for the caller; the other user's row is untouched.
    expect(mine[0].id).not.toBe(theirs[0].id);
    const theirRow = await db.dashboardWidget.findUnique({ where: { id: theirs[0].id } });
    expect(theirRow).toMatchObject({ userId: other.id, span: 4 });
  });

  it('an unknown id creates a new row', async () => {
    const ghost = generateId();
    const saved = await M.setDashboardWidgets(null, { widgets: [w({ id: ghost })] }, ctx(user.id));
    expect(saved).toHaveLength(1);
    expect(saved[0].id).not.toBe(ghost);
  });

  it('a repeated id in one payload updates once and creates the repeat', async () => {
    const [row] = await M.setDashboardWidgets(null, { widgets: [w()] }, ctx(user.id));
    const saved = await M.setDashboardWidgets(
      null,
      { widgets: [w({ id: row.id, span: 6 }), w({ id: row.id, span: 9 })] },
      ctx(user.id),
    );
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ id: row.id, span: 6, position: 0 });
    expect(saved[1].id).not.toBe(row.id);
    expect(saved[1]).toMatchObject({ span: 9, position: 1 });
  });

  it('serializes concurrent replace-all writes for the same user (no duplicate union)', async () => {
    // Both start from an empty layout — the exact race the per-user advisory
    // lock closes (each deleteMany hits zero rows, so without the lock both
    // sets of creates would commit → a union with duplicate positions).
    await Promise.all([
      M.setDashboardWidgets(null, { widgets: [w({ span: 3 })] }, ctx(user.id)),
      M.setDashboardWidgets(null, { widgets: [w({ span: 9 })] }, ctx(user.id)),
    ]);
    const rows = await Q.dashboardWidgets(null, {}, ctx(user.id));
    // Last-writer-wins: exactly one widget survives, never a union of both.
    expect(rows).toHaveLength(1);
    expect([3, 9]).toContain(rows[0].span);
  });

  it('clamps out-of-range span to 1-12 and rowSpan to 1-4', async () => {
    const saved = await M.setDashboardWidgets(
      null,
      {
        widgets: [
          w({ span: 99, rowSpan: 99 }),
          w({ span: 0, rowSpan: 0 }),
          w({ span: 7.9, rowSpan: 2.9 }),
        ],
      },
      ctx(user.id),
    );
    expect(saved.map((r: any) => [r.span, r.rowSpan])).toEqual([
      [12, 4],
      [1, 1],
      [7, 2],
    ]);
    expect(saved.map((r: any) => r.position)).toEqual([0, 1, 2]);
  });

  it('rejects an unknown widget type', async () => {
    await expect(
      M.setDashboardWidgets(null, { widgets: [w({ type: 'BOGUS' })] }, ctx(user.id)),
    ).rejects.toThrow(/Unknown widget type/);
  });
});

describe('per-instance config', () => {
  it('round-trips config, and clearing it persists (the input is the full state)', async () => {
    const config = { orgId: 'org-1', items: 5 };
    const [row] = await M.setDashboardWidgets(null, { widgets: [w({ config })] }, ctx(user.id));
    expect(row.config).toEqual(config);

    const read = await Q.dashboardWidgets(null, {}, ctx(user.id));
    expect(read[0].config).toEqual(config);

    // Saving the same placement without config clears it.
    const cleared = await M.setDashboardWidgets(
      null,
      { widgets: [w({ id: row.id })] },
      ctx(user.id),
    );
    expect(cleared[0].id).toBe(row.id);
    expect(cleared[0].config).toBeNull();
  });

  it('rejects an oversized config', async () => {
    const big = { blob: 'x'.repeat(5000) };
    await expect(
      M.setDashboardWidgets(null, { widgets: [w({ config: big })] }, ctx(user.id)),
    ).rejects.toThrow(/config is too large/);
  });
});

describe('user scoping', () => {
  it("a non-user (App-key) caller has no widgets and cannot set them", async () => {
    expect(await Q.dashboardWidgets(null, {}, ctx(undefined))).toEqual([]);
    expect(await Q.dashboardWidgetData(null, {}, ctx(undefined))).toEqual([]);
    await expect(
      M.setDashboardWidgets(null, { widgets: [w()] }, ctx(undefined)),
    ).rejects.toThrow(/Authentication required/);
  });

  it("one user's selection is invisible to another", async () => {
    await M.setDashboardWidgets(null, { widgets: [w()] }, ctx(user.id));
    expect(await Q.dashboardWidgets(null, {}, ctx(other.id))).toEqual([]);
  });
});

describe('dashboardWidgetData — combined data', () => {
  it('returns memory-stats data whose memoryCount matches the caller memories() total', async () => {
    // Two non-system memories the user can access (org member + org-owned).
    const org = await db.organization.create({
      data: { id: generateId(), name: 'dw-org', urn: `dw-org-${generateId().slice(-8)}` },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: user.id, role: 'READER' },
    });
    for (const n of ['dw-mem-a', 'dw-mem-b']) {
      await db.memory.create({
        data: {
          id: generateId(),
          organizationId: org.id,
          urn: `${org.urn}:${n}`,
          name: n,
          class: 'knowledge',
          visibility: 'ORGANIZATION',
        },
      });
    }
    await M.setDashboardWidgets(null, { widgets: [w()] }, ctx(user.id));

    const data = await Q.dashboardWidgetData(null, {}, ctx(user.id));
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ type: 'MEMORY_STATS', data: { memoryCount: 2 } });
  });

  it('returns agent-stats data whose agentCount matches the caller agents() total', async () => {
    // Two user-owned (org-less) agents the caller has.
    for (const n of ['dw-agent-a', 'dw-agent-b']) {
      await db.agent.create({
        data: {
          id: generateId(),
          ownerUserId: user.id,
          urn: `dw-agent-${generateId().slice(-8)}`,
          name: n,
        },
      });
    }
    await M.setDashboardWidgets(null, { widgets: [w({ type: 'AGENT_STATS' })] }, ctx(user.id));

    const data = await Q.dashboardWidgetData(null, {}, ctx(user.id));
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ type: 'AGENT_STATS', data: { agentCount: 2 } });
  });

  it('emits one entry per activated TYPE even if placed more than once', async () => {
    await M.setDashboardWidgets(null, { widgets: [w(), w()] }, ctx(user.id));
    const data = await Q.dashboardWidgetData(null, {}, ctx(user.id));
    expect(data).toHaveLength(1);
    expect(data[0].type).toBe('MEMORY_STATS');
  });

  it('is empty when the user has no widgets', async () => {
    expect(await Q.dashboardWidgetData(null, {}, ctx(user.id))).toEqual([]);
  });
});
