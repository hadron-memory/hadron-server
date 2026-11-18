/**
 * #2047 (S10, cor:agt:040:03) — reading the immutable served-prompt record.
 *
 * Every field here authorizes itself; none leans on the parent query, because the parent types (`Worker`, `Session`) are
 * reached through wider audiences than the record may be read by. Who may read:
 *   - a bind's record: whoever may read the worker's internals (`maySeeWorkerInternals`);
 *   - a run's record: whoever may read the run (`canReadAppRun`, the same predicate `appRun` answers by);
 *   - a chatbot chat's record: whoever manages the App the chat runs in, never its end user (R41 B, `managesApp`).
 * A caller who may not read gets an EMPTY page or null, never Forbidden: the record is no existence oracle.
 *
 * Source-free by construction: a record names revisions by (node id, revSeq) and a hash. It never carries a loc, a title,
 * a node object or text, so reading it hands the caller no included part. Lists are cor:api:120:04 pages: `{items, total}`,
 * default 50, cap 200; provenance has its own page.
 */
import { lintCompiledRevision } from '../../../lib/compiledBootPromptLint.js';
import { isPlatformAdmin, type Context } from './resolvers.helpers.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { canReadAppRun } from './resolvers.appRun.js';

// resolvers.worker.ts mounts `Worker.servedPrompt` from this module at load, so this module may not import it
// statically: the gate is loaded when a field is read, which is after every module has finished loading.
async function maySeeWorkerInternals(ctx: Context, appId: string): Promise<boolean> {
  return (await import('./resolvers.worker.js')).maySeeWorkerInternals(ctx, appId);
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

type PageArgs = { limit?: number | null; offset?: number | null };
type Provenance = { nodeId: string; revSeq: number; hash: string };

const EMPTY_PAGE = { items: [] as never[], total: 0 };

export function pageOf({ limit, offset }: PageArgs): { take: number; skip: number } {
  return { take: Math.min(Math.max(limit ?? DEFAULT_PAGE, 0), MAX_PAGE), skip: Math.max(0, offset ?? 0) };
}

type ServedPromptRow = NonNullable<Awaited<ReturnType<Context['db']['servedPrompt']['findFirst']>>>;

/** Records of one owner column, newest first, as a page. The caller has already authorized the owner. */
async function recordsPage(ctx: Context, where: { sessionId: string } | { chatId: string; appId: string | null } | { runId: string }, args: PageArgs) {
  const { take, skip } = pageOf(args);
  const [items, total] = await Promise.all([
    take === 0 ? [] : ctx.db.servedPrompt.findMany({ where, orderBy: [{ servedAt: 'desc' }, { ordinal: 'desc' }], take, skip }),
    ctx.db.servedPrompt.count({ where }),
  ]);
  return { items, total };
}

async function mayManageApp(ctx: Context, appId: string): Promise<boolean> {
  const app = await ctx.db.app.findFirst({
    where: { id: appId, deletedAt: null },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  return app ? managesApp(ctx, app) : false;
}

/**
 * A chat's served-prompt records, by chat id alone: the ONE implementation behind `Chat.servedPrompts` and
 * `Query.chatServedPrompts` (#2862), so the two cannot drift. It needs no Chat object, so it hands the caller nothing
 * about the chat but its records.
 */
export async function chatServedPromptsById(chatId: string, args: PageArgs, ctx: Context) {
  // The chat's App is the one its records name; a chat with no record has nothing to read.
  // The authorized App is the chat's FIRST record's (deterministic: lowest ordinal), and only records under THAT App are
  // returned: authorizing one App's record must never hand over another App's rows for the same chat.
  const first = await ctx.db.servedPrompt.findFirst({ where: { chatId }, orderBy: { ordinal: 'asc' }, select: { appId: true } });
  if (!first) return EMPTY_PAGE;
  // A chat held in a memory no App owns is recorded under no App (Vera #42133): there is no App whose manager reads it, so
  // until Holger rules who does, only a platform admin (never an impersonation) reads it.
  if (first.appId === null ? ctx.impersonation || !isPlatformAdmin(ctx) : !(await mayManageApp(ctx, first.appId))) return EMPTY_PAGE;
  return recordsPage(ctx, { chatId, appId: first.appId }, args);
}

/** The fields mounted on `Session`, `Worker`, `AppRun` and `Chat`. */
export const servedPromptOwnerFields = {
  /** `Session.servedPrompts` — a bind's record(s). */
  sessionServedPrompts: async (s: { id: string; appId: string | null }, args: PageArgs, ctx: Context) => {
    if (!s.appId || !(await maySeeWorkerInternals(ctx, s.appId))) return EMPTY_PAGE;
    return recordsPage(ctx, { sessionId: s.id }, args);
  },

  /** `Worker.servedPrompt` — the record of the worker's open session; null when it has none. */
  workerServedPrompt: async (w: { id: string; appId: string }, _args: unknown, ctx: Context) => {
    if (!(await maySeeWorkerInternals(ctx, w.appId))) return null;
    const session = await ctx.db.session.findFirst({
      where: { workerId: w.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (!session) return null;
    return ctx.db.servedPrompt.findFirst({ where: { sessionId: session.id } });
  },

  /** `AppRun.servedPrompt` — the run's record. */
  runServedPrompt: async (
    r: { id: string; appId: string; organizationId: string; userId: string | null; createdBy: string | null; triggerKind: string },
    _args: unknown,
    ctx: Context,
  ) => {
    if (!(await canReadAppRun(ctx, r))) return null;
    return ctx.db.servedPrompt.findFirst({ where: { runId: r.id } });
  },

  /** `Chat.servedPrompts` — a chat's records (once at start, again when its served revision changed). */
  chatServedPrompts: (c: { id: string }, args: PageArgs, ctx: Context) => chatServedPromptsById(c.id, args, ctx),

};

/** Revision keys that still exist: the node's current revision (which has no history row yet) or a history row. */
async function liveRevisionKeys(ctx: Context, keys: Array<{ nodeId: string; revSeq: number }>): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const nodeIds = [...new Set(keys.map((k) => k.nodeId))];
  const [nodes, history] = await Promise.all([
    ctx.db.node.findMany({ where: { id: { in: nodeIds } }, select: { id: true, revSeq: true } }),
    ctx.db.nodeRevision.findMany({
      where: { nodeId: { in: nodeIds }, revNo: { in: [...new Set(keys.map((k) => k.revSeq))] } },
      select: { nodeId: true, revNo: true },
    }),
  ]);
  const live = new Set<string>();
  for (const n of nodes) live.add(`${n.id}:${n.revSeq}`);
  for (const h of history) live.add(`${h.nodeId}:${h.revNo}`);
  return live;
}

/** Field resolvers of the `ServedPrompt` type itself. The row reached here was already authorized by its owner field. */
export const servedPromptTypeResolvers = {
  ServedPrompt: {
    currentLint: (rec: ServedPromptRow, args: { first?: number | null; after?: string | null }, ctx: Context) =>
      lintCompiledRevision(ctx, rec.compiledNodeId, rec.provenanceRevSeq, args),
    /** The served revision is no longer retained: neither the node's current revision nor a history row. */
    pruned: async (rec: ServedPromptRow, _args: unknown, ctx: Context) => {
      const live = await liveRevisionKeys(ctx, [{ nodeId: rec.compiledNodeId, revSeq: rec.servedRevSeq }]);
      return !live.has(`${rec.compiledNodeId}:${rec.servedRevSeq}`);
    },
    /** `[{nodeId, revSeq, hash, pruned}]` — ids, revisions and hashes only, paginated. */
    provenance: async (rec: ServedPromptRow, args: PageArgs, ctx: Context) => {
      const all = Array.isArray(rec.provenance) ? (rec.provenance as unknown as Provenance[]) : [];
      const { take, skip } = pageOf(args);
      const slice = all.slice(skip, skip + take);
      const live = await liveRevisionKeys(ctx, slice);
      return {
        items: slice.map((e) => ({ nodeId: e.nodeId, revSeq: e.revSeq, hash: e.hash, pruned: !live.has(`${e.nodeId}:${e.revSeq}`) })),
        total: all.length,
      };
    },
  },
};
