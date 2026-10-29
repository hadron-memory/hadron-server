/**
 * #2063 replacement P4, hrn:node:hadronmemory.com:specs:cor:dmo:150:07.
 * Fixed, advisory save-result metadata. A pin is not itself a retention reason.
 * Read only through the caller's history scope; absent/denied history produces
 * no advice. Never follow another includer or decrypt a target to classify it.
 */
import { withoutRequestCaches, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { nodeRevisionsScope } from '../../api/graphql/schema/resolvers.query.node.js';
import { includeUrnTarget } from './includeUrnTarget.js';
import { includeTagKey } from './writeIncludes.js';
import { IncludeSyntaxError, parseIncludeTags } from './parseIncludeTags.js';

export interface IncludePinWarning { code: 'include.pin.unkept'; text: string }
const WARNING: IncludePinWarning = {
  code: 'include.pin.unkept',
  text: 'A pinned include revision carries no recorded approval or signature and may be automatically pruned, breaking the include.',
};

export async function plainPinWarnings(
  ctx: Context, source: { memoryId: string }, content: string | null | undefined, storedContent?: string | null,
): Promise<IncludePinWarning[]> {
  if (!content?.includes('{{>')) return [];
  // Advice runs after commit; pre-write role/memory memos are not a history
  // read at this later point. Reuse the shared gate with all request caches dropped.
  ctx = withoutRequestCaches(ctx);
  // #2750: retain this advisory precheck even though nodeRevisionsScope also
  // requires READER: that gate throws, but role-less post-write advice is silent.
  if (!ctx.roles?.some(r => ['OWNER', 'ADMIN', 'CONTRIBUTOR', 'READER'].includes(r))) return [];
  let tags;
  try { tags = parseIncludeTags(content); }
  catch (error) { if (error instanceof IncludeSyntaxError) return []; throw error; }
  let prior = new Set<string>();
  try { prior = new Set(parseIncludeTags(storedContent ?? '').map(includeTagKey)); }
  catch (error) { if (!(error instanceof IncludeSyntaxError)) throw error; }
  for (const tag of tags) {
    if (prior.has(includeTagKey(tag))) continue;
    const revision = tag.settings.rev;
    if (revision === undefined || !Number.isSafeInteger(revision)) continue;
    const target = tag.kind === 'urn'
      ? await includeUrnTarget(ctx.db, tag.target)
      : await ctx.db.node.findFirst({
        where: { memoryId: source.memoryId, loc: tag.target, deletedAt: null, memory: { deletedAt: null } },
        select: { id: true },
      });
    if (!target) continue;
    const scope = await nodeRevisionsScope(ctx, target.id);
    if (!scope) continue;
    // Resolve the exact number first. A foreign-memory snapshot must not fall
    // through to the live row even if it holds the same number.
    const snapshot = await ctx.db.nodeRevision.findFirst({
      where: { nodeId: target.id, revNo: revision },
      select: { id: true, memoryId: true },
    });
    if (snapshot && !scope.canRead(snapshot.memoryId ?? scope.memoryId)) continue;
    const live = await ctx.db.node.findFirst({
      where: { id: target.id, memoryId: scope.memoryId, deletedAt: null, memory: { deletedAt: null } },
      select: { revSeq: true, approvedRevNo: true, approvalHash: true },
    });
    if (!live || (!snapshot && live.revSeq !== revision)) continue;
    const readableSnapshot = snapshot ? await ctx.db.nodeRevision.findFirst({
      where: { id: snapshot.id, nodeId: target.id,
        // #2750 / cor:dmo:150:07: unrestricted history admits the capture
        // above and applies no SQL memory filter. An empty OR arm is not TRUE.
        ...(scope.accessible === null ? {} : {
          OR: [{ memoryId: scope.memoryId }, { memoryId: null }, { memoryId: { in: scope.accessible } }],
        }),
      }, select: { approvalHash: true },
    }) : null;
    if (snapshot && !readableSnapshot) continue;
    const carriesApproval = snapshot ? readableSnapshot!.approvalHash !== null
      : live.approvedRevNo === revision && live.approvalHash !== null;
    if (carriesApproval) continue;
    const signature = await ctx.db.nodeSignature.findFirst({
      where: { nodeId: target.id, revision }, select: { id: true },
    });
    if (!signature) return [{ ...WARNING }]; // one fixed warning, no target identities or payload
  }
  return [];
}

export function renderIncludePinWarnings(warnings: readonly IncludePinWarning[] | null | undefined): string {
  return warnings?.length ? `\n\nWarning [${WARNING.code}]: ${WARNING.text}` : '';
}

// Response metadata is held outside the Node object and keyed by the exact
// request Context. A later query, another target or a reused object in another
// request cannot inherit it. Ordinary reads never invoke a history lookup.
const generations = new WeakMap<Context, object>();
const results = new WeakMap<Context, WeakMap<object, Promise<IncludePinWarning[] | null>>>();
const collected = new WeakMap<Context, { path: string; pending: Promise<IncludePinWarning[] | null> }[]>();
const paths = new WeakMap<Context, string>();
const projections = new WeakMap<Context, WeakMap<object, object>>();
export function resetIncludePinWarnings(ctx: Context): void {
  generations.set(ctx, {});
  results.delete(ctx); collected.delete(ctx); paths.delete(ctx); projections.delete(ctx);
}
export function captureIncludePinWarningLifetime(ctx: Context) {
  return { generation: generations.get(ctx), path: paths.get(ctx) ?? 'mcp' };
}
export function attachIncludePinWarnings(
  ctx: Context, result: object & { memoryId: string }, content: string | null | undefined, storedContent?: string | null, readCtx = ctx, lifetime = captureIncludePinWarningLifetime(ctx),
): void {
  if (lifetime.generation !== generations.get(ctx)) return;
  let perRequest = results.get(ctx);
  if (!perRequest) { perRequest = new WeakMap(); results.set(ctx, perRequest); }
  const pending = safePlainPinWarnings(readCtx, result, content, storedContent);
  perRequest.set(result, pending);
  const entries = collected.get(ctx) ?? [];
  entries.push({ path: lifetime.path, pending });
  collected.set(ctx, entries);
}
export function includePinWarningsFor(ctx: Context, result: object): Promise<IncludePinWarning[] | null> | null {
  const seen = new Set<object>();
  let source = result;
  while (!seen.has(source)) {
    seen.add(source);
    const pending = results.get(ctx)?.get(source);
    if (pending) return pending;
    const prior = projections.get(ctx)?.get(source);
    if (!prior) return null;
    source = prior;
  }
  return null;
}
/** Advice is post-commit only: any lookup fault means unavailable advice,
 * never a failed/replayed committed write. No error prose leaves this seam. */
export async function safePlainPinWarnings(
  ctx: Context, source: { memoryId: string }, content: string | null | undefined, storedContent?: string | null,
): Promise<IncludePinWarning[] | null> {
  try { return await plainPinWarnings(ctx, source, content, storedContent); }
  catch { return null; }
}

/** Preserve response-only advice across the writer's read-audience projection. */
export function carryIncludePinWarnings(ctx: Context, from: object, to: object): void {
  if (from === to) return;
  let perRequest = projections.get(ctx);
  if (!perRequest) { perRequest = new WeakMap(); projections.set(ctx, perRequest); }
  // An outer transaction may commit after projection. Keep only the request's
  // object lineage; advice is still absent until the afterCommit callback runs.
  perRequest.set(to, from);
}

/** The GraphQL plugin captures the root mutation response key before its write. */
export function beginIncludeWarningPath(ctx: Context, path: string): () => void {
  paths.set(ctx, path);
  return () => { if (paths.get(ctx) === path) paths.delete(ctx); };
}
export async function responseIncludePinWarnings(ctx: Context, errored: ReadonlySet<string>) {
  const out: { path: string; code: string; text: string }[] = [];
  const seen = new Set<string>();
  const entries = collected.get(ctx) ?? [];
  collected.delete(ctx);
  generations.delete(ctx); // late owner callbacks cannot file into another response
  for (const entry of entries) {
    if (errored.has(entry.path)) continue;
    for (const warning of await entry.pending ?? []) {
      const key = `${entry.path}:${warning.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: entry.path, ...warning });
      if (out.length >= 20) return out;
    }
  }
  return out;
}
