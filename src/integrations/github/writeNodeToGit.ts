import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { dirname } from 'path';
import { stringify } from 'yaml';
import { withMirrorCheckout } from './gitMirrorCheckout.js';
import {
  buildNodeFrontmatter,
  preserveUnmanagedFrontmatter,
  nodeFilePath,
  orphanedLegacyPaths,
  readNodeFileId,
} from './nodeFrontmatter.js';

export interface NodeForGit {
  id: string;
  loc: string;
  name: string;
  /** Node type (info/data/task/record/…). Exported as `type` for non-`info`;
   *  the importer reads it back as `isLink: type === 'link'`, so it must
   *  round-trip. */
  nodeType?: string | null;
  /** #725 — collection discriminator; round-tripped via frontmatter `objectType`. */
  objectType?: string | null;
  alias?: string | null;
  description?: string | null;
  /** Paragraph-length summary. Spec 031. Written to YAML frontmatter as `abstract`. */
  abstract?: string | null;
  /** Spec 032 — fingerprint exported alongside `abstract` so the
   *  round-trip preserves the staleness signal byte-for-byte. Omitted
   *  from YAML frontmatter when null (consistent with `abstract`). */
  abstractOriginHash?: string | null;
  /** SHA256(yaml+md)[0:8] change-detection hash. Importer-consumed, so it
   *  must be exported or a re-sync nulls it. */
  contentHash?: string | null;
  content?: string | null;
  tags: string[];
  /** Sort order among siblings; exported for a faithful mirror. */
  seq?: number | null;
  /** Node-level structured JSON; exported for a faithful mirror. */
  data?: unknown;
  properties?: unknown;
  /**
   * #1218 — the governed signals. REQUIRED, not optional, and that is the
   * mechanism rather than a style choice (@copilot, @codex P1 on PR #1221):
   * optional properties let a producer omit them silently, which is exactly
   * how the incremental mirror path kept emitting ungoverned files while the
   * bulk path was wired. Required means a new `NodeForGit` producer fails to
   * COMPILE until it decides, which is the opt-out-not-opt-in rule this change
   * is about, enforced by the one thing that cannot forget.
   */
  role: string | null;
  isRunnable: boolean | null;
  outgoingEdges: Array<{
    target: { id: string; loc?: string | null };
    name: string | null;
    /** The edge's own loc (spec 037), emitted as `edgeLoc`. A scalar column on
     *  the Prisma edge row, so it's returned by default wherever the edge is
     *  loaded — no explicit select needed on either git path. */
    loc?: string | null;
    description?: string | null;
    data?: unknown;
    isRunnable?: boolean | null;
    /** JSONLogic gating expression; null when the edge always fires. */
    condition?: unknown;
    /** Resolution-order hook (lower fires first), DB default 0. */
    priority?: number | null;
  }>;
}

/**
 * Reshape a checkout's working tree so `node`'s file reflects the DB row.
 *
 * Writes one self-contained frontmatter markdown file per node (props + edges
 * inline; no README, no edge sidecar) via the shared `nodeFrontmatter` builders,
 * and clears the legacy paths the node may still occupy from the old export
 * format. Pure filesystem work — no git, no commit — so a caller that reshapes
 * SEVERAL nodes (the move mirror) can batch them into one commit.
 */
export function writeNodeFile(localPath: string, node: NodeForGit): void {
  // A node — leaf or parent — is one self-contained `<...loc>.md` (children
  // live in the sibling `<seg>/` folder); edges are inline in the frontmatter
  // `nodes:` array, no sidecar.
  const mdPath = nodeFilePath(localPath, node.loc);

  // Build frontmatter (shared builder — keeps this incremental path and the
  // bulk pushMemoryToGit path emitting the exact same fields, edges included).
  // Every importer-consumed field (abstract, abstractOriginHash, contentHash,
  // type, nodes) is emitted when set, or a re-sync would null it; see
  // nodeFrontmatter.ts.
  const frontmatter = buildNodeFrontmatter({
    id: node.id,
    name: node.name,
    nodeType: node.nodeType,
    objectType: node.objectType,
    alias: node.alias,
    description: node.description,
    abstract: node.abstract,
    abstractOriginHash: node.abstractOriginHash,
    contentHash: node.contentHash,
    tags: node.tags,
    seq: node.seq,
    data: node.data,
    properties: node.properties,
    // #1218 — the incremental mirror path emits them too. Wiring only
    // `pushMemoryToGit` left ordinary writes and moves producing files with no
    // governed signals, so a memory restored from that repo lost governance
    // through the path it is written by most often.
    role: node.role,
    isRunnable: node.isRunnable,
  }, node.outgoingEdges);
  preserveUnmanagedFrontmatter(frontmatter, mdPath);

  const fmYaml = stringify(frontmatter, { lineWidth: 0 }).trim();
  const body = node.content ?? '';
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, `---\n${fmYaml}\n---\n\n${body}\n`, 'utf-8');

  // Remove any leftover old-format files for this node (parent `README.md` +
  // edge sidecar dir) so a migrating repo reshapes cleanly and a stale sidecar
  // can't mask the inline edges on re-import. `git add -A` stages the
  // deletions. Skipped for the empty-loc root, whose file IS README.md.
  if (node.loc !== '') {
    const legacy = orphanedLegacyPaths(localPath, node.loc);
    rmSync(legacy.readme, { force: true });
    rmSync(legacy.sidecar, { recursive: true, force: true });
  }
}

/**
 * Remove the files node `expectedNodeId` occupies at `loc` — the current
 * `<...loc>.md` and the legacy `<...loc>/README.md` — from a checkout's working
 * tree, plus the edge sidecar if either was actually removed. Returns whether
 * anything went.
 *
 * The counterpart of {@link writeNodeFile}, for the address a node has LEFT
 * (#1095): without it a moved node's stale file stays in the repo, and the next
 * repo-wins sync re-mints it as a duplicate of a node that now lives elsewhere.
 *
 * **A file is removed only if its frontmatter names `expectedNodeId`.** The move
 * mirror is fire-and-forget, so by the time it runs, the vacated loc may already
 * be occupied by a DIFFERENT node whose own mirror wrote that exact path — and
 * deleting THAT would erase a live node from the repo and let the next
 * repo-wins sync act on the absence (PR #1098 review, Codex P1). A file with a
 * different id, no id, or unreadable frontmatter is left alone: leaving a stale
 * file costs a duplicate node on the next sync, which is recoverable; deleting
 * a live one is not.
 *
 * The node's own child DIRECTORY is deliberately never removed — a descendant
 * that did not move still lives there.
 *
 * `loc` is never the empty-loc root here: a memory's root node cannot be moved.
 */
export function removeNodeFile(localPath: string, loc: string, expectedNodeId: string): boolean {
  if (loc === '') return false;
  const legacy = orphanedLegacyPaths(localPath, loc);
  let removed = false;
  for (const path of [nodeFilePath(localPath, loc), legacy.readme]) {
    if (readNodeFileId(path) !== expectedNodeId) continue;
    rmSync(path, { force: true });
    removed = true;
  }
  // The sidecar belongs to whichever file we just took; it stays if we took none.
  if (removed) rmSync(legacy.sidecar, { recursive: true, force: true });
  return removed;
}

/**
 * Write a node to the appropriate git repo and branch, then push.
 * Fire-and-forget safe — errors are logged, not thrown.
 */
export async function writeNodeToGit(
  node: NodeForGit,
  ownerRepo: string,
  clientId?: string | null,
  memoryId?: string,
): Promise<void> {
  await withMirrorCheckout(
    {
      memoryId,
      ownerRepo,
      clientId,
      commitSubject: `Update node ${node.loc}`,
      logPrefix: '[writeNodeToGit]',
    },
    ({ localPath }) => writeNodeFile(localPath, node),
  );
}
