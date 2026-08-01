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
 * edge-linked node as a "Referenced Nodes" section.
 *
 * Substitution is a literal `replaceAll` per key, NOT a Mustache render — it
 * matches what the runner does, and changing it here would silently change
 * execution.
 */
export async function renderRunNodeBundle(
  node: RenderableRunNode,
  args: Record<string, string> | undefined,
  memoryUrnOf: MemoryUrnLookup,
): Promise<string> {
  let actionContent = node.content || '';
  if (args) {
    for (const [key, value] of Object.entries(args)) {
      actionContent = actionContent.replaceAll(`{{${key}}}`, value);
    }
  }
  const topicSections: string[] = [];
  for (const edge of node.outgoingEdges) {
    const target = edge.target;
    if (target?.content) {
      const targetUrn = emitNodeUrnV2(await memoryUrnOf(target.memoryId), target.loc);
      topicSections.push(`## Node: ${target.name} (${targetUrn})\n\n${target.content}`);
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
    includeTarget?: (target: RenderableRunNode['outgoingEdges'][number]['target']) => boolean;
  },
): Promise<string> {
  let actionContent = node.content || '';
  if (actionContent.includes('{{')) {
    actionContent = await deps.compileTemplate(actionContent, args ?? null, node.memoryId);
  }

  const topicSections: string[] = [];
  for (const edge of node.outgoingEdges) {
    if (isRoutingName(routingNameOf(edge as never, node.loc))) continue;
    const target = edge.target;
    if (!target?.content) continue;
    if (deps.includeTarget && !deps.includeTarget(target)) continue;
    const targetUrn = emitNodeUrnV2(await deps.memoryUrnOf(target.memoryId), target.loc);
    topicSections.push(`## Node: ${target.name} (${targetUrn})\n\n${target.content}`);
  }

  const parts = [`# Node: ${node.name}\n\n${actionContent}`];
  if (topicSections.length > 0) {
    parts.push('---\n\n# Referenced Nodes\n\n' + topicSections.join('\n\n---\n\n'));
  }
  return parts.join('\n\n');
}
