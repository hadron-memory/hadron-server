/**
 * #772 — per-user dashboard widgets.
 *
 * Pins: setDashboardWidgets replaces the whole selection (position = array
 * order, span clamped); dashboardWidgets reads it back; the selection is
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

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: { id: generateId(), handle: `dw-user-${generateId().slice(-8)}` } });
  other = await db.user.create({ data: { id: generateId(), handle: `dw-other-${generateId().slice(-8)}` } });
});

describe('setDashboardWidgets + dashboardWidgets', () => {
  it('persists the selection with array-order positions and reads it back', async () => {
    const saved = await M.setDashboardWidgets(
      null,
      { widgets: [{ type: 'MEMORY_STATS', span: 6 }] },
      ctx(user.id),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ type: 'MEMORY_STATS', span: 6, position: 0 });

    const read = await Q.dashboardWidgets(null, {}, ctx(user.id));
    expect(read.map((w: any) => ({ type: w.type, span: w.span, position: w.position }))).toEqual([
      { type: 'MEMORY_STATS', span: 6, position: 0 },
    ]);
  });

  it('replaces the whole selection (delete-all + recreate)', async () => {
    await M.setDashboardWidgets(null, { widgets: [{ type: 'MEMORY_STATS', span: 4 }] }, ctx(user.id));
    const firstIds = (await Q.dashboardWidgets(null, {}, ctx(user.id))).map((w: any) => w.id);

    // Replace with an empty selection → nothing remains.
    const empty = await M.setDashboardWidgets(null, { widgets: [] }, ctx(user.id));
    expect(empty).toEqual([]);
    expect(await Q.dashboardWidgets(null, {}, ctx(user.id))).toEqual([]);

    // Re-adding mints fresh rows (not the old ids).
    const again = await M.setDashboardWidgets(null, { widgets: [{ type: 'MEMORY_STATS' }] }, ctx(user.id));
    expect(firstIds).not.toContain(again[0].id);
  });

  it('serializes concurrent replace-all writes for the same user (no duplicate union)', async () => {
    // Both start from an empty layout — the exact race the per-user advisory
    // lock closes (each deleteMany hits zero rows, so without the lock both
    // createMany would commit → a union with duplicate positions).
    await Promise.all([
      M.setDashboardWidgets(null, { widgets: [{ type: 'MEMORY_STATS', span: 3 }] }, ctx(user.id)),
      M.setDashboardWidgets(null, { widgets: [{ type: 'MEMORY_STATS', span: 9 }] }, ctx(user.id)),
    ]);
    const rows = await Q.dashboardWidgets(null, {}, ctx(user.id));
    // Last-writer-wins: exactly one widget survives, never a union of both.
    expect(rows).toHaveLength(1);
    expect([3, 9]).toContain(rows[0].span);
  });

  it('defaults span to 4 and clamps out-of-range spans to 1-12', async () => {
    const saved = await M.setDashboardWidgets(
      null,
      { widgets: [{ type: 'MEMORY_STATS' }, { type: 'MEMORY_STATS', span: 99 }, { type: 'MEMORY_STATS', span: 0 }] },
      ctx(user.id),
    );
    expect(saved.map((w: any) => w.span)).toEqual([4, 12, 1]);
    expect(saved.map((w: any) => w.position)).toEqual([0, 1, 2]);
  });

  it('rejects an unknown widget type', async () => {
    await expect(
      M.setDashboardWidgets(null, { widgets: [{ type: 'BOGUS' }] }, ctx(user.id)),
    ).rejects.toThrow(/Unknown widget type/);
  });
});

describe('user scoping', () => {
  it("a non-user (App-key) caller has no widgets and cannot set them", async () => {
    expect(await Q.dashboardWidgets(null, {}, ctx(undefined))).toEqual([]);
    expect(await Q.dashboardWidgetData(null, {}, ctx(undefined))).toEqual([]);
    await expect(
      M.setDashboardWidgets(null, { widgets: [{ type: 'MEMORY_STATS' }] }, ctx(undefined)),
    ).rejects.toThrow(/Authentication required/);
  });

  it("one user's selection is invisible to another", async () => {
    await M.setDashboardWidgets(null, { widgets: [{ type: 'MEMORY_STATS' }] }, ctx(user.id));
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
    await M.setDashboardWidgets(null, { widgets: [{ type: 'MEMORY_STATS', span: 4 }] }, ctx(user.id));

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
    await M.setDashboardWidgets(null, { widgets: [{ type: 'AGENT_STATS', span: 4 }] }, ctx(user.id));

    const data = await Q.dashboardWidgetData(null, {}, ctx(user.id));
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ type: 'AGENT_STATS', data: { agentCount: 2 } });
  });

  it('emits one entry per activated TYPE even if placed more than once', async () => {
    await M.setDashboardWidgets(
      null,
      { widgets: [{ type: 'MEMORY_STATS' }, { type: 'MEMORY_STATS' }] },
      ctx(user.id),
    );
    const data = await Q.dashboardWidgetData(null, {}, ctx(user.id));
    expect(data).toHaveLength(1);
    expect(data[0].type).toBe('MEMORY_STATS');
  });

  it('is empty when the user has no widgets', async () => {
    expect(await Q.dashboardWidgetData(null, {}, ctx(user.id))).toEqual([]);
  });
});
