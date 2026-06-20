import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

/**
 * The node fields the git frontmatter exporter serializes. Structurally
 * satisfied by both a Prisma `Node` (the bulk `pushMemoryToGit` path) and the
 * hand-built `NodeForGit` (the incremental `writeNodeToGit` path) — sharing one
 * builder is what keeps those two paths from drifting on what lands on disk.
 *
 * They HAD drifted: the bulk path dropped `abstract` / `abstractOriginHash`
 * while the incremental path dropped `seq`, and neither wrote `contentHash`,
 * `type`, `data`, or `properties`. The dropped importer-consumed fields
 * (`abstract`, `abstractOriginHash`, `contentHash`, `type`) were the dangerous
 * ones — see `buildNodeFrontmatter`.
 */
export interface FrontmatterNodeFields {
  id: string;
  name: string;
  nodeType?: string | null;
  alias?: string | null;
  description?: string | null;
  abstract?: string | null;
  abstractOriginHash?: string | null;
  contentHash?: string | null;
  tags: string[];
  seq?: number | null;
  data?: unknown;
  properties?: unknown;
}

/**
 * An outgoing edge as needed for the inline `nodes:` frontmatter — the target
 * node (id + loc), the relationship name, and the gating state. Both export
 * paths fetch `outgoingEdges` with the full target node included (and all the
 * edge's scalar columns), so `loc`, `condition`, and `priority` are available
 * at runtime.
 */
export interface EdgeForGit {
  target: { id: string; loc?: string | null };
  /** Relationship name (was `label`); emitted on the `rel` key for back-compat. */
  name: string | null;
  /** Edge description (spec 037); emitted only when set. */
  description?: string | null;
  /** Whether the edge is runnable (spec 037); emitted only when set. */
  isRunnable?: boolean | null;
  /** JSONLogic gating expression; null/undefined when the edge always fires.
   *  Emitted only when set, so an always-fires edge stays uncluttered. */
  condition?: unknown;
  /** Resolution-order hook (lower fires first), DB default 0. Emitted only
   *  when non-zero (omit-on-default), matching the importer's read-back. */
  priority?: number | null;
}

/**
 * Build the YAML-frontmatter object for a node's exported markdown file.
 *
 * Single source of truth shared by both git export paths so they can never
 * diverge on which fields are written.
 *
 * **Round-trip invariant — the load-bearing rule.** Every field the importer
 * (`loadNodeFromFs` → `syncGraphFromGithub`) reads back MUST be emitted here
 * when set: `abstract`, `abstractOriginHash`, `contentHash`, and `type`
 * (consumed as `isLink: type === 'link'`). The importer upserts each as
 * `field ?? null`, so a field missing from the exported frontmatter is
 * actively NULLED on the next sync — i.e. omitting `abstract` here silently
 * wipes every abstract on re-import. That regression is exactly what this
 * builder closes.
 *
 * `seq`, `data`, and `properties` are not consumed by the importer today
 * (they're preserved untouched on re-import of an existing node), but they're
 * real node state, so they're emitted for a faithful, reviewable mirror.
 *
 * Outgoing edges are emitted inline as the `nodes:` array (see
 * `buildEdgeFrontmatter`) rather than in a separate `.<seg>/edges.yaml`
 * sidecar, so a node is one self-contained file. The importer reads `nodes:`
 * directly (`loadNodeFromFs`), so this round-trips. `nodes:` is importer-
 * consumed but is naturally omitted when empty (no edges → no key), which the
 * importer reads as "no edges" — correct.
 *
 * Omit-on-default convention (matches the rest of the codebase): nullish /
 * empty values are left out so absent-in-YAML == default-in-DB. `type` is
 * omitted for the default `info` so the common case stays uncluttered (absent
 * == info, which is also how the importer reads it).
 */
export function buildNodeFrontmatter(
  node: FrontmatterNodeFields,
  outgoingEdges: EdgeForGit[] = [],
): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = { name: node.name, id: node.id };
  if (node.alias) frontmatter.alias = node.alias;
  if (node.nodeType && node.nodeType !== 'info') frontmatter.type = node.nodeType;
  if (node.description) frontmatter.description = node.description;
  // Importer-consumed → must round-trip or a re-import nulls them.
  if (node.abstract) frontmatter.abstract = node.abstract;
  if (node.abstractOriginHash != null) frontmatter.abstractOriginHash = node.abstractOriginHash;
  if (node.contentHash) frontmatter.contentHash = node.contentHash;
  if (node.tags.length > 0) frontmatter.tags = node.tags;
  if (node.seq != null) frontmatter.seq = node.seq;
  // Node-level JSON — not importer-consumed yet, but part of a faithful mirror.
  if (node.data != null) frontmatter.data = node.data;
  if (node.properties != null) frontmatter.properties = node.properties;
  // Edges last, so the human-readable header (name/description/abstract) stays
  // on top. Omitted entirely when there are none.
  if (outgoingEdges.length > 0) frontmatter.nodes = buildEdgeFrontmatter(outgoingEdges);
  return frontmatter;
}

/**
 * Build the inline `nodes:` edge array for a node's frontmatter. Emits
 * `{ id, loc?, rel }`: the importer keys off `id` (`e.id ?? e.target`) and
 * reads `rel` into the edge name; `loc` (the target's human-readable citation)
 * is carried purely for readability and is the key the frontmatter `nodes:`
 * shape declares (`NodeYaml.nodes`). A null name renders as an empty `rel`.
 *
 * Supersedes the old `.<seg>/edges.yaml` sidecar (which emitted `target`
 * instead of `loc`) — edges now live inline in the node's own `.md`.
 *
 * `condition` (JSONLogic gating) and `priority` (resolution order) are emitted
 * for a faithful mirror so a conditional/ordered edge round-trips through the
 * repo — the importer reads both back (`normalizeEdgeEntry`). They follow the
 * omit-on-default convention: `condition` only when non-null, `priority` only
 * when non-zero (the DB default).
 *
 * Defensive: `target` is a required FK, so a loaded edge always has one — but
 * an edge with a missing target can't be serialized (no id to write), so it's
 * skipped rather than allowed to throw and abort the whole sync/push.
 */
export function buildEdgeFrontmatter(outgoingEdges: EdgeForGit[]): Array<Record<string, unknown>> {
  return outgoingEdges
    .filter((e) => e && e.target)
    .map((e) => {
      const entry: Record<string, unknown> = { id: e.target.id };
      if (e.target.loc) entry.loc = e.target.loc;
      entry.rel = e.name ?? '';
      if (e.description) entry.description = e.description;
      if (e.isRunnable != null) entry.isRunnable = e.isRunnable;
      if (e.condition != null) entry.condition = e.condition;
      if (typeof e.priority === 'number' && e.priority !== 0) entry.priority = e.priority;
      return entry;
    });
}

/**
 * Split a loc into safe path segments. A loc maps directly onto filesystem
 * paths that feed `writeFileSync`, `mkdirSync`, and — critically —
 * `rmSync(recursive)`, so a malformed loc is a real hazard: an empty segment
 * (from `a::b` or a trailing `:`) collapses `'.' + last` to `'.'` and would
 * make the sidecar path resolve to a *parent* directory (a `:` loc resolves to
 * the repo root), turning cleanup into a catastrophic recursive delete; a `..`
 * segment escapes `localPath` entirely on write.
 *
 * Valid locs (URN grammar) never contain empty / `.` / `..` segments, so this
 * is defense-in-depth: throw loudly rather than silently write or delete the
 * wrong path. Shared by `nodeFilePath` and `orphanedLegacyPaths` so both reject
 * the same inputs consistently.
 */
function locToSegments(loc: string): string[] {
  const parts = loc.split(':');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') {
      throw new Error(
        `Unsafe loc "${loc}": empty, '.', or '..' path segments are not allowed`,
      );
    }
  }
  return parts;
}

/**
 * On-disk path for a node's markdown file. Parents and leaves use the
 * identical rule — a node with children is written as `<seg>.md` *beside* its
 * `<seg>/` folder (no `README.md`), so a node's path never changes when it
 * gains or loses children (no git-rename churn). Children land in the sibling
 * folder naturally because they write their own `<seg>/<childSeg>.md`. The
 * empty-loc root node maps to the repo-root `README.md`.
 *
 *   srv:msg:010:02     → <root>/srv/msg/010/02.md
 *   srv:msg:010:02:04  → <root>/srv/msg/010/02/04.md   (child lands in 02/)
 *   ''                 → <root>/README.md
 *
 * Throws on a malformed loc (empty / `.` / `..` segment) — see `locToSegments`.
 */
export function nodeFilePath(localPath: string, loc: string): string {
  if (loc === '') return join(localPath, 'README.md');
  return join(localPath, ...locToSegments(loc)) + '.md';
}

/**
 * The legacy on-disk locations a node may still occupy from the old export
 * format, to be removed when re-exporting in the new layout:
 *   - the old parent file `<...loc>/README.md`
 *   - the old edge sidecar dir `<parent>/.<lastSeg>/`
 *
 * Removing the sidecar is mandatory, not cosmetic: the importer gives a
 * sidecar `edges.yaml` *precedence* over frontmatter `nodes:`
 * (`loadNodeFromFs`), so a leftover sidecar would mask freshly-exported
 * edges. Callers pass only non-empty locs (the empty-loc root is handled
 * separately and must never be treated as orphaned).
 *
 * Throws on a malformed loc — `locToSegments` guards the `rmSync(recursive)`
 * the caller runs on `sidecar`, which would otherwise delete a parent dir.
 */
export function orphanedLegacyPaths(
  localPath: string,
  loc: string,
): { readme: string; sidecar: string } {
  const parts = locToSegments(loc);
  const last = parts[parts.length - 1];
  return {
    readme: join(localPath, ...parts, 'README.md'),
    sidecar: join(localPath, ...parts.slice(0, -1), '.' + last),
  };
}

/**
 * Carry over frontmatter keys the exporter doesn't manage (`urn`, `author`)
 * from an existing on-disk file, so rewriting a node doesn't drop fields a
 * human or another tool added. No-op when the file doesn't exist yet.
 */
export function preserveUnmanagedFrontmatter(
  frontmatter: Record<string, unknown>,
  mdPath: string,
): void {
  if (!existsSync(mdPath)) return;
  try {
    const existing = readFileSync(mdPath, 'utf-8');
    // Tolerate CRLF (Windows / git core.autocrlf) as well as LF.
    const fmMatch = existing.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return;
    // parse() yields null for empty frontmatter and a scalar/array for
    // malformed YAML; only a plain object is safe to index.
    const existingMeta = parse(fmMatch[1]);
    if (existingMeta && typeof existingMeta === 'object') {
      for (const key of ['urn', 'author']) {
        const val = (existingMeta as Record<string, unknown>)[key];
        if (val != null && frontmatter[key] == null) {
          frontmatter[key] = val;
        }
      }
    }
  } catch {
    // Malformed existing frontmatter — nothing to preserve.
  }
}
