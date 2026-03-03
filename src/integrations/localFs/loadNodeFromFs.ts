import { readFileSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';
import { parse } from 'yaml';
import type { Node } from '../../index.d.js';

interface NodeYaml {
  name: string;
  description?: string;
  summary?: string;
  tags?: string[];
  nodes?: Array<{ loc: string; rel: string }>;
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
): Promise<{ node: Partial<Node>; edges: Array<{ targetLoc: string; label: string }> }> => {
  const nodeDir = join(dirPath, '.node');
  const yamlPath = join(nodeDir, 'node.yaml');
  const mdPath = join(nodeDir, 'topic.md');

  const yamlContent = readFileSync(yamlPath, 'utf-8');
  const meta = parse(yamlContent) as NodeYaml;

  const content = existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : null;

  // Derive loc from relative path: micromentor-org/mmdata/services → micromentor-org.mmdata.services
  const relPath = relative(graphRoot, dirPath);
  const loc = relPath.split(sep).join('.');
  const namespace = loc.split('.').slice(0, 2).join('.');

  // Extract edges from the nodes array in node.yaml
  const edges = (meta.nodes ?? []).map((edge) => ({
    targetLoc: edge.loc,
    label: edge.rel,
  }));

  return {
    node: {
      loc,
      name: meta.name,
      alias: meta.alias ?? null,
      description: meta.description ?? meta.summary ?? null,
      content: content?.trim() ?? null,
      tags: meta.tags ?? [],
      namespace,
      ownerRepo,
    },
    edges,
  };
};
