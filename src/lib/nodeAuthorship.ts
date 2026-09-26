/**
 * #1326 — the system-owned attribution stored with a Node content state.
 *
 * This module only CARRIES an already recorded stamp. Task attestation is
 * verified in #1328, and trusted human attribution is minted in #1336; a
 * generic NodeInput or JSON bag has no path to these columns.
 */
import type { NodeAuthorshipKind } from '../generated/prisma/index.js';

export interface NodeAuthorshipStamp {
  authorshipKind: NodeAuthorshipKind | null;
  authoredByTask: string | null;
  authoredByRevision: number | null;
  authoredByHuman: string | null;
  authoredAt: Date | null;
}

/** Copy historical provenance without claiming that a task ran again. */
export function carryNodeAuthorship(source: NodeAuthorshipStamp): NodeAuthorshipStamp {
  return {
    authorshipKind: source.authorshipKind,
    authoredByTask: source.authoredByTask,
    authoredByRevision: source.authoredByRevision,
    authoredByHuman: source.authoredByHuman,
    authoredAt: source.authoredAt,
  };
}
