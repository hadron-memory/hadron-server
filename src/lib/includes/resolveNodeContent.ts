import { memoryAccessFilter, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isBootPromptRole } from '../bootPrompt.js';
import { compileTemplate } from '../template.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { partialMemoryFollowable } from '../automation/partialFollow.js';
import { IncludeReadMemo, INCLUDE_LITERAL_NODE_TYPES, spliceIncludes } from './spliceIncludes.js';
import {
  RequestResolutionBudget, ResolutionBudget, isContentResolutionLimitError, type ResolutionSurface,
} from './resolutionBudget.js';

export { BROKEN_INCLUDE_NOTICE, INCLUDE_LITERAL_NODE_TYPES } from './spliceIncludes.js';

/** A node as a read surface holds it: the row, content already decrypted. */
export interface ResolvableNode {
  id: string;
  memoryId: string;
  content: string | null;
  data?: unknown;
  nodeType?: string | null;
  role?: string | null;
}

export interface ResolveContentOptions {
  /** Return the stored text with its include tags as written (cor:dmo:150:03). */
  raw?: boolean;
  /**
   * `full` (default) is the ordinary read: includes plus data variables.
   * `includes` resolves include tags only and leaves `{{var}}` as written, for
   * exports that must ship variables verbatim. A boot-prompt node (role family,
   * #2043) always reads as `includes`.
   */
  mode?: 'full' | 'includes';
  /** Counts the includes that could not be resolved (see `SpliceOptions.broken`). */
  broken?: { count: number };
  /**
   * hadron-internal#40 — charge the served text to the request's aggregate budget (default). The
   * skill-corpus export passes false: it is bounded per node only (ruling 0197 (4)).
   */
  requestBudget?: boolean;
  /** Where the text is shown. An export's refusal names an export remedy, since it has no raw read (default `read`). */
  surface?: ResolutionSurface;
}

interface RequestState {
  access: Promise<Record<string, unknown>>;
  memo: IncludeReadMemo;
}

// One state per request Context: a Context belongs to one principal and one
// request, so no resolved or authorized result can ever serve another caller.
const states = new WeakMap<object, RequestState>();
// #40: resolved bytes each request has served; owned by its Context only. Kept apart from the
// read state so charging a direct compile starts no access-filter query.
const servedByRequest = new WeakMap<object, RequestResolutionBudget>();

function stateOf(ctx: Context): RequestState {
  let s = states.get(ctx);
  if (!s) {
    s = { access: memoryAccessFilter(ctx), memo: new IncludeReadMemo() };
    states.set(ctx, s);
  }
  return s;
}

function servedOf(ctx: Context): RequestResolutionBudget {
  let served = servedByRequest.get(ctx);
  if (!served) {
    served = new RequestResolutionBudget();
    servedByRequest.set(ctx, served);
  }
  return served;
}

/**
 * The text to serve for `node`'s content, read as `ctx`'s principal. Reads
 * only: the node's row and every stored artifact keep the stored text.
 *
 * hadron-internal#40 (rulings 0196/0197): a resolved read runs under its own budget and charges
 * what it serves to the request's aggregate. Over either it throws `ContentResolutionLimitError`
 * (one typed refusal naming the limit); it never returns partial text. `raw` and a body with no
 * template syntax are served as stored and never charged.
 */
export async function resolveNodeContent(
  ctx: Context, node: ResolvableNode, opts: ResolveContentOptions = {},
): Promise<string | null> {
  if (opts.surface !== 'export') return resolveForRead(ctx, node, opts);
  try {
    return await resolveForRead(ctx, node, opts);
  } catch (e) {
    throw isContentResolutionLimitError(e) ? e.forExport() : e;
  }
}

/**
 * Charge `text` to the request's aggregate (ruling 0197 (2)) for a served resolved read that does
 * not come through `resolveNodeContent`: a direct `compileTemplate` whose result the request
 * returns or sends on (the chat system message, the run-node render). Over the aggregate it throws
 * the typed `requestBytes` refusal and the text is not served (#40). `stored` is the
 * source text, `text` what the compile produced from it.
 */
export function chargeRequestServed(ctx: Context, stored: string, text: string): string {
  // Like `resolveNodeContent`, a body with no template syntax is served as stored and never charged.
  if (stored.includes('{{')) servedOf(ctx).chargeServed(text);
  return text;
}

/**
 * #4689 (hrn:node:hadronmemory.com:specs:cor:api:060:05): the compile step of a run node's prompt, the one
 * `assembleRunNodePrompt` dependency every run surface passes (the MCP run tools, `renderRunNode`, and `runTask`,
 * which the run kernel calls under the run principal). One assembly, so every surface changes together.
 *
 * Includes resolve as `ctx` reads, with the request's real read filter (the shared gate, as a node read uses), so a
 * full node URN may name a node in another memory (hrn:node:hadronmemory.com:specs:cor:dmo:150:02) and only a target
 * the reader cannot read is the notice (hrn:node:hadronmemory.com:specs:cor:dmo:150:04, :05). The run node's own
 * memory is added to the filter: every caller gated it before assembling (as the earlier unrestricted `{}` compile
 * relied on), so a same-memory include and the memory's data node read as they did.
 *
 * Who reads (ruling A, Holger 2026-11-23): a render's reader is the caller. An executed run's reader is its run
 * principal, and a foreign memory must also pass the adoption rule (`partialMemoryFollowable`: same organization,
 * plaintext, readable by the principal), so a run splices exactly the partials its adoption pinned.
 *
 * The compiled text is charged to the request's aggregate (#40), as a direct compile must be.
 */
export async function compileRunNodeContent(
  ctx: Context, content: string, data: Record<string, string> | null, memoryId: string,
): Promise<string> {
  const { access, memo } = stateOf(ctx);
  const filter = await access;
  const text = await compileTemplate(content, data, memoryId, ctx.db, { OR: [{ memoryId }, filter] }, undefined, {
    foreign: true, memo, ...(isRunPrincipal(ctx) ? { followForeign: runIncludeFollower(ctx) } : {}),
  });
  return chargeRequestServed(ctx, content, text);
}

/** The adoption rule for one run principal, memoized per memory for the compile's lifetime. */
function runIncludeFollower(ctx: Context): (memoryId: string) => Promise<boolean> {
  const principal = {
    clientId: ctx.clientId, userId: ctx.userId, appId: ctx.appId, sessionId: ctx.sessionId, roles: ctx.roles,
    organizationId: ctx.organizationId, impersonation: ctx.impersonation,
  };
  const answers = new Map<string, Promise<boolean>>();
  return (memoryId) => {
    let answer = answers.get(memoryId);
    if (!answer) {
      answer = ctx.db.memory.findUnique({
        where: { id: memoryId }, select: { id: true, organizationId: true, isEncrypted: true, deletedAt: true },
      }).then((mem) => partialMemoryFollowable(ctx.db, principal, ctx.organizationId, mem));
      answers.set(memoryId, answer);
    }
    return answer;
  };
}

async function resolveForRead(
  ctx: Context, node: ResolvableNode, opts: ResolveContentOptions,
): Promise<string | null> {
  const stored = node.content;
  if (opts.raw || !stored || !stored.includes('{{')) return stored;
  if (node.nodeType && INCLUDE_LITERAL_NODE_TYPES.has(node.nodeType)) return stored;
  const { access, memo } = stateOf(ctx);
  const filter = await access;
  const budget = new ResolutionBudget();
  const options = { foreign: true, memo, budget, ...(opts.broken ? { broken: opts.broken } : {}) };
  // #2043 (cor:dmo:150:08) — a direct read of a boot-prompt node, source or
  // compiled, shows the platform variables as written: includes resolve, the
  // Mustache render over data is skipped. The bind fills them, never a read.
  const text = opts.mode === 'includes' || isBootPromptRole(node.role)
    ? await spliceIncludes(ctx.db, filter, stored, node, options)
    : await compileTemplate(
      stored, (node.data ?? null) as Record<string, unknown> | null, node.memoryId, ctx.db, filter, undefined,
      { ...options, includer: node },
    );
  if (opts.requestBudget !== false) servedOf(ctx).chargeServed(text);
  return text;
}
