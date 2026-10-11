import Mustache from 'mustache';
import type { PrismaClient } from '../generated/prisma/index.js';
import { decryptNodeFields } from './nodeCrypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';

/** Shared literal partial grammar for rendering and automation consent. */
export function templatePartialLocs(content: string): string[] {
  return [...new Set([...content.matchAll(/\{\{>\s*([^}]+)\s*\}\}/g)].map(match => match[1].trim()))];
}

/**
 * Compile a Mustache template against node data.
 *
 * Resolution priority:
 *   1. Node's own data ({{field}})
 *   2. Memory's default data node ({{field}} if not in own data)
 *   3. Cross-node references ({{node-name.field}})
 *   4. Partials ({{> node-loc}}) — includes another node's compiled content
 *
 * For encrypted memories, this function only produces useful output if the
 * caller already has an active session key in the session key cache. Nodes
 * whose content/data are ciphertext-only (no key available) are skipped.
 */
export async function compileTemplate(
  content: string,
  nodeData: Record<string, unknown> | null,
  memoryId: string,
  db: PrismaClient,
  accessFilter: Record<string, unknown>,
): Promise<string> {
  if (!content.includes('{{')) return content;

  // Check if the memory is encrypted. If so, we need to decrypt any nodes we
  // load during compilation. No key in the cache → we can't compile, so we
  // leave template refs unresolved and return the raw content.
  //
  // `db.memory` may be missing in narrow test doubles; treat that as plaintext.
  const memory = db.memory?.findUnique
    ? await db.memory.findUnique({
        where: { id: memoryId },
        select: { id: true, isEncrypted: true },
      })
    : null;
  const memEncInfo = memory ? { id: memory.id, isEncrypted: memory.isEncrypted } : null;
  const hasKey = memEncInfo?.isEncrypted
    ? sessionKeyCache.getByMemoryId(memoryId) !== null
    : true;
  if (memEncInfo?.isEncrypted && !hasKey) {
    return content;
  }

  // 1. Build the view: node's own data
  const view: Record<string, unknown> = {};

  // 2. Load memory's default data node (loc: "data")
  const defaultDataNode = await db.node.findFirst({
    where: { loc: 'data', memoryId, deletedAt: null, ...accessFilter },
    select: { data: true, content: true, memoryId: true },
  });
  if (defaultDataNode) {
    if (memEncInfo?.isEncrypted) decryptNodeFields(defaultDataNode, memEncInfo);
    if (defaultDataNode.data && typeof defaultDataNode.data === 'object') {
      Object.assign(view, defaultDataNode.data as Record<string, unknown>);
    }
  }

  // Node's own data overrides defaults. If nodeData is the wrapped
  // ciphertext shape, the caller is responsible for having decrypted it
  // before passing — the read-path resolvers already do that.
  if (nodeData && typeof nodeData === 'object' && !('__enc' in nodeData)) {
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
      where: { loc: ref, memoryId, deletedAt: null, ...accessFilter },
      select: { data: true, content: true, memoryId: true },
    });
    if (refNode) {
      if (memEncInfo?.isEncrypted) decryptNodeFields(refNode, memEncInfo);
      if (refNode.data && typeof refNode.data === 'object') {
        view[ref] = refNode.data;
      }
    }
  }

  // 4. Resolve partials ({{> node-loc}})
  const partials: Record<string, string> = {};
  const partialRefs = templatePartialLocs(content);

  for (const partialLoc of partialRefs) {
    const partialNode = await db.node.findFirst({
      where: { loc: partialLoc, memoryId, deletedAt: null, ...accessFilter },
      select: { content: true, data: true, memoryId: true },
    });
    if (partialNode) {
      if (memEncInfo?.isEncrypted) decryptNodeFields(partialNode, memEncInfo);
      if (partialNode.content) {
        partials[partialLoc] = partialNode.content;
      }
    }
  }

  try {
    return Mustache.render(content, view, partials);
  } catch {
    // If compilation fails, return the raw content
    return content;
  }
}
