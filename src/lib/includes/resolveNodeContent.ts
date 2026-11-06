import { memoryAccessFilter, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isBootPromptRole } from '../bootPrompt.js';
import { compileTemplate } from '../template.js';
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
 * the typed `requestBytes` refusal and the text is not served (#40 LOCAL review). `stored` is the
 * source text, `text` what the compile produced from it.
 */
export function chargeRequestServed(ctx: Context, stored: string, text: string): string {
  // Like `resolveNodeContent`, a body with no template syntax is served as stored and never charged.
  if (stored.includes('{{')) servedOf(ctx).chargeServed(text);
  return text;
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
