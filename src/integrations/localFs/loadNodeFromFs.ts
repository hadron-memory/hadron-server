import { readFileSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';
import { parse } from 'yaml';
import type { Node } from '../../index.d.js';

interface NodeYaml {
  id: string;
  name: string;
  description?: string;
  summary?: string;
  tags?: string[];
  nodes?: Array<{ id: string; rel: string; loc?: string }>;
  alias?: string;
  contentHash?: string;
}

/**
 * Load a single node from the filesystem.
 *
 * @param dirPath   Absolute path to the directory that contains `.node/`
 * @param graphRoot Absolute path to the graph root (for deriving loc)
 * @param ownerRepo GitHub repo slug, e.g. "micromentor/mmdata"
 */
export const loadNodeFromFs = async (
  dirPath: string,
  graphRoot: string,
  ownerRepo: string,
): Promise<{ node: Partial<Node>; edges: Array<{ targetId: string; label: string }> }> => {
  const nodeDir = join(dirPath, '.node');
  const yamlPath = join(nodeDir, 'node.yaml');
  const mdPath = join(nodeDir, 'topic.md');

  const yamlContent = readFileSync(yamlPath, 'utf-8');
  const meta = parse(yamlContent) as NodeYaml;

  const content = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : null;

  // Derive loc from relative path: micromentor-org/mmdata/services → micromentor-org.mmdata.services
  // Strip leading .hadron/ prefix: when nodes live in .hadron/ inside a project repo,
  // the .hadron segment is transparent and excluded from the loc.
  let relPath = relative(graphRoot, dirPath);
  if (relPath === '.hadron') {
    relPath = '';
  } else if (relPath.startsWith('.hadron' + sep)) {
    relPath = relPath.slice('.hadron'.length + 1);
  }
  const loc = relPath.split(sep).join('.');
  const namespace = loc.split('.').slice(0, 2).join('.');

  // Extract edges — modern format uses id; entries without id are skipped
  const edges = (meta.nodes ?? [])
    .filter((edge) => !!edge.id)
    .map((edge) => ({
      targetId: edge.id,
      label: edge.rel,
    }));

  return {
    node: {
      id: meta.id,
      loc,
      name: meta.name,
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
      content: content?.trim() ?? null,
      contentHash: meta.contentHash ?? null,
      tags: meta.tags ?? [],
      namespace,
      ownerRepo,
    },
    edges,
  };
};
