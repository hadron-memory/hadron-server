import Mustache from 'mustache';
import type { PrismaClient } from '../generated/prisma/index.js';

/**
 * Compile a Mustache template against node data.
 *
 * Resolution priority:
 *   1. Node's own data ({{field}})
 *   2. Memory's default data node ({{field}} if not in own data)
 *   3. Cross-node references ({{node-name.field}})
 *   4. Partials ({{> node-loc}}) — includes another node's compiled content
 */
export async function compileTemplate(
  content: string,
  nodeData: Record<string, unknown> | null,
  memoryId: string,
  db: PrismaClient,
  accessFilter: Record<string, unknown>,
): Promise<string> {
  if (!content.includes('{{')) return content;

  // 1. Build the view: node's own data
  const view: Record<string, unknown> = {};

  // 2. Load memory's default data node (loc: "data")
  const defaultDataNode = await db.node.findFirst({
    where: { loc: 'data', memoryId, ...accessFilter },
    select: { data: true },
  });
  if (defaultDataNode?.data && typeof defaultDataNode.data === 'object') {
    Object.assign(view, defaultDataNode.data as Record<string, unknown>);
  }

  // Node's own data overrides defaults
  if (nodeData && typeof nodeData === 'object') {
    Object.assign(view, nodeData as Record<string, unknown>);
  }

  // 3. Find cross-node references ({{node-name.field}})
  // Mustache uses dot paths — we need to pre-populate referenced nodes
  const refPattern = /\{\{[#^/]?([a-zA-Z0-9_-]+)\./g;
  const refs = new Set<string>();
  let match;
  while ((match = refPattern.exec(content)) !== null) {
    const ref = match[1];
    // Skip if already in view (local or default data)
    if (!(ref in view)) {
      refs.add(ref);
    }
  }

  for (const ref of refs) {
    const refNode = await db.node.findFirst({
      where: { loc: ref, memoryId, ...accessFilter },
      select: { data: true },
    });
    if (refNode?.data && typeof refNode.data === 'object') {
      view[ref] = refNode.data;
    }
  }

  // 4. Resolve partials ({{> node-loc}})
  const partials: Record<string, string> = {};
  const partialPattern = /\{\{>\s*([^}]+)\s*\}\}/g;
  const partialRefs = new Set<string>();
  while ((match = partialPattern.exec(content)) !== null) {
    partialRefs.add(match[1].trim());
  }

  for (const partialLoc of partialRefs) {
    const partialNode = await db.node.findFirst({
      where: { loc: partialLoc, memoryId, ...accessFilter },
      select: { content: true, data: true },
    });
    if (partialNode?.content) {
      // Compile the partial recursively (one level deep to prevent infinite loops)
      // For now, don't recurse — just use raw content
      partials[partialLoc] = partialNode.content;
    }
  }

  try {
    return Mustache.render(content, view, partials);
  } catch {
    // If compilation fails, return the raw content
    return content;
  }
}
