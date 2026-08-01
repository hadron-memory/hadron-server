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

/** The node shape the render needs: content, name, and its dependency edges. */
export interface RenderableRunNode {
  id: string;
  name: string | null;
  content: string | null;
  memoryId: string;
  outgoingEdges: Array<{
    target: {
      loc: string;
      name: string | null;
      content: string | null;
      memoryId: string;
    };
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
    if (target.content) {
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
