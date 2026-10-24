import { memoryAccessFilter, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isBootPromptRole } from '../bootPrompt.js';
import { compileTemplate } from '../template.js';
import { IncludeReadMemo, INCLUDE_LITERAL_NODE_TYPES, spliceIncludes } from './spliceIncludes.js';

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
}

interface RequestState {
  access: Promise<Record<string, unknown>>;
  memo: IncludeReadMemo;
}

// One state per request Context: a Context belongs to one principal and one
// request, so no resolved or authorized result can ever serve another caller.
const states = new WeakMap<object, RequestState>();

function stateOf(ctx: Context): RequestState {
  let s = states.get(ctx);
  if (!s) {
    s = { access: memoryAccessFilter(ctx), memo: new IncludeReadMemo() };
    states.set(ctx, s);
  }
  return s;
}

/**
 * The text to serve for `node`'s content, read as `ctx`'s principal. Reads
 * only: the node's row and every stored artifact keep the stored text.
 */
export async function resolveNodeContent(
  ctx: Context, node: ResolvableNode, opts: ResolveContentOptions = {},
): Promise<string | null> {
  const stored = node.content;
  if (opts.raw || !stored || !stored.includes('{{')) return stored;
  if (node.nodeType && INCLUDE_LITERAL_NODE_TYPES.has(node.nodeType)) return stored;
  const { access, memo } = stateOf(ctx);
  const filter = await access;
  const options = { foreign: true, memo };
  // #2043 (cor:dmo:150:08) — a direct read of a boot-prompt node, source or
  // compiled, shows the platform variables as written: includes resolve, the
  // Mustache render over data is skipped. The bind fills them, never a read.
  if (opts.mode === 'includes' || isBootPromptRole(node.role)) {
    return spliceIncludes(ctx.db, filter, stored, node, options);
  }
  return compileTemplate(
    stored, (node.data ?? null) as Record<string, unknown> | null, node.memoryId, ctx.db, filter, undefined,
    { ...options, includer: node },
  );
}
