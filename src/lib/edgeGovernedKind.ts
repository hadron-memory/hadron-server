/**
 * The read projection of `Edge.governedKind` (#2124) — ONE strict validator
 * shared by every GraphQL `Edge` / `GraphEdge` return and every MCP edge line.
 *
 * `null` is the single value that means "ordinary edge", and it means that only
 * as a stored SQL NULL. The kind is the edge's OWN column, read under the gate
 * that already admitted the edge: never inferred from the edge name, the loc or
 * the endpoint's role, and never the cue for another lookup. A value this server
 * does not know is a schema-integrity error, NOT a quiet `null`: reading an
 * unknown governed edge as ordinary is the one mistake that lets a client offer
 * edit/delete on an edge the server will refuse (D9, Vera 6264765407).
 *
 * Pure: no database access.
 */
import { GraphQLError } from 'graphql';

export const EDGE_GOVERNED_KINDS = ['INCLUDE', 'COMMENT_ANCHOR', 'COMMENT_REPLY'] as const;
export type EdgeGovernedKindValue = (typeof EDGE_GOVERNED_KINDS)[number];

export const UNSUPPORTED_EDGE_GOVERNED_KIND = 'UNSUPPORTED_EDGE_GOVERNED_KIND';

export class UnsupportedEdgeGovernedKindError extends GraphQLError {
  constructor(reason: string) {
    super(`${UNSUPPORTED_EDGE_GOVERNED_KIND}: ${reason}`, {
      extensions: { code: UNSUPPORTED_EDGE_GOVERNED_KIND },
    });
  }
}

/**
 * `null` → `null`; a known kind → itself. `undefined` (a projection that did not
 * select the column) and any other value throw — neither is "ordinary".
 */
export function projectGovernedKind(raw: unknown): EdgeGovernedKindValue | null {
  if (raw === null) return null;
  if (raw === undefined) {
    throw new UnsupportedEdgeGovernedKindError('the edge projection did not select governedKind');
  }
  if (typeof raw === 'string' && (EDGE_GOVERNED_KINDS as readonly string[]).includes(raw)) {
    return raw as EdgeGovernedKindValue;
  }
  throw new UnsupportedEdgeGovernedKindError('the stored governed kind is not one this server supports');
}

/** The MCP annotation for one edge line, e.g. ` (governedKind: INCLUDE)`. */
export function governedKindAnnotation(raw: unknown): string {
  return ` (governedKind: ${projectGovernedKind(raw) ?? 'null'})`;
}
