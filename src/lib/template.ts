import Mustache from 'mustache';
import { parseIncludeTags } from './includes/parseIncludeTags.js';
import { spliceIncludes, type SpliceOptions } from './includes/spliceIncludes.js';
import { LiteralGuardCollision, makeLiteralGuard, restoreLiteralTags } from './includes/literalGuard.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { decryptNodeFields } from './nodeCrypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import {
  DATA_HOST_MEMORY_SELECT,
  declaredMemoryWideFields,
  isMultiHumanChatHost,
  multiHumanDataView,
} from './memoryDataView.js';

/**
 * Shared literal partial grammar for rendering and automation consent: the
 * same-memory loc targets of the include tags in `content` (#2040 — the one
 * parser, `parseIncludeTags`; URN targets are S2's). Never throws: a malformed
 * tag is refused at write time, and a stored one renders as before.
 */
export function templatePartialLocs(content: string): string[] {
  try {
    return [...new Set(parseIncludeTags(content).filter(t => t.kind === 'loc').map(t => t.target))];
  } catch {
    return [...new Set([...content.matchAll(/\{\{>\s*([^}]+)\s*\}\}/g)].map(match => match[1].trim()))];
  }
}

/**
 * Compile a Mustache template against node data.
 *
 * Resolution priority:
 *   1. Node's own data ({{field}})
 *   2. Memory's default data node ({{field}} if not in own data)
 *   3. Cross-node references ({{node-name.field}})
 *   4. Includes ({{> node-loc}}) — spliced in as text before the above render (#2041)
 *
 * For encrypted memories, this function only produces useful output if the
 * caller already has an active session key in the session key cache. Nodes
 * whose content/data are ciphertext-only (no key available) are skipped.
 *
 * `personId` is whose turn this compile is for (#910). In an app-class memory
 * the default data node holds per-person values, and only `personId`'s own are
 * read, on top of the explicitly memory-wide ones (`memoryDataView.ts`). Omit
 * it when there is no attributable person: such a compile reads memory-wide
 * values only. Single-human memories ignore it.
 */
export async function compileTemplate(
  rawContent: string,
  nodeData: Record<string, unknown> | null,
  memoryId: string,
  db: PrismaClient,
  accessFilter: Record<string, unknown>,
  personId?: string | null,
  /** `includer` names the node being compiled so a cycle back through it is caught at once (#2041). */
  includes: SpliceOptions & { includer?: { id?: string } } = {},
): Promise<string> {
  if (!rawContent.includes('{{')) return rawContent;
  const content = rawContent;

  // Check if the memory is encrypted. If so, we need to decrypt any nodes we
  // load during compilation. No key in the cache → we can't compile, so we
  // leave template refs unresolved and return the raw content.
  //
  // `db.memory` may be missing in narrow test doubles; treat that as plaintext.
  const memory = db.memory?.findUnique
    ? await db.memory.findUnique({
        where: { id: memoryId },
        select: { ...DATA_HOST_MEMORY_SELECT, isEncrypted: true },
      })
    : null;
  const memEncInfo = memory ? { id: memory.id, isEncrypted: memory.isEncrypted } : null;
  const hasKey = memEncInfo?.isEncrypted
    ? sessionKeyCache.getByMemoryId(memoryId) !== null
    : true;
  if (memEncInfo?.isEncrypted && !hasKey) {
    return content;
  }

  // Includes first, as plain text: each tag becomes the target's stored text
  // (nested, the reader's own access, a notice where it can't resolve), so the
  // variables below render across the whole of it, as a Mustache partial did.
  // A tag written as code is literal (cor:dmo:150:02, #2135): its opener is
  // swapped for a per-render guard here, so Mustache cannot drop it as a
  // partial, and swapped back on every way out. A guard that meets source text
  // containing it is discarded and drawn again.
  const renderSpliced = async (content: string, guard: string): Promise<string> => {
    // 1. Build the view: node's own data
    const view: Record<string, unknown> = {};

    // #910: the default data bag and {{data.…}} references both use the
    // per-person view in a multi-human host.
    const dataNodeView = async (stored: Record<string, unknown>) =>
      memory && isMultiHumanChatHost(memory)
        ? multiHumanDataView(stored, await declaredMemoryWideFields(db, memory), personId)
        : stored;

    // #1835: retain both the includer's memory and the caller's read filter.
    // Spreading the filter here could overwrite the literal memoryId.
    // 2. Load memory's default data node (loc: "data")
    const defaultDataNode = await db.node.findFirst({
      where: { loc: 'data', memoryId, deletedAt: null, AND: [accessFilter] },
      select: { data: true, content: true, memoryId: true },
    });
    if (defaultDataNode) {
      if (memEncInfo?.isEncrypted) decryptNodeFields(defaultDataNode, memEncInfo);
      if (defaultDataNode.data && typeof defaultDataNode.data === 'object') {
        Object.assign(view, await dataNodeView(defaultDataNode.data as Record<string, unknown>));
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
        where: { loc: ref, memoryId, deletedAt: null, AND: [accessFilter] },
        select: { data: true, content: true, memoryId: true },
      });
      if (refNode) {
        if (memEncInfo?.isEncrypted) decryptNodeFields(refNode, memEncInfo);
        if (refNode.data && typeof refNode.data === 'object') {
          view[ref] = ref === 'data'
            ? await dataNodeView(refNode.data as Record<string, unknown>)
            : refNode.data;
        }
      }
    }

    // The guard is restored out of the rendered text, so data holding it would be rewritten too.
    if (viewHolds(view, guard)) throw new LiteralGuardCollision();
    try {
      return Mustache.render(content, view);
    } catch {
      // If compilation fails, return the raw content
      return content;
    }
  };

  for (let attempt = 0; ; attempt++) {
    const guard = makeLiteralGuard();
    try {
      const spliced = await spliceIncludes(
        db, accessFilter, content, { id: includes.includer?.id, memoryId }, { ...includes, literalGuard: guard },
      );
      return restoreLiteralTags(await renderSpliced(spliced, guard), guard);
    } catch (e) {
      if (!(e instanceof LiteralGuardCollision) || attempt >= 4) throw e;
    }
  }
}

/** Whether any string in `view` (keys included) holds `guard`. A walk, not JSON: JSON escapes the control characters a guard is made of. */
function viewHolds(value: unknown, guard: string, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return value.includes(guard);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([k, v]) => k.includes(guard) || viewHolds(v, guard, seen));
}
