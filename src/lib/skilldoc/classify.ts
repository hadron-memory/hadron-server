/**
 * #1177 §5 — the drift classes, the server's vocabulary (A4).
 *
 * `Classify` answers one question per declared node: *what is the relationship
 * between this node and the file on disk?* The client sends what it can see of
 * the file; the server names the class; the client acts on it.
 *
 * **New code, not a port.** There is no Go implementation to agree with — §7
 * step 3 puts this on the server first, deliberately, because the class
 * VOCABULARY is the thing that must not drift. A client that could name a
 * class could invent a tenth, and the surface that can express a thing is what
 * decides whether the thing stays countable (A4, and the same argument that
 * made kind-specific doors right over one generic door).
 *
 * ## The classes are about the NODE→FILE relationship, not about quality
 *
 * Lint says whether a node is exportable. This says whether the file agrees
 * with it. They are independent and both travel on the seam together, because
 * a node failing lint must never be exported (§5.1 step 2) — a client holding
 * a class without findings would render a file the server already judged
 * broken.
 *
 * ## A parse failure is NOT a class (@Holger, 2026-09-20)
 *
 * > "During the export a failure is reported. Occam's Razor."
 *
 * A file that exists and does not parse gets no class at all. The node is
 * still declared; it is the FILE that cannot be read, and the two commands
 * report that identically — `status` shows the declared node's row with the
 * file in a failure state, `export` refuses that file and says why. "Keep both
 * consistent" is a constraint on the implementation rather than a restatement:
 * ONE predicate decides it and both commands render from that single answer,
 * which is exactly the protection the class vocabulary gives everything else.
 */
import type { Declaration } from './declaration.js';

/**
 * The ten classes. Nine from §5 plus `disabled` (D12).
 *
 * Ordered as the union is written so a reader meets them in the order the
 * table in §5 does; the ORDER OF PRECEDENCE is separate and lives in
 * `classifySkill`, because several can be true of one node at once.
 */
export type DriftClass =
  | 'current'
  | 'stale'
  | 'locally-edited'
  | 'renamed'
  | 'never-exported'
  | 'orphaned'
  | 'unhashed'
  | 'collision'
  | 'unavailable'
  | 'disabled';

/** What the client can see of a file on disk, per §3's seam. */
export interface FileFacts {
  /** The directory the skill occupies — compared against the stored name. */
  dirName: string;
  /** The `hash=` value from the provenance header; '' when the header carries none. */
  headerHash: string;
  /** The hash the client computed over the file's own contents. */
  fileHash: string;
  /** The `id=` value from the header; '' on a generation that predates §4a. */
  headerId?: string;
  /** The `source=` URN from the header. */
  headerSource?: string;
  /** True when the file exists and could not be parsed — see the header. */
  parseFailed?: boolean;
  /** Frontmatter keys `render` never writes; their presence IS a hand edit. */
  hasExtraFrontmatter?: boolean;
}

/** What the server knows about the declared node. */
export interface NodeFacts {
  /** The node's stable id. */
  id: string;
  /** The node's canonical URN. */
  urn: string;
  /** The declaration, or null when the node no longer declares an export. */
  declaration: Declaration | null;
  /** The hash of the node as it would be rendered. */
  nodeHash: string;
  /** True when the node was listed but could not be read (§5's `unavailable`). */
  unavailable?: boolean;
  /** True when another declared node stores the same skill name. */
  collides?: boolean;
}

/** One node's verdict. */
export interface Classification {
  urn: string;
  /** Absent when the file could not be parsed — a failure is not a class. */
  class?: DriftClass;
  /**
   * Set when the file exists and does not parse. Both `status` and `export`
   * render from THIS field rather than each deciding separately, which is what
   * "keep both consistent" requires.
   */
  parseFailure?: true;
  /** For `renamed`: the directory the file currently occupies. */
  movedFrom?: string;
}

/**
 * Classify one declared node against the file the client found for it.
 *
 * `file` is null when the client found no file at all.
 *
 * ## Precedence, and why it is this order
 *
 * 1. **`unavailable`** — the node could not be read, so nothing below it is
 *    knowable. A client that guessed a class here would under-report the
 *    corpus, which is the defect the class exists to prevent.
 * 2. **a parse failure** — not a class; see the module header.
 * 3. **`locally-edited`** — OUTRANKS `disabled` (@codex on cli#627). A
 *    disabled declaration whose file was hand-edited must still be refused
 *    without `--force`: `enable` lives on a SHARED node, so whoever switches
 *    it off is often not whoever made the local edit, and destroying their
 *    work on someone else's toggle is precisely the outcome A1 was ruled to
 *    prevent.
 * 4. **`disabled`** — about the DECLARATION, so it applies whether or not a
 *    file exists (§5.2: the class is about the declaration, the action is
 *    about the file).
 * 5. **`collision`** — two nodes claiming one directory cannot both be right,
 *    so neither is written.
 * 6. the file-relationship classes.
 */
export function classifySkill(node: NodeFacts, file: FileFacts | null): Classification {
  const urn = node.urn;

  if (node.unavailable) return { urn, class: 'unavailable' };
  if (file?.parseFailed) return { urn, parseFailure: true };

  const declared = node.declaration !== null;
  const enabled = node.declaration?.enable === true;

  // A file whose contents no longer match its own header is hand-edited,
  // whatever else is true of it. `hasExtraFrontmatter` is the half the hash
  // cannot see: `render` writes exactly two frontmatter keys, so a third is an
  // edit the header hash has no way to notice.
  const locallyEdited =
    file !== null &&
    file.headerHash !== '' &&
    (file.fileHash !== file.headerHash || file.hasExtraFrontmatter === true);
  if (locallyEdited) return { urn, class: 'locally-edited' };

  if (declared && !enabled) return { urn, class: 'disabled' };
  if (node.collides) return { urn, class: 'collision' };

  if (file === null) return { urn, class: 'never-exported' };

  // A header with a source and no hash is the pre-#580 generation. This class
  // describes only the hash relationship; the export planner separately uses
  // the id's absence to require an explicit override before rewrite or move.
  if (file.headerHash === '') return { urn, class: 'unhashed' };

  const storedName = node.declaration?.name ?? '';
  if (storedName !== '' && file.dirName !== storedName) {
    return { urn, class: 'renamed', movedFrom: file.dirName };
  }

  if (node.nodeHash !== file.headerHash) return { urn, class: 'stale' };
  return { urn, class: 'current' };
}

/**
 * A file the client found that pairs with no declared node.
 *
 * Kept separate from `classifySkill` because it is not a question ABOUT a
 * node — there is no node. `orphaned` is never removed without `--prune`,
 * because an orphan is usually a node that MOVED: measured on the live corpus,
 * 19 of 20 provenance URNs resolve and the one that does not is a node moved
 * between memories after its export.
 *
 * Pairing is by **id first** (§4a), falling back to the URN for a header
 * generation that predates the id. #1235 shipped the write side and the hash
 * change it required, so files gain the key as installations re-export; until
 * `hadron skill export` ships (hadron-cli#621) the fallback is still what
 * every file takes. That fallback is what makes a `loc` rename
 * read as `renamed` rather than as an orphan plus a fresh export — two
 * directories carrying near-identical trigger text, both firing.
 */
export function pairFileToNode(
  file: FileFacts,
  declaredNodes: readonly NodeFacts[],
): NodeFacts | null {
  const byId = file.headerId ?? '';
  if (byId !== '') {
    const hit = declaredNodes.find((n) => n.id === byId);
    if (hit) return hit;
    // An id that names nothing is NOT a reason to fall back to the URN: the id
    // is the stronger key, and a file whose id no longer resolves is an orphan
    // even if some other node happens to sit at its old URN. Falling back
    // would pair a file with a node that merely reused an address.
    return null;
  }
  const bySource = file.headerSource ?? '';
  if (bySource === '') return null;
  return declaredNodes.find((n) => n.urn === bySource) ?? null;
}
