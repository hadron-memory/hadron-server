import { readFileSync, existsSync } from 'fs';
import { join, relative, sep, basename, dirname } from 'path';
import { parse } from 'yaml';
import type { Node } from '../../index.d.js';

interface NodeYaml {
  id: string;
  name: string;
  urn?: string;
  type?: string;
  description?: string;
  summary?: string;
  tags?: string[];
  nodes?: Array<{ id: string; rel: string; loc?: string }>;
  alias?: string;
  author?: string;
  contentHash?: string;
}

interface EdgeEntry {
  target: string;
  rel: string;
  id?: string;
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
export const loadNodeFromFs = async (
  source: string,
  graphRoot: string,
  ownerRepo: string,
): Promise<{ node: Partial<Node>; edges: Array<{ targetId: string; label: string }> }> => {
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
): Promise<{ node: Partial<Node>; edges: Array<{ targetId: string; label: string }> }> {
  const raw = readFileSync(mdPath, 'utf-8');

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) throw new Error(`No frontmatter found in ${mdPath}`);

  const meta = parse(fmMatch[1]) as NodeYaml;
  const content = fmMatch[2]?.trim() || null;
  const loc = deriveLoc(mdPath, graphRoot, true);

  // Sidecar edges take precedence over frontmatter `nodes:` array
  const sidecarEdges = loadSidecarEdges(mdPath);
  const fmEdges = (meta.nodes ?? [])
    .filter((e) => !!e.id)
    .map((e) => ({ targetId: e.id, label: e.rel }));
  const edges = sidecarEdges.length > 0 ? sidecarEdges : fmEdges;

  return {
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      isLink: meta.type === 'link',
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
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
): Promise<{ node: Partial<Node>; edges: Array<{ targetId: string; label: string }> }> {
  const yamlPath = join(dirPath, '.node', 'node.yaml');
  const mdPath = join(dirPath, '.node', 'topic.md');

  const meta = parse(readFileSync(yamlPath, 'utf-8')) as NodeYaml;
  const content = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : null;
  const loc = deriveLoc(dirPath, graphRoot, false);

  const edges = (meta.nodes ?? [])
    .filter((e) => !!e.id)
    .map((e) => ({ targetId: e.id, label: e.rel }));

  return {
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      isLink: meta.type === 'link',
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
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
function loadSidecarEdges(mdPath: string): Array<{ targetId: string; label: string }> {
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
    .map((e) => ({
      targetId: e.id ?? e.target,
      label: e.rel,
    }));
}
