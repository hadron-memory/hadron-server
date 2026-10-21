/**
 * #2046 (S9, R38) — the immutable provenance of a compiled boot-prompt revision,
 * and the one seam that reads a compiled revision WITH its own provenance.
 *
 * Each compile writes a new revision of the compiled node and, in the same
 * transaction, one `compiled_prompt_revisions` row keyed by that revision. The
 * row records what the compile selected, never copied source text: the root
 * source and every include or replacing node as `{nodeId, revNo, hash}`, its
 * place in the expansion, and the EFFECTIVE selection settings the shared
 * parser and selector applied (S11: stored explicitly, never reconstructed from
 * later-edited or pruned source text).
 *
 * `readCompiledRevision` pairs a revision's text with THAT revision's row. It
 * never substitutes the latest compile or the derived compiled-from edge: a
 * session serving revision 1 while revision 2 waits for approval still reports
 * revision 1's provenance. A missing or malformed row is an integrity failure.
 */

import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';

/** The selection the shared selector applied to one occurrence, defaults included. */
export interface CompiledSelection {
  /** A pinned revision, or null for "newest qualifying". */
  rev: number | null;
  approved: boolean;
  signed: boolean;
}

/** One node the compile read, in expansion order. Occurrence 0 is the root source. */
export interface CompiledOccurrence {
  order: number;
  /** 0 for the root source; an include is one deeper than its includer (R75). */
  depth: number;
  /** The includer's `order`; null for the root source. */
  parent: number | null;
  kind: 'source' | 'include' | 'replacement';
  nodeId: string;
  revNo: number;
  /** SHA-256 hex of the text selected at `revNo`. */
  hash: string;
  /** For a replacement: the node it replaced at that address. */
  replacesNodeId?: string;
  /** The includer's readable tag position (1-based), never the target's identity. */
  position?: { line: number; column: number };
  selection: CompiledSelection;
}

export interface CompiledProvenance {
  version: 1;
  occurrences: CompiledOccurrence[];
}

export type CompiledTarget =
  | { kind: 'AGENT'; agentId: string }
  | { kind: 'APP_AGENT'; agentId: string; appId: string }
  | { kind: 'WORKER'; agentId: string; appId: string; workerId: string };

export class CompiledRevisionIntegrityError extends Error {
  constructor(readonly nodeId: string, readonly revNo: number, reason: string) {
    super(`Compiled revision ${revNo} of ${nodeId} has no valid provenance: ${reason}`);
    this.name = 'CompiledRevisionIntegrityError';
  }
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const HASH = /^[0-9a-f]{64}$/;
const isInt = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;

/** Validate a stored provenance object; anything else is an integrity failure. */
export function parseCompiledProvenance(raw: unknown, nodeId: string, revNo: number): CompiledProvenance {
  const fail = (reason: string): never => { throw new CompiledRevisionIntegrityError(nodeId, revNo, reason); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('not an object');
  const p = raw as { version?: unknown; occurrences?: unknown };
  if (p.version !== 1) return fail('unknown version');
  if (!Array.isArray(p.occurrences) || p.occurrences.length === 0) return fail('no occurrences');
  p.occurrences.forEach((o: unknown, i) => {
    const x = o as Partial<CompiledOccurrence> | null;
    if (!x || typeof x !== 'object') return fail(`occurrence ${i} malformed`);
    if (x.order !== i) return fail(`occurrence ${i} out of order`);
    if (!isInt(x.depth, 0) || !isInt(x.revNo, 1) || typeof x.nodeId !== 'string' || !HASH.test(String(x.hash))) {
      return fail(`occurrence ${i} malformed`);
    }
    const root = i === 0;
    if (root !== (x.kind === 'source') || root !== (x.parent === null) || root !== (x.depth === 0)) {
      return fail(`occurrence ${i} misplaced`);
    }
    if (!root && !(isInt(x.parent, 0) && (x.parent as number) < i)) return fail(`occurrence ${i} has no includer`);
    if (x.kind !== 'source' && x.kind !== 'include' && x.kind !== 'replacement') return fail(`occurrence ${i} kind`);
    const s = x.selection;
    if (!s || typeof s.approved !== 'boolean' || typeof s.signed !== 'boolean' || !(s.rev === null || isInt(s.rev, 1))) {
      return fail(`occurrence ${i} selection`);
    }
  });
  return raw as CompiledProvenance;
}

export interface CompiledRevision {
  nodeId: string;
  revNo: number;
  /** The stored compiled text at `revNo`, or null when that revision has been pruned. */
  content: string | null;
  pruned: boolean;
  /** The hash recorded at compile time; compare with sha256Hex(content) to detect drift. */
  contentHash: string;
  target: CompiledTarget;
  provenance: CompiledProvenance;
  occurrenceCount: number;
  compiledBy: string | null;
  compiledAt: Date;
}

type Reader = Pick<PrismaClient, 'node' | 'nodeRevision' | 'compiledPromptRevision'> | Prisma.TransactionClient;

/**
 * One compiled revision with its own provenance. `null` when the node has no
 * such revision at all (missing node, or `revNo` past its current revision).
 * Throws {@link CompiledRevisionIntegrityError} when the revision exists but its
 * provenance row is missing or malformed: never answered from a newer compile.
 *
 * The current revision is read from the node itself (it need not have a history
 * row yet); an older one from its history row; an older one with no history row
 * is reported as pruned, with its recorded provenance intact.
 */
export async function readCompiledRevision(db: Reader, nodeId: string, revNo: number): Promise<CompiledRevision | null> {
  if (!isInt(revNo, 1)) return null;
  const node = await db.node.findUnique({ where: { id: nodeId }, select: { revSeq: true, content: true } });
  if (!node || revNo > node.revSeq) return null;
  const row = await db.compiledPromptRevision.findUnique({
    where: { compiledNodeId_compiledRevNo: { compiledNodeId: nodeId, compiledRevNo: revNo } },
  });
  if (!row) throw new CompiledRevisionIntegrityError(nodeId, revNo, 'missing');
  const provenance = parseCompiledProvenance(row.provenance, nodeId, revNo);
  let content: string | null;
  if (revNo === node.revSeq) {
    content = node.content ?? '';
  } else {
    const history = await db.nodeRevision.findFirst({
      where: { nodeId, revNo },
      orderBy: { id: 'desc' },
      select: { content: true },
    });
    content = history ? history.content ?? '' : null;
  }
  const target: CompiledTarget = row.targetKind === 'AGENT'
    ? { kind: 'AGENT', agentId: row.targetAgentId }
    : row.targetKind === 'APP_AGENT'
      ? { kind: 'APP_AGENT', agentId: row.targetAgentId, appId: row.targetAppId! }
      : { kind: 'WORKER', agentId: row.targetAgentId, appId: row.targetAppId!, workerId: row.targetWorkerId! };
  return {
    nodeId,
    revNo,
    content,
    pruned: content === null,
    contentHash: row.contentHash,
    target,
    provenance,
    occurrenceCount: row.occurrenceCount,
    compiledBy: row.compiledBy,
    compiledAt: row.createdAt,
  };
}
