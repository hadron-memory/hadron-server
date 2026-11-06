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
 *     data payload for each of the caller's PLACED widgets. Each payload comes
 *     from the type's entry in {@link WIDGET_DATA_PROVIDERS}, called with that
 *     placement's `config`; the portal calls this once and fans the result out
 *     by `widgetId`. Generic (`{widgetId, type, data}`) so a new widget adds a
 *     provider here with no query-shape change.
 *
 *     #797 made this per-PLACEMENT (it was per distinct type). Two placements
 *     of one type with different configs must receive different data, which the
 *     per-type contract could not express — and it is what makes a duplicate
 *     placement of a type genuinely useful.
 *
 *  3. **Presets** (#806) — named, saved widget configurations
 *     (`DashboardWidgetPreset`), a palette the portal COPIES from when seeding
 *     a placement's `config`. Same owner-only posture as the placements, plain
 *     `create/update/delete` CRUD per conventions:crud-mutation-naming.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { type Context, pageArgs, pageEnvelope } from './resolvers.helpers.js';
import { generateId } from '../../../lib/id.js';
import { isPlainObject } from '../../../lib/objectStore.js';
import {
  isUsageActivityBucketSize,
  MAX_MEMORY_SCOPE_REFS,
  type UsageActivityBucketSize,
} from '../../../lib/usageActivity.js';
import { memoryQueries } from './resolvers.query.memory.js';
import { agentQueries } from './resolvers.query.agent.js';

const SPAN_MIN = 1;
const SPAN_MAX = 12;
const SPAN_DEFAULT = 4;
const ROW_SPAN_MIN = 1;
const ROW_SPAN_MAX = 4;
const ROW_SPAN_DEFAULT = 1;
/**
 * `config` cap — matches the secrets metadata cap (modest, layout-config-sized).
 * Shared by a placement's config and a preset's (#806), since a preset becomes
 * a placement's config verbatim; one budget, no way to smuggle a bigger blob in
 * through the preset door.
 */
const MAX_CONFIG_JSON_LENGTH = 4 * 1024;

/** Usage-activity widget window bounds (#796/#797), in days. */
const WINDOW_DAYS_MIN = 1;
const WINDOW_DAYS_MAX = 90;
const WINDOW_DAYS_DEFAULT = 7;

/**
 * Normalize the widget config's memory scope (#805). Returns `undefined` when
 * the config names no memory scope at all (⇒ the caller's own activity), and
 * an array — possibly empty — when it does, since the query treats a present
 * list as "memory scope" and an absent one as "own activity".
 *
 * A pre-#805 placement stored `memoryRef: "<one ref>"`; reading it as a
 * one-element list is what lets those rows keep working with no data migration.
 * `memoryRefs` wins when both are present.
 */
function readMemoryRefs(c: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(c.memoryRefs)) {
    // Non-strings/empties are dropped rather than passed to the resolver, where
    // a non-string would blow up ref parsing. An array that survives as empty
    // stays an EMPTY memory scope, not a fallback to own activity — a garbage
    // list must not silently relabel one user's data as the memories'.
    const refs = c.memoryRefs.filter((r): r is string => typeof r === 'string' && r.length > 0);
    return [...new Set(refs)].slice(0, MAX_MEMORY_SCOPE_REFS);
  }
  const single = c.memoryRef;
  return typeof single === 'string' && single ? [single] : undefined;
}

/**
 * Read the usage-activity widget's `config`, treating every field as untrusted
 * (it round-trips through a JSON column the client fully controls). Anything
 * unrecognized is ignored and anything out of range is clamped rather than
 * rejected — a bad value must degrade this ONE widget, never fail the whole
 * `dashboardWidgetData` payload. Follows the `clampSpan` / `readAssetsOverrides`
 * convention rather than a schema validator (this repo hand-rolls JSON guards).
 */
function readUsageActivityConfig(config: unknown): {
  windowDays: number;
  memoryRefs?: string[];
  bucket?: UsageActivityBucketSize;
  timeZone?: string;
} {
  const c = isPlainObject(config) ? config : {};
  const rawDays = c.windowDays;
  const windowDays =
    typeof rawDays === 'number' && Number.isFinite(rawDays)
      ? Math.min(WINDOW_DAYS_MAX, Math.max(WINDOW_DAYS_MIN, Math.trunc(rawDays)))
      : WINDOW_DAYS_DEFAULT;
  return {
    windowDays,
    memoryRefs: readMemoryRefs(c),
    // Whitelisted, NOT passed through: nothing validates this string on the way
    // in (it is raw config JSON, never a GraphQL enum), so an unknown value
    // would otherwise reach the aggregation. Falls back to the query default.
    bucket: isUsageActivityBucketSize(c.bucket) ? c.bucket : undefined,
    timeZone: typeof c.timeZone === 'string' ? c.timeZone : undefined,
  };
}

/**
 * Server-side data provider per widget type — the source for `dashboardWidgetData`.
 * Add an entry when a new widget ships. Each provider runs under the caller's
 * `Context`, so its data is already access-scoped, and receives the PLACEMENT's
 * `config` (#797) — untrusted client JSON, so validate/clamp it. A `Map` (not a
 * plain object) so `.has()`/`.get()` can't be fooled by inherited props like
 * `toString` / `__proto__` when a caller bypasses GraphQL enum validation
 * (PR #773 review).
 *
 * NOTE this map doubles as the settable-type allowlist for `setDashboardWidgets`
 * AND for presets (#806) — registering a provider is what makes a type placeable
 * and preset-able, so neither surface can name a widget that cannot be rendered.
 */
const WIDGET_DATA_PROVIDERS = new Map<
  string,
  (ctx: Context, config: unknown) => Promise<Record<string, unknown>>
>([
  [
    'MEMORY_STATS',
    async (ctx) => {
      // The caller's OWN memories — `filter.ownedByMe` (#1179), the same slice
      // the portal's "My memories" list asks for, which is what this tile's
      // "Create new" action adds to (/app/memories/new creates an org-less,
      // user-owned memory). Reuses the uniform `memories()` list resolver
      // (limit:0 => count-only page, no rows fetched), so the scoping lives in
      // ONE place. Config-independent (a stat tile).
      //
      // #1231: the filter is the whole point, and it was missing. An unfiltered
      // `memories()` counts every memory the caller can READ — their member
      // orgs' collections included — so the tile read 87 above a list of 4.
      // The comment here used to assert the match while the argument list
      // decided otherwise, which is what kept it invisible: a reader checking
      // the scope met a sentence claiming the property instead of the call that
      // sets it. Reusing a resolver only shares the scoping it is ASKED for.
      const { total } = await memoryQueries.memories(
        null,
        { filter: { ownedByMe: true }, limit: 0 },
        ctx,
      );
      return { memoryCount: total };
    },
  ],
  [
    'AGENT_STATS',
    async (ctx) => {
      // Same slice, same reason (#1231): `agents(filter.ownedByMe)` (#782) is
      // the caller's own user-owned agents — what /app/agents lists and what
      // this tile's "Create new" action adds to.
      //
      // The unfiltered call this replaced was wrong in two steps rather than
      // one. Its default view folds in every member org's agents, so the tile
      // over-counted for any org member; and `agents()` gives a platform
      // ADMIN/OWNER an unscoped view of every live org-owned agent, so for an
      // admin the number was PLATFORM-WIDE — a count of other tenants' agents,
      // rendered under a personal "N agents" heading. `ownedByMe` is never an
      // admin-bypass surface (#782), so the tile now reads the same way for
      // every caller.
      const { total } = await agentQueries.agents(
        null,
        { filter: { ownedByMe: true }, limit: 0 },
        ctx,
      );
      return { agentCount: total };
    },
  ],
  [
    'USAGE_ACTIVITY',
    async (ctx, config) => {
      // Delegate to the `usageActivity` resolver rather than the service beneath
      // it (the MEMORY_STATS idiom) so the widget inherits the query's window
      // defaults AND its memory read gate — a config naming a memory the caller
      // can't read yields empty buckets, exactly as the query would.
      const { windowDays, memoryRefs, bucket, timeZone } = readUsageActivityConfig(config);
      const to = new Date();
      const from = new Date(to.getTime() - windowDays * 86_400_000);
      try {
        const buckets = await memoryQueries.usageActivity(
          null,
          {
            from: from.toISOString(),
            to: to.toISOString(),
            bucket,
            memoryRefs,
            timeZone,
          },
          ctx,
        );
        return { windowDays, buckets };
      } catch {
        // A malformed memoryRef URN or an unknown time zone throws. Surface it
        // as this widget's own problem — one misconfigured placement must not
        // take down every other widget's data in the shared payload.
        return { windowDays, buckets: [], invalidConfig: true };
      }
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

/** Preset name bounds (#806) — measured AFTER trimming. */
const PRESET_NAME_MAX_LENGTH = 60;

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * The caller's user id, or UNAUTHENTICATED. Presets are strictly user-scoped,
 * so an App-key caller has nothing to write — the same posture as
 * `setDashboardWidgets` (the READ side answers empty instead, per
 * `dashboardWidgets`).
 */
function requireUserId(ctx: Context): string {
  if (!ctx.userId) {
    throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return ctx.userId;
}

/** Reject a type with no registered provider — the same allowlist that decides
 *  what `setDashboardWidgets` may place, so a preset can never name a widget
 *  that cannot be rendered. Guards callers that bypass GraphQL enum validation. */
function requirePresetType(type: string): void {
  if (!WIDGET_DATA_PROVIDERS.has(type)) {
    throw badInput(`Unknown widget type: ${type}`);
  }
}

/** Trim + bound a preset name. */
function normalizePresetName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw badInput('name is required.');
  if (trimmed.length > PRESET_NAME_MAX_LENGTH) {
    throw badInput(`name is too long (max ${PRESET_NAME_MAX_LENGTH} characters).`);
  }
  return trimmed;
}

/**
 * Validate a preset's `config`. Stricter than a placement's: a preset exists to
 * BE a config, so a scalar or array is a client bug rather than something to
 * round-trip. Same 4KB budget.
 */
function validatePresetConfig(config: unknown): Prisma.InputJsonValue {
  // isPlainObject already rejects arrays as well as scalars/null.
  if (!isPlainObject(config)) {
    throw badInput('config must be a JSON object.');
  }
  if (JSON.stringify(config).length > MAX_CONFIG_JSON_LENGTH) {
    throw badInput(`config is too large (max ${MAX_CONFIG_JSON_LENGTH} JSON chars).`);
  }
  return config as Prisma.InputJsonValue;
}

/** True for the unique-violation Prisma raises on (user_id, type, name). */
function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string })?.code === 'P2002';
}

const presetNameConflict = (name: string) =>
  badInput(`A preset named "${name}" already exists for this widget type.`);

/**
 * Load the caller's OWN preset by PK, or throw NOT_FOUND. Another user's id and
 * an id that never existed answer identically — a preset is owner-only, so the
 * mutations must not become a probe for other users' rows.
 */
async function requireOwnPreset(ctx: Context, userId: string, presetRef: string) {
  const preset = await ctx.db.dashboardWidgetPreset.findFirst({
    where: { id: presetRef, userId },
  });
  if (!preset) {
    throw new GraphQLError('Dashboard widget preset not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }
  return preset;
}

export const dashboardQueries = {
  /** The caller's placed widgets, ordered by position. Empty for a non-user caller. */
  dashboardWidgets: async (_: unknown, __: unknown, ctx: Context) => {
    // #876 class sweep: the target's own dashboard layout is identity-scoped.
    if (!ctx.userId || ctx.impersonation) return [];
    return ctx.db.dashboardWidget.findMany({
      where: { userId: ctx.userId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * Combined data for the caller's PLACED widgets — one entry per placement
   * (#797), in position order, each built from that placement's own `config`.
   * A placement whose type has no registered provider is skipped, not an error.
   */
  dashboardWidgetData: async (_: unknown, __: unknown, ctx: Context) => {
    // #876 class sweep: keyed off the caller's own placements (see above).
    if (!ctx.userId || ctx.impersonation) return [];
    const widgets = await ctx.db.dashboardWidget.findMany({
      where: { userId: ctx.userId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, type: true, config: true },
    });

    // Run at most once per DISTINCT (type, config): duplicate placements of the
    // same configured widget are common (and now genuinely useful), and a
    // provider can be expensive — USAGE_ACTIVITY runs an aggregation query.
    // Keyed on the serialized config, so a key-order difference just misses the
    // dedupe rather than conflating two configs.
    const inFlight = new Map<string, Promise<Record<string, unknown>>>();
    const runnable = widgets.filter((w) => WIDGET_DATA_PROVIDERS.has(w.type));

    // Promise.all preserves array order, so the result stays in position order.
    return Promise.all(
      runnable.map(async (w) => {
        const key = `${w.type}\0${JSON.stringify(w.config ?? null)}`;
        let pending = inFlight.get(key);
        if (!pending) {
          // Non-null: `runnable` is filtered on `.has()`.
          pending = WIDGET_DATA_PROVIDERS.get(w.type)!(ctx, w.config ?? null);
          inFlight.set(key, pending);
        }
        return { widgetId: w.id, type: w.type, data: await pending };
      }),
    );
  },

  /**
   * #806 — the caller's saved widget configurations, name-ordered, optionally
   * narrowed to one widget type. Owner-only: empty for a non-user caller, and
   * never another user's rows.
   */
  dashboardWidgetPresets: async (
    _: unknown,
    { type }: { type?: string | null },
    ctx: Context,
  ) => {
    // #876 class sweep: the target's saved presets are identity-scoped.
    if (!ctx.userId || ctx.impersonation) return [];
    return ctx.db.dashboardWidgetPreset.findMany({
      where: { userId: ctx.userId, ...(type ? { type: type as never } : {}) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },

  /** #2213 — `dashboardWidgetPresets` as a page: the same identity scope and order, counted and read in one snapshot. */
  dashboardWidgetPresetsPage: async (
    _: unknown,
    args: { type?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    if (!ctx.userId || ctx.impersonation) return { items: [], total: 0, hasMore: false };
    const where = { userId: ctx.userId, ...(args.type ? { type: args.type as never } : {}) };
    const { take, skip } = pageArgs(args);
    const [total, items] = await ctx.db.$transaction([
      ctx.db.dashboardWidgetPreset.count({ where }),
      ctx.db.dashboardWidgetPreset.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take, skip }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return pageEnvelope(items, total, skip);
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

  /**
   * #806 — save a named widget configuration. The name is unique per
   * (caller, widget type); a collision is BAD_USER_INPUT so the portal can
   * surface it inline next to the name field.
   */
  createDashboardWidgetPreset: async (
    _: unknown,
    { type, name, config }: { type: string; name: string; config: unknown },
    ctx: Context,
  ) => {
    const userId = requireUserId(ctx);
    requirePresetType(type);
    const trimmed = normalizePresetName(name);
    const validated = validatePresetConfig(config);
    try {
      return await ctx.db.dashboardWidgetPreset.create({
        data: { id: generateId(), userId, type: type as never, name: trimmed, config: validated },
      });
    } catch (e) {
      // The unique index is the real arbiter — a check-then-create would let two
      // concurrent saves of the same name both pass the check.
      if (isUniqueViolation(e)) throw presetNameConflict(trimmed);
      throw e;
    }
  },

  /**
   * #806 — rename a preset and/or replace its settings. Partial: an omitted
   * field is left alone. `type` is immutable — a preset's config is only
   * meaningful for the widget it was saved from, so retyping would carry
   * nonsense settings across; delete and re-create instead.
   */
  updateDashboardWidgetPreset: async (
    _: unknown,
    { presetRef, name, config }: { presetRef: string; name?: string | null; config?: unknown },
    ctx: Context,
  ) => {
    const userId = requireUserId(ctx);
    const existing = await requireOwnPreset(ctx, userId, presetRef);
    const trimmed = name != null ? normalizePresetName(name) : undefined;
    // `config: null` is "leave it alone", not "clear it" — the column is
    // non-null, and a preset with no settings has nothing to apply.
    const validated = config != null ? validatePresetConfig(config) : undefined;
    if (trimmed === undefined && validated === undefined) return existing;
    try {
      return await ctx.db.dashboardWidgetPreset.update({
        where: { id: existing.id },
        data: {
          ...(trimmed !== undefined ? { name: trimmed } : {}),
          ...(validated !== undefined ? { config: validated } : {}),
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw presetNameConflict(trimmed ?? existing.name);
      throw e;
    }
  },

  /**
   * #806 — delete one of the caller's presets. Placements already seeded from
   * it are untouched (apply copies the config; there is no live link).
   */
  deleteDashboardWidgetPreset: async (
    _: unknown,
    { presetRef }: { presetRef: string },
    ctx: Context,
  ) => {
    const userId = requireUserId(ctx);
    const existing = await requireOwnPreset(ctx, userId, presetRef);
    await ctx.db.dashboardWidgetPreset.delete({ where: { id: existing.id } });
    return true;
  },
};
