/**
 * #5390 — the missing container parents of a chatbot Agent's conversation, stage and prompt nodes.
 *
 * A conversation lives at `conversations:<name>`, its stages at `conversations:<name>:<stage>`, and a stage's prompt
 * template at `prompts:<name>:<stage>`. Nothing created `conversations`, `prompts` or `prompts:<name>`, so a tree that
 * shows a node only under an existing parent hid the whole design. A write that creates one of these nodes now creates
 * those container parents, in the same transaction, as empty `info` nodes.
 *
 * The rules:
 * - FAMILIES ONLY (FIT pin (b), Victor on #5390): a loc of depth 2 or 3 under `conversations` or `prompts`. No other loc
 *   gains parents.
 * - CONTAINERS ONLY. `conversations:<name>` is a conversation, not a container: the chat engine reads every
 *   `conversations:` node and an empty one would join chat-start selection (#5390 acceptance: chat start behaves as
 *   before). A stage written with no conversation therefore gets `conversations` but not `conversations:<name>`.
 * - AGENT SYSTEM MEMORIES ONLY (`class = 'system'`, `is_install_memory = false`), plaintext: an install-memory node
 *   replaces the Agent's node at its loc (cor:agt:040:16), so a parent there would hide the Agent's own; an encrypted
 *   memory's text cannot be written here without its session key (stated limit).
 * - OPTION B and NEVER OVERWRITE, as the #3833 skeleton (`agentSkeleton.ts`): a loc the Agent's effective memory already
 *   provides (own node or a base's) is skipped, and a loc holding any row of this memory, a tombstone included, is left
 *   alone (a tombstone is not revived).
 * - A protected loc (spec 049 S4, a Channel address) is never written.
 *
 * Locking: every caller holds the advisory keys of the written loc's strict ancestors (`lockAncestorsForCreate` /
 * `lockAncestorsForCreateMany`), which are exactly the locs created here, so two writes that would create the same parent
 * serialize and the second finds it.
 *
 * Counting (FIT pin (a), cor:acl:150:04): each parent is a live node. A write that refuses at the owner limit counts them
 * with its own node (`amount`); the retrofit and Agent creation are platform writes, counted by the node totals and never
 * refused.
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { findEffectiveNodeIdByLoc } from './effectiveSystemMemory.js';
import { generateId } from './id.js';
import { LocProtectedError, assertLocWritable } from './protectedLoc.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** The two family roots and what their parents are called. A Map, so a loc's first segment is never read as an inherited object key. */
const ROOTS: ReadonlyMap<string, { name: string; description: string }> = new Map([
  ['conversations', { name: 'Conversations', description: 'Parent of the Agent\'s conversations.' }],
  ['prompts', { name: 'Prompts', description: 'Parent of the Agent\'s prompt templates, one parent per conversation.' }],
]);

/**
 * The container parents a node at `loc` needs, shallowest first: `conversations` for a conversation or stage,
 * `prompts` (and `prompts:<name>` for a stage prompt) for a prompt. Empty for every other loc.
 */
export function chatbotContainerLocs(loc: string): string[] {
  const parts = loc.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p === '')) return [];
  const root = parts[0]!;
  if (!ROOTS.has(root)) return [];
  if (root === 'conversations') return ['conversations'];
  return parts.length === 3 ? ['prompts', `prompts:${parts[1]}`] : ['prompts'];
}

/** True when `memoryId` is a live, plaintext Agent system memory (not an install memory). */
async function isAgentSystemMemory(db: Db, memoryId: string): Promise<boolean> {
  const m = await db.memory.findFirst({
    where: { id: memoryId, deletedAt: null, class: 'system', isInstallMemory: false },
    select: { isEncrypted: true },
  });
  return !!m && !m.isEncrypted;
}

/**
 * The container parents of the nodes at `locs` that this write must create in `memoryId`, shallowest first and without
 * duplicates. Read-only. Call it under the ancestor keys, before the owner-limit check, so the count includes them.
 */
export async function missingChatbotContainers(db: Db, memoryId: string, locs: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(locs.flatMap(chatbotContainerLocs))].filter((l) => !locs.includes(l));
  if (wanted.length === 0) return [];
  if (!(await isAgentSystemMemory(db, memoryId))) return [];
  wanted.sort((a, b) => a.split(':').length - b.split(':').length || (a < b ? -1 : a > b ? 1 : 0));
  const missing: string[] = [];
  for (const loc of wanted) {
    if (await findEffectiveNodeIdByLoc(db, memoryId, loc)) continue;
    const any = await db.node.findFirst({ where: { memoryId, loc }, select: { id: true } });
    if (any) continue;
    try {
      await assertLocWritable(db, memoryId, loc, 'create');
    } catch (e) {
      if (e instanceof LocProtectedError) continue;
      throw e;
    }
    missing.push(loc);
  }
  return missing;
}

/**
 * The node type of a parent that holds an Agent's definition nodes (#5453 Ask 8, Holger 2026-11-27: "they should all
 * be system"). Until #5453 these parents were written `info` here and in the skeleton, and `system` by the portal.
 */
export const DEFINITION_PARENT_NODE_TYPE = 'system' as const;

/** Create the parents {@link missingChatbotContainers} returned, as empty `system` nodes with no role. */
export async function createChatbotContainers(db: Db, memoryId: string, locs: readonly string[], createdBy: string | null): Promise<void> {
  if (locs.length === 0) return;
  const rows = [];
  for (const loc of locs) {
    // Only a root (`conversations`, `prompts`) or a `prompts:<name>` parent is ever created here.
    const parts = loc.split(':');
    const root = ROOTS.get(parts[0]!)!;
    const name = parts.length === 1 ? root.name : parts[1]!;
    const description = parts.length === 1 ? root.description : `Parent of the prompt templates of the stages of conversation ${parts[1]}.`;
    rows.push({ id: generateId(), memoryId, loc, name, description, nodeType: DEFINITION_PARENT_NODE_TYPE, createdBy });
  }
  // A writer that holds no key on the container's loc (hadron_create_parent_node at a root, or a plain create of the loc
  // itself) can be inserting it right now. ON CONFLICT DO NOTHING waits for that insert and then keeps its row, instead
  // of failing this write on the unique (loc, memory) key (LOCAL P3 at e7219623). The count taken before is then one
  // high, which can only refuse early, never admit past the limit.
  await db.node.createMany({ data: rows, skipDuplicates: true });
}

/**
 * The retrofit's step for one Agent system memory (#5390 Wanted 3): the container parents its live conversation, stage
 * and prompt nodes lack. Returns the locs created. Idempotent. The caller has re-judged the memory under its row lock.
 */
export async function seedChatbotContainers(db: Db, memoryId: string, createdBy: string | null): Promise<string[]> {
  const rows = await db.node.findMany({
    where: { memoryId, deletedAt: null, OR: [{ loc: { startsWith: 'conversations:' } }, { loc: { startsWith: 'prompts:' } }] },
    select: { loc: true },
  });
  const missing = await missingChatbotContainers(db, memoryId, rows.map((r) => r.loc));
  await createChatbotContainers(db, memoryId, missing, createdBy);
  return missing;
}
