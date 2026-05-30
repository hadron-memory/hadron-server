import { readFileSync, existsSync } from 'fs';
import { join, relative, sep, basename, dirname } from 'path';
import { parse } from 'yaml';
import type { Node } from '../../index.d.js';
import { NodeAbstractTooLongError } from '../../lib/entityRef/errors.js';

interface NodeYaml {
  id: string;
  name: string;
  urn?: string;
  type?: string;
  description?: string;
  /** Paragraph-length summary. Spec 031. Distinct from `description`. */
  abstract?: string;
  /**
   * Legacy alias historically read into `description` when no
   * `description` key existed. Predates the spec-031 `abstract` field
   * and remains for back-compat. New writers use `abstract` for paragraph
   * summaries and `description` for one-line headlines.
   */
  summary?: string;
  tags?: string[];
  nodes?: Array<{ id: string; rel: string; loc?: string }>;
  alias?: string;
  author?: string;
  contentHash?: string;
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
 * Defensive type coercion: YAML's `parse` is loose about types — a
 * `abstract: 42` line yields a number, not a string. Coerce to string
 * first so `.trim()` doesn't blow up at runtime on malformed input.
 */
function normalizeImportedAbstract(raw: unknown): string | null {
  if (raw == null) return null;
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
  rel: string;
  id?: string;
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
  label: string;
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

  return {
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      isLink: meta.type === 'link',
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
      abstract: normalizeImportedAbstract(meta.abstract),
      content,
      contentHash: meta.contentHash ?? null,
      tags: meta.tags ?? [],
      ownerRepo,
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

  return {
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      isLink: meta.type === 'link',
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
      abstract: normalizeImportedAbstract(meta.abstract),
      content: content?.trim() ?? null,
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
    label: e.rel,
  };
  if (e.condition !== undefined && e.condition !== null) {
    out.condition = e.condition;
  }
  if (typeof e.priority === 'number') {
    out.priority = e.priority;
  }
  return out;
}
