/**
 * Edge selection for the multi-node headless runner (plan-multi-node §5).
 *
 * Given the flow's current node, pick the outgoing edge the run follows
 * next — or null, which terminates the run COMPLETED (D-2026-05-09-007:
 * "no firing edge" is the normal end of a flow, not an error).
 *
 * Routing grammar (D7 + D-MN-4): ONLY edges named `next` or
 * `next.<index>[.<name>]` participate. Everything else — `documents`,
 * `depends-on`, abstract-of — is invisible to routing, so graph authors
 * can annotate flow nodes freely without the walker wandering into a
 * dependency. An unnamed edge falls back to the name segment of its
 * derived loc (`<sourceLoc>:<name>:<targetLoc>`, see src/lib/edgeLoc.ts).
 *
 * Ordering: `Edge.priority` ASC (schema convention: lower fires first),
 * then the numeric `<index>` from the routing name (missing index sorts
 * last), then `loc` lexical as the stable tiebreak.
 *
 * Conditions ride the shared edge-condition evaluator — the same engine
 * chat transitions use — with the run's merged view mounted at the
 * `message.data.*` scope (D-MN-1).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import {
  evaluateEdgeCondition,
  type MemoryLayerHandle,
} from '../edge-conditions/index.js';
import { buildPrismaMemoryLayer } from '../edge-conditions/prisma-memory-layer.js';
import { emitNodeUrnV2 } from '../urnEmit.js';

export interface FlowSourceNode {
  id: string;
  memoryId: string;
  loc: string;
  /** Fully-qualified node URN — evaluator diagnostics only. */
  urn: string;
}

export interface NextEdgeSelection {
  edgeId: string;
  /** The resolved routing name (`next`, `next.1.high-confidence`, …). */
  edgeName: string;
  /** Walkable v2 URN of the target node (`hrn:node:<root>:<mem>:<loc…>`). */
  targetUrn: string;
}

/** A condition that cannot be evaluated fails the RUN loudly (D15-sub). */
export class EdgeConditionEvalError extends Error {
  constructor(
    message: string,
    readonly edgeId: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'EdgeConditionEvalError';
  }
}

/** D-MN-4 grammar: `next` or `next.<anything>` routes; nothing else does. */
export function isRoutingName(name: string): boolean {
  return name === 'next' || name.startsWith('next.');
}

/** Routing name of an edge: explicit name, else the loc's derived segment. */
export function routingNameOf(edge: { name: string | null; loc: string }, sourceLoc: string): string {
  if (edge.name) return edge.name;
  // deriveEdgeLoc composes `<sourceLoc>:<sanitized-name>:<targetLoc>` — peel
  // the source prefix and take the first remaining atom.
  const prefix = `${sourceLoc}:`;
  const rest = edge.loc.startsWith(prefix) ? edge.loc.slice(prefix.length) : edge.loc;
  return rest.split(':')[0] ?? '';
}

/** Numeric `<index>` from `next.<index>[...]`; missing/non-numeric sorts last. */
function routingIndexOf(name: string): number {
  const second = name.split('.')[1];
  return second != null && /^\d+$/.test(second) ? Number(second) : Number.POSITIVE_INFINITY;
}

/**
 * Pick the next edge from `sourceNode`, evaluating conditions against
 * `view` (the run's `{...eventData, ...envelope}` merge). Returns null
 * when no routing edge fires — the flow's normal termination.
 *
 * @throws EdgeConditionEvalError when a condition cannot be evaluated
 *         (unknown operator, encrypted memory without key, …) — the
 *         caller terminates the run FAILED rather than guessing.
 */
export async function selectNextEdge(
  db: PrismaClient,
  args: {
    sourceNode: FlowSourceNode;
    view: Record<string, unknown>;
    /** Agent config/state bag for `agent.*` conditions; headless v1 passes none. */
    agentBag?: Record<string, unknown>;
  },
): Promise<NextEdgeSelection | null> {
  const { sourceNode, view } = args;

  const edges = await db.edge.findMany({
    where: { sourceId: sourceNode.id, deletedAt: null },
    select: {
      id: true,
      name: true,
      loc: true,
      priority: true,
      condition: true,
      target: {
        select: {
          loc: true,
          deletedAt: true,
          memory: { select: { urn: true, deletedAt: true } },
        },
      },
    },
  });

  const routable = edges
    .map((e) => ({ ...e, routingName: routingNameOf(e, sourceNode.loc) }))
    .filter(
      (e) =>
        isRoutingName(e.routingName) &&
        e.target != null &&
        !e.target.deletedAt &&
        !e.target.memory.deletedAt,
    )
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority; // lower fires first
      const ai = routingIndexOf(a.routingName);
      const bi = routingIndexOf(b.routingName);
      if (ai !== bi) return ai - bi;
      return a.loc.localeCompare(b.loc);
    });

  if (routable.length === 0) return null;

  // One memory layer for every candidate — they share the source node.
  const memoryLayers: MemoryLayerHandle[] = [
    await buildPrismaMemoryLayer(db, 'edge-memory', sourceNode.memoryId, sourceNode.loc),
  ];

  for (const edge of routable) {
    const result = await evaluateEdgeCondition({
      condition: edge.condition, // null ⇒ always fires (the fall-through edge)
      edge: { id: edge.id, sourceNodeUrn: sourceNode.urn },
      memoryLayers,
      agent: args.agentBag ?? {},
      messageData: view, // D-MN-1: envelope + eventData at message.data.*
    });
    if (!result.ok) {
      throw new EdgeConditionEvalError(
        `Edge condition on "${edge.routingName}" (${edge.id}) failed to evaluate: ` +
          `${result.error.code} — ${result.error.message}`,
        edge.id,
        result.error.code,
      );
    }
    if (result.fired) {
      return {
        edgeId: edge.id,
        edgeName: edge.routingName,
        targetUrn: emitNodeUrnV2(edge.target!.memory.urn, edge.target!.loc),
      };
    }
  }
  return null; // no edge fired → the flow ends here, successfully (D7)
}
