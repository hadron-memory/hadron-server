/**
 * #772 — per-user dashboard widgets. Two concerns:
 *
 *  1. **Selection** — which widgets the caller has placed on their
 *     /app/dashboard grid and in what order/span. Persisted one row per placed
 *     widget (`DashboardWidget`), read via `dashboardWidgets`, replaced atomically
 *     via `setDashboardWidgets`. User-scoped config: owner-only, no org, no
 *     sharing; a non-user (App-key) caller has none.
 *
 *  2. **Combined data** — `dashboardWidgetData` returns, in ONE request, the
 *     data payload for each of the caller's activated widget TYPES. Each type's
 *     payload comes from its entry in {@link WIDGET_DATA_PROVIDERS}; the portal
 *     calls this once and fans the result out by type. Generic (`{type, data}`)
 *     so a new widget adds a provider here with no query-shape change.
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { generateId } from '../../../lib/id.js';
import { memoryQueries } from './resolvers.query.memory.js';

const SPAN_MIN = 1;
const SPAN_MAX = 12;
const SPAN_DEFAULT = 4;

/**
 * Server-side data provider per widget type — the source for `dashboardWidgetData`.
 * Add an entry when a new widget ships. Each provider runs under the caller's
 * `Context`, so its data is already access-scoped. A `Map` (not a plain object)
 * so `.has()`/`.get()` can't be fooled by inherited props like `toString` /
 * `__proto__` when a caller bypasses GraphQL enum validation (PR #773 review).
 */
const WIDGET_DATA_PROVIDERS = new Map<string, (ctx: Context) => Promise<Record<string, unknown>>>([
  [
    'MEMORY_STATS',
    async (ctx) => {
      // Reuse the uniform `memories()` list resolver (limit:0 => count-only page,
      // no rows fetched) so `memoryCount` matches the portal's memory list exactly
      // — one scoping code path, no drift.
      const { total } = await memoryQueries.memories(null, { limit: 0 }, ctx);
      return { memoryCount: total };
    },
  ],
]);

/** Clamp a client-supplied span into the grid's 1-12 range; default when unset. */
function clampSpan(span?: number | null): number {
  if (span == null || !Number.isFinite(span)) return SPAN_DEFAULT;
  return Math.min(SPAN_MAX, Math.max(SPAN_MIN, Math.trunc(span)));
}

export const dashboardQueries = {
  /** The caller's placed widgets, ordered by position. Empty for a non-user caller. */
  dashboardWidgets: async (_: unknown, __: unknown, ctx: Context) => {
    if (!ctx.userId) return [];
    return ctx.db.dashboardWidget.findMany({
      where: { userId: ctx.userId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * Combined data for all of the caller's activated widget types, one entry per
   * distinct TYPE (data is per-type, not per-placement) in first-placement order.
   * A placed type with no registered provider is skipped, not an error.
   */
  dashboardWidgetData: async (_: unknown, __: unknown, ctx: Context) => {
    if (!ctx.userId) return [];
    const widgets = await ctx.db.dashboardWidget.findMany({
      where: { userId: ctx.userId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { type: true },
    });
    const out: Array<{ type: string; data: Record<string, unknown> }> = [];
    const seen = new Set<string>();
    for (const w of widgets) {
      if (seen.has(w.type)) continue;
      seen.add(w.type);
      const provider = WIDGET_DATA_PROVIDERS.get(w.type);
      if (!provider) continue;
      out.push({ type: w.type, data: await provider(ctx) });
    }
    return out;
  },
};

export const dashboardMutations = {
  /**
   * Replace the caller's entire widget selection. The layout is user-owned and
   * always saved as a whole, so delete-all + recreate in one transaction is the
   * simplest race-free write (position = array order). Covers create AND update.
   */
  setDashboardWidgets: async (
    _: unknown,
    { widgets }: { widgets: Array<{ type: string; span?: number | null }> },
    ctx: Context,
  ) => {
    const userId = ctx.userId;
    if (!userId) {
      throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
    }
    // The enum arg is validated by GraphQL, but guard defensively for callers
    // that bypass schema validation (createTestableMcpServer parity, #312).
    for (const w of widgets) {
      if (!WIDGET_DATA_PROVIDERS.has(w.type)) {
        throw new GraphQLError(`Unknown widget type: ${w.type}`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
    }
    return ctx.db.$transaction(async (tx) => {
      // Serialize replace-all writes for THIS user. Without it, two concurrent
      // saves of a previously-empty layout each delete zero rows (no conflicting
      // row lock) and both createMany commit → a union with duplicate positions
      // instead of last-writer-wins (PR #773 review). The transaction-scoped
      // advisory lock makes the second save wait for the first to commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dashboard_widgets'), hashtext(${userId}))`;
      await tx.dashboardWidget.deleteMany({ where: { userId } });
      if (widgets.length > 0) {
        await tx.dashboardWidget.createMany({
          data: widgets.map((w, i) => ({
            id: generateId(),
            userId,
            type: w.type as never,
            span: clampSpan(w.span),
            position: i,
            createdBy: userId,
          })),
        });
      }
      return tx.dashboardWidget.findMany({
        where: { userId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
    });
  },
};
