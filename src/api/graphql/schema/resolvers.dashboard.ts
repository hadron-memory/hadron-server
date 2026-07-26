/**
 * #772 — per-user dashboard widgets. Two concerns:
 *
 *  1. **Selection** — which widgets the caller has placed on their
 *     /app/dashboard grid and in what order/span/rowSpan (+ per-instance
 *     `config`, #788). Persisted one row per placed widget (`DashboardWidget`),
 *     read via `dashboardWidgets`, replaced atomically via `setDashboardWidgets`
 *     (upsert-by-id, so instance ids survive saves). User-scoped config:
 *     owner-only, no org, no sharing; a non-user (App-key) caller has none.
 *
 *  2. **Combined data** — `dashboardWidgetData` returns, in ONE request, the
 *     data payload for each of the caller's activated widget TYPES. Each type's
 *     payload comes from its entry in {@link WIDGET_DATA_PROVIDERS}; the portal
 *     calls this once and fans the result out by type. Generic (`{type, data}`)
 *     so a new widget adds a provider here with no query-shape change.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import { generateId } from '../../../lib/id.js';
import { memoryQueries } from './resolvers.query.memory.js';
import { agentQueries } from './resolvers.query.agent.js';

const SPAN_MIN = 1;
const SPAN_MAX = 12;
const SPAN_DEFAULT = 4;
const ROW_SPAN_MIN = 1;
const ROW_SPAN_MAX = 4;
const ROW_SPAN_DEFAULT = 1;
/** Per-instance `config` cap — matches the secrets metadata cap (modest, layout-config-sized). */
const MAX_CONFIG_JSON_LENGTH = 4 * 1024;

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
  [
    'AGENT_STATS',
    async (ctx) => {
      // Same shape as MEMORY_STATS: the uniform `agents()` resolver's default
      // (no orgId) view counts the caller's member-org agents PLUS their own
      // user-owned agents, so `agentCount` matches the portal's agent list.
      const { total } = await agentQueries.agents(null, { limit: 0 }, ctx);
      return { agentCount: total };
    },
  ],
]);

/** Clamp a client-supplied span into the grid's 1-12 range; default when unset. */
function clampSpan(span?: number | null): number {
  if (span == null || !Number.isFinite(span)) return SPAN_DEFAULT;
  return Math.min(SPAN_MAX, Math.max(SPAN_MIN, Math.trunc(span)));
}

/** Clamp a client-supplied rowSpan into the 1-4 range; default when unset. */
function clampRowSpan(rowSpan?: number | null): number {
  if (rowSpan == null || !Number.isFinite(rowSpan)) return ROW_SPAN_DEFAULT;
  return Math.min(ROW_SPAN_MAX, Math.max(ROW_SPAN_MIN, Math.trunc(rowSpan)));
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
   * Replace the caller's entire widget selection — the input IS the layout
   * (position = array order), so rows omitted from it are deleted. Placements
   * carrying an `id` the caller owns are updated IN PLACE (#788), so instance
   * ids survive saves — the portal's drag/FLIP keys and per-instance `config`
   * stay attached to the same row. Any other id (absent, unknown, another
   * user's, or a repeat within the payload) creates a fresh row instead of
   * capturing.
   */
  setDashboardWidgets: async (
    _: unknown,
    {
      widgets,
    }: {
      widgets: Array<{
        id?: string | null;
        type: string;
        span: number;
        rowSpan: number;
        config?: unknown;
      }>;
    },
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
      if (w.config != null && JSON.stringify(w.config).length > MAX_CONFIG_JSON_LENGTH) {
        throw new GraphQLError(`config is too large (max ${MAX_CONFIG_JSON_LENGTH} JSON chars).`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
    }
    return ctx.db.$transaction(async (tx) => {
      // Serialize replace-all writes for THIS user. Without it, two concurrent
      // saves of a previously-empty layout each delete zero rows (no conflicting
      // row lock) and both sets of creates commit → a union with duplicate
      // positions instead of last-writer-wins (PR #773 review). The transaction-
      // scoped advisory lock makes the second save wait for the first to commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dashboard_widgets'), hashtext(${userId}))`;
      // Only the caller's own rows are match candidates — an id belonging to
      // another user is indistinguishable from unknown (no capture, no oracle).
      const existing = await tx.dashboardWidget.findMany({
        where: { userId },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((r) => r.id));
      // First occurrence of an owned id claims it; repeats fall through to create.
      const claimed = new Set<string>();
      const rows = widgets.map((w, i) => {
        const keep = w.id != null && existingIds.has(w.id) && !claimed.has(w.id);
        if (keep) claimed.add(w.id as string);
        return { id: keep ? (w.id as string) : generateId(), keep, w, position: i };
      });
      await tx.dashboardWidget.deleteMany({
        where: { userId, id: { notIn: [...claimed] } },
      });
      for (const r of rows) {
        const placement = {
          type: r.w.type as never,
          span: clampSpan(r.w.span),
          rowSpan: clampRowSpan(r.w.rowSpan),
          config: r.w.config == null ? Prisma.DbNull : (r.w.config as Prisma.InputJsonValue),
          position: r.position,
        };
        if (r.keep) {
          await tx.dashboardWidget.update({
            where: { id: r.id },
            data: { ...placement, updatedBy: userId },
          });
        } else {
          await tx.dashboardWidget.create({
            data: { id: r.id, userId, createdBy: userId, ...placement },
          });
        }
      }
      return tx.dashboardWidget.findMany({
        where: { userId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
    });
  },
};
