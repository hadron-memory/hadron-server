import { existsSync, readFileSync } from 'fs';
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
 * An outgoing edge as needed for the sidecar — the target node (id + loc) and
 * the relationship label. Both export paths fetch `outgoingEdges` with the full
 * target node included, so `loc` is available at runtime.
 */
export interface EdgeForGit {
  target: { id: string; loc?: string | null };
  label: string | null;
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
 * Omit-on-default convention (matches the rest of the codebase): nullish /
 * empty values are left out so absent-in-YAML == default-in-DB. `type` is
 * omitted for the default `info` so the common case stays uncluttered (absent
 * == info, which is also how the importer reads it).
 */
export function buildNodeFrontmatter(node: FrontmatterNodeFields): Record<string, unknown> {
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
  return frontmatter;
}

/**
 * Build the edge-sidecar array (`edges.yaml`). Emits `{ id, target, rel }` with
 * key order matching the historical on-disk shape so a re-push of an unchanged
 * graph produces a minimal diff. `target` (the human-readable loc) is included
 * when known; the importer keys off `id` (`e.id ?? e.target`), so `target` is
 * purely for readability.
 */
export function buildEdgeSidecar(outgoingEdges: EdgeForGit[]): Array<Record<string, unknown>> {
  return outgoingEdges.map((e) => {
    const entry: Record<string, unknown> = { id: e.target.id };
    if (e.target.loc) entry.target = e.target.loc;
    entry.rel = e.label ?? '';
    return entry;
  });
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
    const fmMatch = existing.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return;
    const existingMeta = parse(fmMatch[1]) as Record<string, unknown>;
    for (const key of ['urn', 'author']) {
      if (existingMeta[key] && !frontmatter[key]) {
        frontmatter[key] = existingMeta[key];
      }
    }
  } catch {
    // Malformed existing frontmatter — nothing to preserve.
  }
}
