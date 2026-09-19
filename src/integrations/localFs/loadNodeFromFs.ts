import { readFileSync, existsSync } from 'fs';
import { governedSignalsFromMirror } from '../../lib/governedSignals.js';
import { join, relative, sep, basename, dirname } from 'path';
import { parse } from 'yaml';
import type { Node } from '../../index.d.js';
import { NodeAbstractTooLongError } from '../../lib/entityRef/errors.js';
import { computeContentHash } from '../../lib/contentHash.js';

interface NodeYaml {
  id: string;
  name: string;
  urn?: string;
  type?: string;
  objectType?: string;
  description?: string;
  /** Paragraph-length summary. Spec 031. Distinct from `description`. */
  abstract?: string;
  /**
   * Spec 032 — fingerprint of `content` at the time `abstract` was
   * authored. Present in YAML round-trip from a hadron-server export;
   * may be absent in YAML authored by hand (importer recomputes from
   * `content` in that case). Defensive: non-string values fall through
   * to recompute.
   */
  abstractOriginHash?: string;
  /**
   * Legacy alias historically read into `description` when no
   * `description` key existed. Predates the spec-031 `abstract` field
   * and remains for back-compat. New writers use `abstract` for paragraph
   * summaries and `description` for one-line headlines.
   */
  summary?: string;
  /**
   * #1218 — the governed signals, round-tripping through the mirror so a
   * memory rebuilt from its repo does not arrive ungoverned (#1205). `runnable`
   * matches the key the edge codec already uses; `isRunnable` is accepted as
   * the legacy spelling for the same reason edges accept it.
   *
   * ABSENCE IS NOT `null` HERE. Every other optional field on this interface is
   * read as `meta.x ?? null`, which is right for them and catastrophic for
   * these two: no file already on disk carries either key, so coercing absent
   * to null would clear the column on the next sync of every mirrored memory —
   * un-governing on a schedule, introduced by the fix for it. They are routed
   * through `governedSignalsFromMirror`, which omits an absent key so the
   * stored value is preserved.
   */
  role?: string | null;
  runnable?: boolean | null;
  isRunnable?: boolean | null;
  tags?: string[];
  nodes?: Array<{ id: string; rel: string; loc?: string }>;
  alias?: string;
  author?: string;
  contentHash?: string;
}

/**
 * Spec 032 FR-013 — reconcile the YAML's `abstractOriginHash` against
 * the hash computed from imported content.
 *
 * Trust model: the YAML producer is in the trust boundary (the importer
 * is a privileged sync surface), so when the YAML carries a hash that
 * disagrees with the recomputed value we accept the YAML value and emit
 * a warning. This preserves round-trip integrity of legitimately-stale
 * exports while surfacing tampering observability in the sync log.
 *
 * Per FR-006 parallel: if there is no abstract, there is no hash —
 * regardless of what the YAML says.
 *
 * Defensive type handling: only a string-shaped YAML value is considered
 * for the round-trip path. Missing key, null, object, number, boolean
 * all fall through to "recompute from content" (same defensive pattern
 * as spec 031's `normalizeImportedAbstract` object-rejection).
 *
 * Deliberate choice — non-string falls through SILENTLY rather than
 * emitting the mismatch-warning. Rationale: a non-string value cannot
 * have come from a hadron-server export (we only ever write string or
 * omit), so the failure mode is "human or third-party YAML producer
 * mis-typed the key" — which is structurally indistinguishable from
 * "key missing" rather than from "tampering with a real hash." Treating
 * both as "no usable hash, fall back to first-time-import semantics"
 * keeps the warning channel focused on the case that actually matters:
 * a producer that supplied a string-shaped hash disagreeing with the
 * computed value (PR-209 review note #4).
 */
function reconcileAbstractOriginHash(
  normalizedAbstract: string | null,
  content: string | null,
  yamlHash: unknown,
  loc: string,
): string | null {
  if (normalizedAbstract === null) {
    return null;
  }
  const computed = computeContentHash(content);
  if (typeof yamlHash !== 'string') {
    return computed;
  }
  if (yamlHash === computed) {
    return yamlHash;
  }
  console.warn(
    `[loadNodeFromFs] abstractOriginHash mismatch for loc=${loc}: ` +
      `YAML claims ${yamlHash}, computed ${computed}. Accepting YAML ` +
      `value (FR-013 round-trip preservation); possible tampering ` +
      `or legitimate exported-stale state.`,
  );
  return yamlHash;
}

/**
 * Length cap + trim-then-check normalization for the imported abstract.
 * Mirrors the resolver + MCP write paths so import → export → re-import
 * is byte-identical for the persisted value.
 *
 * Per FR-008: the 2000-char cap applies at every write surface, including
 * import. Over-cap YAML values throw `NodeAbstractTooLongError`; the sync
 * envelope catches and reports per the existing per-node try/catch in
 * loadGraphFromFs (errors don't poison the whole import — the bad node
 * is skipped with a warning).
 *
 * Per FR-009 (extended PR-196): trim-then-check normalizes empty and
 * whitespace-only values to null; non-empty trimmed values persist
 * untrimmed so intentional surrounding whitespace on real paragraphs is
 * lossless.
 *
 * Defensive type handling: the `yaml` package's `parse` is loose about
 * types. Scalar non-strings (number, boolean) get coerced via `String()`
 * so `.trim()` doesn't blow up. Objects and arrays — which would yield
 * "[object Object]" / "1,2,3" via `String()` and silently persist as the
 * node's abstract — are rejected as `null` instead. PR-201 round-2
 * surfaced the object/array gap.
 */
function normalizeImportedAbstract(raw: unknown): string | null {
  if (raw == null) return null;
  // Objects and arrays would yield "[object Object]" / a comma-joined
  // string via String() — silently persisting garbage. Treat them as
  // "no usable abstract" (same as null/empty). A future spec that
  // formally rejects malformed input with a typed error could wrap
  // this in InvalidAbstractTypeError; today's choice matches the
  // empty-string handling and keeps the bad-input failure mode quiet.
  if (typeof raw === 'object') return null;
  const str = String(raw);
  if (str.length > 2000) {
    throw new NodeAbstractTooLongError(str.length);
  }
  if (str.trim() === '') return null;
  return str;
}

interface EdgeEntry {
  /** Either `target` or `id` identifies the target node. */
  target?: string;
  /** Relationship name. The on-disk key stays `rel` for back-compat (it was
   * never literally "label"); read into `Edge.name`. */
  rel: string;
  id?: string;
  /** Edge description (spec 037). */
  description?: string;
  /** Whether the edge is runnable (spec 037). The CLI export (and the server's
   *  current writer) emit `runnable`; `isRunnable` is the legacy key still on
   *  already-pushed mirrors — `normalizeEdgeEntry` reads `runnable` first. */
  runnable?: boolean;
  isRunnable?: boolean;
  /** The edge's own loc (spec 037), written by the export as `edgeLoc`. Carried
   *  for readability; not consumed on git-import today. */
  edgeLoc?: string;
  /**
   * JSONLogic gating expression. Null/undefined means the edge always
   * fires. The server validates the shape on import (no separate
   * portability check at load time — invalid conditions are rejected
   * when the import path persists them).
   */
  condition?: unknown;
  /** Edge resolution-order hook (lower fires first). Default 0. */
  priority?: number;
  [key: string]: unknown;
}

/**
 * Load a single node from the filesystem.
 *
 * Supports two formats:
 * 1. **Legacy**: directory with `.node/node.yaml` + `.node/topic.md`
 * 2. **Frontmatter**: a single `.md` file with YAML frontmatter + optional `.name/edges.yaml` sidecar
 *
 * @param source    Absolute path to either the directory (legacy) or the .md file (frontmatter)
 * @param graphRoot Absolute path to the graph root (for deriving loc)
 * @param ownerRepo GitHub repo slug, e.g. "micromentor/mmdata"
 */
export interface LoadedEdge {
  targetId: string;
  /** Relationship name (was `label`). */
  name: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
  condition?: unknown;
  priority?: number;
}

export const loadNodeFromFs = async (
  source: string,
  graphRoot: string,
  ownerRepo: string,
): Promise<{ node: Partial<Node>; edges: Array<LoadedEdge> }> => {
  if (source.endsWith('.md')) {
    return loadFrontmatterNode(source, graphRoot, ownerRepo);
  }
  return loadLegacyNode(source, graphRoot, ownerRepo);
};

/**
 * Load a frontmatter markdown node (Obsidian vault format).
 */
async function loadFrontmatterNode(
  mdPath: string,
  graphRoot: string,
  ownerRepo: string,
): Promise<{ node: Partial<Node>; edges: Array<LoadedEdge> }> {
  const raw = readFileSync(mdPath, 'utf-8');

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error(`No frontmatter found in ${mdPath}`);

  const meta = parse(fmMatch[1]) as NodeYaml & { nodes?: EdgeEntry[] };
  const content = fmMatch[2]?.trim() || null;
  const loc = deriveLoc(mdPath, graphRoot, true);

  // Sidecar edges take precedence over frontmatter `nodes:` array
  const sidecarEdges = loadSidecarEdges(mdPath);
  const fmEdges = (meta.nodes ?? [])
    .filter((e) => !!e.id)
    .map((e) => normalizeEdgeEntry(e));
  const edges = sidecarEdges.length > 0 ? sidecarEdges : fmEdges;

  const abstract = normalizeImportedAbstract(meta.abstract);
  const abstractOriginHash = reconcileAbstractOriginHash(
    abstract,
    content,
    meta.abstractOriginHash,
    loc,
  );

  return {
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      isLink: meta.type === 'link',
      objectType: meta.objectType ?? null, // #725 — round-trip the collection discriminator
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
      abstract,
      abstractOriginHash,
      content,
      contentHash: meta.contentHash ?? null,
      tags: meta.tags ?? [],
      ownerRepo,
      // #1218 — spread, NOT `?? null`: an absent key must stay absent so the
      // sync update preserves the stored value. See the NodeYaml doc above.
      ...governedSignalsFromMirror({ role: meta.role, isRunnable: meta.runnable ?? meta.isRunnable }),
    },
    edges,
  };
}

/**
 * Load a legacy node (directory with .node/node.yaml + topic.md).
 */
async function loadLegacyNode(
  dirPath: string,
  graphRoot: string,
  ownerRepo: string,
): Promise<{ node: Partial<Node>; edges: Array<LoadedEdge> }> {
  const yamlPath = join(dirPath, '.node', 'node.yaml');
  const mdPath = join(dirPath, '.node', 'topic.md');

  const meta = parse(readFileSync(yamlPath, 'utf-8')) as NodeYaml & { nodes?: EdgeEntry[] };
  const content = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : null;
  const loc = deriveLoc(dirPath, graphRoot, false);

  const edges = (meta.nodes ?? [])
    .filter((e) => !!e.id)
    .map((e) => normalizeEdgeEntry(e));

  const abstract = normalizeImportedAbstract(meta.abstract);
  const normalizedContent = content?.trim() ?? null;
  const abstractOriginHash = reconcileAbstractOriginHash(
    abstract,
    normalizedContent,
    meta.abstractOriginHash,
    loc,
  );

  return {
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      isLink: meta.type === 'link',
      objectType: meta.objectType ?? null, // #725 — round-trip the collection discriminator
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
      abstract,
      abstractOriginHash,
      content: normalizedContent,
      contentHash: meta.contentHash ?? null,
      tags: meta.tags ?? [],
      ownerRepo,
    },
    edges,
  };
}

/**
 * Derive a colon-delimited loc from a file/directory path relative to graphRoot.
 */
function deriveLoc(path: string, graphRoot: string, isMdFile: boolean): string {
  let relPath: string;

  if (isMdFile) {
    const fileName = basename(path, '.md');
    const dir = relative(graphRoot, dirname(path));
    if (fileName === 'README') {
      relPath = dir; // server/README.md → "server"
    } else {
      relPath = dir ? join(dir, fileName) : fileName; // architecture.md → "architecture"
    }
  } else {
    relPath = relative(graphRoot, path);
  }

  // Strip .hadron/ prefix
  if (relPath === '.hadron') {
    relPath = '';
  } else if (relPath.startsWith('.hadron' + sep)) {
    relPath = relPath.slice('.hadron'.length + 1);
  }

  return relPath.split(sep).join(':');
}

/**
 * Load edges from a dot-dir sidecar `edges.yaml`.
 *
 * architecture.md → .architecture/edges.yaml
 * server/README.md → .server/edges.yaml
 */
function loadSidecarEdges(mdPath: string): Array<LoadedEdge> {
  const fileName = basename(mdPath, '.md');
  const dir = dirname(mdPath);

  const sidecarDir = fileName === 'README'
    ? join(dirname(dir), '.' + basename(dir))   // server/README.md → .server/
    : join(dir, '.' + fileName);                 // architecture.md → .architecture/

  const edgesPath = join(sidecarDir, 'edges.yaml');
  if (!existsSync(edgesPath)) return [];

  const entries = parse(readFileSync(edgesPath, 'utf-8')) as EdgeEntry[];
  if (!Array.isArray(entries)) return [];

  return entries
    .filter((e) => e.rel)
    .map((e) => normalizeEdgeEntry(e));
}

/**
 * Normalize a YAML edge entry into the LoadedEdge shape, preserving
 * `condition` (JSONLogic JSON) and `priority` when present so that
 * memories can round-trip through the on-disk format losslessly per
 * Invariant 10 (memory portability).
 */
function normalizeEdgeEntry(e: EdgeEntry): LoadedEdge {
  const out: LoadedEdge = {
    targetId: (e.id ?? e.target) as string,
    name: e.rel ?? null,
  };
  if (typeof e.description === 'string') {
    out.description = e.description;
  }
  // `runnable` is the canonical key (matches the CLI export); fall back to the
  // legacy `isRunnable` for edges in already-pushed git mirrors.
  if (typeof e.runnable === 'boolean') {
    out.isRunnable = e.runnable;
  } else if (typeof e.isRunnable === 'boolean') {
    out.isRunnable = e.isRunnable;
  }
  if (e.condition !== undefined && e.condition !== null) {
    out.condition = e.condition;
  }
  if (typeof e.priority === 'number') {
    out.priority = e.priority;
  }
  return out;
}
