/**
 * The RENDER half of the run pipeline (spec cor:api:060), extracted so the MCP
 * tools and the GraphQL `renderRunNode` query produce a byte-identical bundle.
 *
 * Why extracted (#818): `hadron_run_action` and `hadron_run_task`'s non-execute
 * path both call this, and the GraphQL preview must too. A second
 * implementation would drift from what `runTask` actually executes — and a
 * preview that disagrees with the run is worse than no preview at all.
 *
 * Deliberately PURE: no auth, no usage event, no writes. Loading and gating
 * stay at each callsite because the two surfaces have different auth shapes
 * (MCP `AuthContext` vs GraphQL `Context`), and the MCP `action-run` UsageEvent
 * stays at its callsite too — recording a metered action for a side-effect-free
 * preview would inflate the usage ledger.
 */

import { emitNodeUrnV2 } from './urnEmit.js';
import { isRoutingName, routingNameOf } from './runner/selectNextEdge.js';

/** The node shape the render needs: content, name, and its dependency edges. */
export interface RenderableRunNode {
  id: string;
  name: string | null;
  content: string | null;
  memoryId: string;
  outgoingEdges: Array<{
    /** Needed by the routing-edge check in assembleRunNodePrompt. */
    name?: string | null;
    loc?: string;
    /** `INCLUDE` edges (#2040) are derived from the content's own tags, which the template render already inlines. */
    governedKind?: string | null;
    target: {
      loc: string;
      name: string | null;
      content: string | null;
      memoryId: string;
    } | null;
  }>;
}

/** Resolve a memoryId to its stored bare URN (memoized by the caller). */
export type MemoryUrnLookup = (memoryId: string) => Promise<string>;

/**
 * Substitute `{{arg}}` placeholders, then append the content of every
 * edge-linked node the caller may READ as a "Referenced Nodes" section.
 *
 * Substitution is a literal `replaceAll` per key, NOT a Mustache render — it
 * matches what the runner does, and changing it here would silently change
 * execution.
 *
 * ## `includeTarget` is REQUIRED, and that is the fix for #1063
 *
 * An edge can point across memories (#781), so inlining a target's content is a
 * read of ANOTHER memory — and this renderer previously had no way to express
 * that, let alone enforce it. The MCP run tools handed it `node.outgoingEdges`
 * whole and returned a foreign memory's content to a caller who could read only
 * the run node's own memory, while the GraphQL preview of the same node omitted
 * it. A cross-tenant read, and a preview disagreeing with the run (#818).
 *
 * The predicate is a required parameter rather than an optional hook on
 * purpose. An optional gate is one a new call site can omit and still compile,
 * which is exactly how this surface came to have none; required, the compiler
 * asks the question and a caller must answer it. It is deliberately NOT an auth
 * check performed here — this module stays free of auth context (the two
 * surfaces have different principal shapes) — it is the caller's own gate,
 * called at the moment the content would cross the boundary.
 */
export async function renderRunNodeBundle(
  node: RenderableRunNode,
  args: Record<string, string> | undefined,
  deps: {
    memoryUrnOf: MemoryUrnLookup;
    /**
     * #1063 — may this caller read the target's memory? Returning false drops
     * the target from the bundle silently, which is the right shape: the run
     * still succeeds, and the absence discloses nothing about what was omitted.
     */
    includeTarget: (
      target: NonNullable<RenderableRunNode['outgoingEdges'][number]['target']>,
    ) => Promise<boolean> | boolean;
    /**
     * #1061 — called once per target whose content is actually INLINED into the
     * bundle. Usage recording must count what crossed the response boundary, and
     * a target with empty content is skipped below; a caller that recorded every
     * outgoing edge instead would inflate the read series for exactly the nodes
     * it did not return. Reporting from inside the loop is what keeps the two
     * from drifting — a second copy of this predicate at the call site is the
     * bug waiting to happen. Since #1063 that argument is doubly true: the loop
     * now also drops unreadable targets, so `outgoingEdges` and "what was
     * returned" differ for a second reason.
     */
    onTargetInlined?: (target: RenderableRunNode['outgoingEdges'][number]['target']) => void;
  },
): Promise<string> {
  let actionContent = node.content || '';
  if (args) {
    for (const [key, value] of Object.entries(args)) {
      actionContent = actionContent.replaceAll(`{{${key}}}`, value);
    }
  }
  const topicSections: string[] = [];
  for (const edge of node.outgoingEdges) {
    if (edge.governedKind === 'INCLUDE') continue;
    const target = edge.target;
    if (target?.content) {
      if (!(await deps.includeTarget(target))) continue;
      const targetUrn = emitNodeUrnV2(await deps.memoryUrnOf(target.memoryId), target.loc);
      topicSections.push(`## Node: ${target.name} (${targetUrn})\n\n${target.content}`);
      deps.onTargetInlined?.(target);
    }
  }
  const parts = [`# Node: ${node.name}\n\n${actionContent}`];
  if (topicSections.length > 0) {
    parts.push('---\n\n# Referenced Nodes\n\n' + topicSections.join('\n\n---\n\n'));
  }
  return parts.join('\n\n');
}


/**
 * What `runTask` ACTUALLY assembles and sends to the LLM (#818 review,
 * Codex P1), extracted from `resolvers.mutation.session.ts` so a dry run can
 * predict a real run instead of approximating it.
 *
 * This differs from `renderRunNodeBundle` above in three ways that matter, and
 * every one of them can change the prompt:
 *   - Mustache via `compileTemplate` (memory-default data, cross-node
 *     references, partials), not a literal `replaceAll` per key. Even simple
 *     values diverge: `null` renders as "null" under replaceAll and as the
 *     empty string under Mustache.
 *   - Flow-ROUTING edges (`next*`, plan-multi-node D-MN-4) are the walker's
 *     rails, not references — inlining the next step's prompt into this one
 *     would pollute every hop of a multi-node flow. The legacy bundle inlines
 *     every outgoing edge.
 *   - A dangling edge (target row deleted) is skipped rather than
 *     dereferenced.
 *
 * `renderRunNodeBundle` is retained because the MCP `hadron_run_action` /
 * `hadron_run_task` render path has always produced it and changing a shipped
 * tool's output is a separate decision — tracked separately.
 */
export async function assembleRunNodePrompt(
  node: RenderableRunNode & { loc: string },
  args: Record<string, string> | undefined,
  deps: {
    memoryUrnOf: MemoryUrnLookup;
    compileTemplate: (
      content: string,
      data: Record<string, string> | null,
      memoryId: string,
    ) => Promise<string>;
    /** Include a referenced target? Lets a caller drop unreadable/deleted ones. */
    includeTarget: (target: RenderableRunNode['outgoingEdges'][number]['target']) => boolean | Promise<boolean>;
    /**
     * #1061 — called once per target actually INLINED. Routing edges and
     * empty-content targets are skipped below, so a caller that recorded usage
     * from `outgoingEdges` would count reads for content it never returned.
     * See the note on `renderRunNodeBundle`'s identical hook.
     */
    onTargetInlined?: (target: RenderableRunNode['outgoingEdges'][number]['target']) => void;
  },
): Promise<string> {
  let actionContent = node.content || '';
  if (actionContent.includes('{{')) {
    actionContent = await deps.compileTemplate(actionContent, args ?? null, node.memoryId);
  }

  const topicSections: string[] = [];
  for (const edge of node.outgoingEdges) {
    if (isRoutingName(routingNameOf(edge as never, node.loc))) continue;
    if (edge.governedKind === 'INCLUDE') continue;
    const target = edge.target;
    if (!target?.content) continue;
    if (!(await deps.includeTarget(target))) continue;
    const targetUrn = emitNodeUrnV2(await deps.memoryUrnOf(target.memoryId), target.loc);
    topicSections.push(`## Node: ${target.name} (${targetUrn})\n\n${target.content}`);
    deps.onTargetInlined?.(target);
  }

  const parts = [`# Node: ${node.name}\n\n${actionContent}`];
  if (topicSections.length > 0) {
    parts.push('---\n\n# Referenced Nodes\n\n' + topicSections.join('\n\n---\n\n'));
  }
  return parts.join('\n\n');
}
