import { InvalidRootMemoryError, rootLocForMemory } from '../localFs/loadNodeFromFs.js';
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
  objectType?: string | null;
  alias?: string | null;
  description?: string | null;
  abstract?: string | null;
  abstractOriginHash?: string | null;
  contentHash?: string | null;
  tags: string[];
  seq?: number | null;
  data?: unknown;
  properties?: unknown;
  /**
   * #1218 — the governed signals (`governedSignals.ts`). Emitted ONLY when set,
   * like every other optional key here, which is what keeps this change off
   * every existing mirrored file: today exactly one live node carries a role,
   * so nothing else re-exports with a new key and no memory sees a mass diff.
   * `runnable` matches the key the edge codec already uses.
   */
  role?: string | null;
  isRunnable?: boolean | null;
  /** Server-set reserved-citation state; false is the ordinary-node default. */
  isPlaceholder?: boolean;
}

/**
 * An outgoing edge as needed for the inline `nodes:` frontmatter — the target
 * node (id + loc), the relationship name, and the gating state. Both export
 * paths fetch `outgoingEdges` with the full target node included (and all the
 * edge's scalar columns), so `loc`, `condition`, and `priority` are available
 * at runtime.
 */
export interface EdgeForGit {
  /** `INCLUDE` marks an edge derived from an include tag (#2040); it is never mirrored (the tag in the content is the source). */
  governedKind?: string | null;
  target: { id: string; loc?: string | null };
  /** Relationship name (was `label`); emitted on the `rel` key for back-compat. */
  name: string | null;
  /** The edge's OWN loc (its identity, spec 037) — emitted as `edgeLoc`, distinct
   *  from `target.loc`. Carried so a standalone export round-trips the edge's
   *  identity; emitted only when set. */
  loc?: string | null;
  /** Edge description (spec 037); an empty string is distinct from null. */
  description?: string | null;
  /** Edge JSON metadata; emitted when non-null so a fresh import can restore it. */
  data?: unknown;
  /** Whether the edge is runnable (spec 037); emitted (as `runnable: true`) only
   *  when true — false is the DB default and is omitted. */
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
 * when set: `abstract`, `abstractOriginHash`, `contentHash`, `type`, and the
 * server-set `placeholder` marker
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
  // #725 — collection discriminator; importer-consumed, so round-trip it.
  if (node.objectType) frontmatter.objectType = node.objectType;
  if (node.description) frontmatter.description = node.description;
  // Importer-consumed → must round-trip or a re-import nulls them.
  if (node.abstract) frontmatter.abstract = node.abstract;
  if (node.abstractOriginHash != null) frontmatter.abstractOriginHash = node.abstractOriginHash;
  if (node.contentHash) frontmatter.contentHash = node.contentHash;
  if (node.tags.length > 0) frontmatter.tags = node.tags;
  if (node.seq != null) frontmatter.seq = node.seq;
  // #1218 — governed signals, importer-consumed, so they must round-trip or a
  // memory rebuilt from its mirror arrives ungoverned (#1205). Emitted when
  // NON-NULL: an absent key means "no opinion" on import and preserves the
  // stored value, which is what makes this safe to ship against mirrors that
  // predate it.
  //
  // NON-NULL, not truthy (@copilot, PR #1221). `Node.isRunnable` is nullable
  // and `false` is observable SEPARATELY from null — `findNodes(isRunnable:
  // false)` matches only explicitly-false rows and deliberately excludes the
  // nulls — so a truthy test rebuilt an explicitly-non-runnable node as null
  // and never updated an existing row to the repo's `false`. **This is where
  // nodes differ from EDGES**, three functions down, which omit `runnable:
  // false` on purpose: an edge's column is not nullable in practice, so false
  // and absent are the same state there and emitting it would only break
  // byte-compatibility with the CLI's export. On a node they are two states.
  //
  // Free to ship: 25 live nodes carry `isRunnable: false` and NONE of them is
  // mirrored (measured), so no file on disk gains a key today.
  if (node.role != null) frontmatter.role = node.role;
  if (node.isRunnable != null) frontmatter.runnable = node.isRunnable;
  // #1477 — only the positive server-owned reservation needs an on-disk key.
  // Older mirrors with no key leave a stored placeholder alone on re-sync.
  if (node.isPlaceholder === true) frontmatter.placeholder = true;
  // Node-level JSON — not importer-consumed yet, but part of a faithful mirror.
  if (node.data != null) frontmatter.data = node.data;
  if (node.properties != null) frontmatter.properties = node.properties;
  // Edges last, so the human-readable header (name/description/abstract) stays
  // on top. Omitted entirely when there are none.
  if (outgoingEdges.length > 0) frontmatter.nodes = buildEdgeFrontmatter(outgoingEdges);
  return frontmatter;
}

/**
 * Build the inline `nodes:` edge array for a node's frontmatter.
 *
 * Field order and keys match the CLI's `nodedoc` edgeEntry (the codec behind
 * `hadron node export` / `hadron node import`) so an exported file is
 * byte-identical to the CLI and the two never drift:
 *
 *   `id, loc, rel, edgeLoc, description, data, runnable, condition, priority`
 *
 * `id` is the target node (the importer keys off `e.id ?? e.target`); `loc` is
 * the target's human-readable citation (readability); `rel` is the edge name
 * (empty string for a null name, never omitted); `edgeLoc` is the edge's OWN
 * loc. The omit-on-default rules are: `loc`/`edgeLoc` when set,
 * `description` when non-null (including `''`), `data` when non-null,
 * `runnable` only when true (false is the DB default), `condition` only when
 * non-null, and `priority` only when non-zero. The CLI's `edgeEntry` needs the
 * corresponding shape for canonical-byte parity (#1479).
 *
 * Historical note: the server previously emitted `isRunnable` and no `edgeLoc`,
 * which silently diverged from the CLI export — this builder is now the single
 * shared shape (the importer reads `runnable` with an `isRunnable` fallback for
 * already-pushed mirrors). Supersedes the old `.<seg>/edges.yaml` sidecar.
 *
 * Defensive: `target` is a required FK, so a loaded edge always has one — but
 * an edge with a missing target can't be serialized (no id to write), so it's
 * skipped rather than allowed to throw and abort the whole sync/push.
 */
export function buildEdgeFrontmatter(outgoingEdges: EdgeForGit[]): Array<Record<string, unknown>> {
  return outgoingEdges
    .filter((e) => e && e.target && e.governedKind !== 'INCLUDE')
    .map((e) => {
      const entry: Record<string, unknown> = { id: e.target.id };
      if (e.target.loc) entry.loc = e.target.loc;
      entry.rel = e.name ?? '';
      if (e.loc) entry.edgeLoc = e.loc;
      if (e.description != null) entry.description = e.description;
      if (e.data != null) entry.data = e.data;
      // `runnable` only when true (CLI omit-when-false). For an EDGE, false and
      // null are the same "not runnable" state — nothing distinguishes them (only
      // Node.isRunnable filtering treats false specially), and the CLI's edge
      // model has no null. So an explicit-false edge collapsing to null on a sync
      // round-trip is inert; emitting `runnable: false` would instead break the
      // byte-for-byte parity with `hadron node export` that this builder exists for.
      if (e.isRunnable) entry.runnable = true;
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
 * segment or a segment containing a slash/backslash can escape `localPath` on write.
 *
 * Valid non-root locs never contain empty / `.` / `..` or slash/backslash-bearing segments, so this
 * is defense-in-depth: throw loudly rather than silently write or delete the
 * wrong path. Shared by `nodeFilePath` and `orphanedLegacyPaths` so both reject
 * the same inputs consistently.
 */
function locToSegments(loc: string): string[] {
  const parts = loc.split(':');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || /[/\\]/.test(p)) {
      throw new Error(
        `Unsafe loc "${loc}": empty, '.', '..', or path-separator segments are not allowed`,
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
 * Throws on a malformed loc (empty / `.` / `..` or path-separator segment) — see `locToSegments`.
 */
export function nodeFilePath(localPath: string, loc: string, memoryUrn?: string): string {
  // Compound legacy memories can still export ordinary non-root nodes;
  // only a valid single slug identifies a root README (#1228).
  let rootLoc: string | undefined;
  if (memoryUrn) {
    try { rootLoc = rootLocForMemory(memoryUrn); } catch (err) {
      if (!(err instanceof InvalidRootMemoryError)) throw err;
    }
  }
  if (loc === '' || loc === rootLoc) {
    const hadronRoot = join(localPath, '.hadron', 'README.md');
    return existsSync(hadronRoot) ? hadronRoot : join(localPath, 'README.md');
  }
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
 * The node id recorded in an on-disk file's frontmatter, or null when the file
 * is absent, carries no frontmatter, or carries no `id`.
 *
 * This is the mirror's answer to "whose file is this?" — the question that has
 * to be asked before DELETING a path (#1095). A move mirror runs after its
 * transaction commits, so by the time it removes the loc a node vacated, some
 * other node may already have been created there and mirrored its own file to
 * that exact path. Removing it blind would erase a live node from the repo and
 * let the next repo-wins sync act on the absence. A null answer is deliberately
 * NOT treated as a match: an id-less file was written by a human or another
 * tool, and is not the mirror's to delete either.
 */
export function readNodeFileId(mdPath: string): string | null {
  if (!existsSync(mdPath)) return null;
  try {
    const existing = readFileSync(mdPath, 'utf-8');
    // Tolerate CRLF (Windows / git core.autocrlf) as well as LF.
    const fmMatch = existing.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;
    const meta = parse(fmMatch[1]);
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const id = (meta as Record<string, unknown>).id;
      return typeof id === 'string' ? id : null;
    }
  } catch {
    // Malformed frontmatter — we cannot claim the file, so we don't.
  }
  return null;
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
