/**
 * The RENDER half of the run pipeline (spec cor:api:060): ONE assembler, `assembleRunNodePrompt`, for every surface
 * that shows or executes a run node's prompt: `runTask`, the GraphQL `renderRunNode` preview, and the MCP tools
 * `hadron_run_action` and `hadron_run_task` (#818, #858, #863). Render is the kernel's input (cor:api:060:05): a
 * second implementation drifts from what actually executes, and a preview that disagrees with the run is worse than
 * no preview at all.
 *
 * Deliberately PURE: no auth, no usage event, no writes. Loading and gating
 * stay at each callsite because the surfaces have different auth shapes
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
 * What `runTask` ACTUALLY assembles and sends to the LLM (#818 review,
 * Codex P1), extracted from `resolvers.mutation.session.ts` so a dry run can
 * predict a real run instead of approximating it. The only assembler since #863.
 *
 *   - Mustache via `compileTemplate` (memory-default data, cross-node
 *     references, includes): an unsupplied variable renders as the empty string.
 *   - Flow-ROUTING edges (`next*`, plan-multi-node D-MN-4) are the walker's
 *     rails, not references — inlining the next step's prompt into this one
 *     would pollute every hop of a multi-node flow. They are skipped.
 *   - A dangling edge (target row deleted) is skipped rather than
 *     dereferenced.
 *
 * ## `includeTarget` is REQUIRED, and that is the fix for #1063
 *
 * An edge can point across memories (#781), so inlining a target's content is a
 * read of ANOTHER memory. The predicate is a required parameter rather than an
 * optional hook on purpose: an optional gate is one a new call site can omit
 * and still compile. It is deliberately NOT an auth check performed here — this
 * module stays free of auth context — it is the caller's own gate, called at
 * the moment the content would cross the boundary. Returning false drops the
 * target silently: the run still succeeds, and the absence discloses nothing.
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
     * #1061 — called once per target actually INLINED. Routing edges,
     * empty-content targets and targets `includeTarget` drops are skipped
     * below, so a caller that recorded usage from `outgoingEdges` would count
     * reads for content it never returned. Reporting from inside the loop is
     * what keeps the two from drifting.
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
