/**
 * #5390 — the parent nodes of a chatbot Agent's conversation design.
 *
 * A chatbot's conversations, stages and prompts are system nodes at locs `conversations:<name>`,
 * `conversations:<name>:<stage>` and `prompts:<name>:<stage>`. Nothing created their parents, so the portal's
 * tree (which shows a node only under an existing parent) hid them. A write that creates one of these nodes now
 * also creates the missing container parents, in the same transaction:
 *
 *   conversations           for every `conversations:` node
 *   prompts                 for every `prompts:` node
 *   prompts:<name>          for a prompt at depth 3 or more (`prompts:<name>:<stage>`)
 *
 * NEVER `conversations:<name>`. That loc is a conversation, not a container: chat start selects every
 * `conversations:` node by prefix with no type filter (`resolvers.mutation.chat.ts`, `topLevelConversations`), so an
 * empty one made for a stage written without its conversation would join the ordered pick ahead of a real one.
 *
 * Rules (the same as the #3833 skeleton, `agentSkeleton.ts`):
 * - FAMILIES ONLY. Any other loc, in any memory, gets nothing: this is not a generic "create missing ancestors".
 * - AN AGENT'S OWN SYSTEM MEMORY ONLY: `class = 'system'`, `is_install_memory = false`, some live Agent's
 *   `system_memory_id`, and NOT encrypted. (An encrypted memory's parents would need its session key; those
 *   memories are skipped and stay as they were, which the PR states under Limits.)
 * - ONLY LOCS THE EFFECTIVE MEMORY LACKS (cor:dmo:050:14: a parent in a derived Agent would hide its base's node), and a loc
 *   with any row, live or tombstoned, is left alone: never overwritten, never revived.
 * - COUNTED. A parent is a live node (cor:acl:150:04): the caller's headroom check counts them with the node it writes.
 *
 * The caller holds the child's ancestor locks (`lockAncestorsForCreate`), which are the parents' own advisory keys,
 * so a parent is created under the lock that serializes it against a concurrent delete or create of the same parent.
 */

import type { Prisma } from '../generated/prisma/index.js';
import { generateId } from './id.js';
import { findEffectiveNodeIdByLoc } from './effectiveSystemMemory.js';

/** One parent to create. */
export type ChatbotParent = { loc: string; name: string; description: string };

/**
 * The parent locs the family of `loc` owns, shallowest first. Pure: no reads. A loc outside the families, or a
 * family's own root, owns none. Never includes `conversations:<name>`.
 */
export function chatbotParentLocsOf(loc: string): string[] {
  const parts = loc.split(':');
  const root = parts[0];
  if (root !== 'conversations' && root !== 'prompts') return [];
  if (parts.length < 2) return [];
  const out = [root];
  if (root === 'prompts' && parts.length >= 3) out.push(`prompts:${parts[1]}`);
  return out;
}

const PARENT_DESCRIPTIONS: Record<string, { name: string; description: string }> = {
  conversations: { name: 'Conversations', description: 'Parent of the Agent\'s conversations (each conversation is a conversations:<name> node, its stages beneath it).' },
  prompts: { name: 'Prompts', description: 'Parent of the Agent\'s prompt templates (prompts:<conversation>, with one prompt per stage beneath it).' },
};

function parentFor(loc: string): ChatbotParent {
  const known = PARENT_DESCRIPTIONS[loc];
  if (known) return { loc, ...known };
  const name = loc.split(':')[1] ?? loc;
  return { loc, name: `Prompts: ${name}`, description: `Parent of the prompts of the conversation "${name}", one per stage.` };
}

/** Whether `memoryId` is a live, unencrypted Agent's own system memory (not an install memory). */
async function isChatbotTargetMemory(tx: Prisma.TransactionClient, memoryId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM memories m
    WHERE m.id = ${memoryId} AND m.deleted_at IS NULL AND m.class = 'system' AND m.is_install_memory = false
      AND m.is_encrypted = false
      AND EXISTS (SELECT 1 FROM agents a WHERE a.system_memory_id = m.id AND a.deleted_at IS NULL)`;
  return rows.length > 0;
}

/**
 * The parents a write at `loc` in `memoryId` would have to create: the family's parents that have no row in the memory
 * (live or tombstoned) and that the memory's effective chain does not provide. Empty when `loc` is outside the families
 * or the memory is not an Agent's own unencrypted system memory. Reads only.
 */
export async function planChatbotParents(tx: Prisma.TransactionClient, memoryId: string, loc: string): Promise<ChatbotParent[]> {
  const candidates = chatbotParentLocsOf(loc);
  if (candidates.length === 0) return [];
  if (!(await isChatbotTargetMemory(tx, memoryId))) return [];
  const missing: ChatbotParent[] = [];
  for (const p of candidates) {
    if (await findEffectiveNodeIdByLoc(tx, memoryId, p)) continue;
    // A tombstone holds the unique (loc, memory) key: leave it, never revive or overwrite.
    if (await tx.node.findFirst({ where: { memoryId, loc: p }, select: { id: true } })) continue;
    missing.push(parentFor(p));
  }
  return missing;
}

/** Create the planned parents, empty. Returns the locs created. Call `planChatbotParents` first, in the same transaction. */
export async function createChatbotParents(tx: Prisma.TransactionClient, memoryId: string, plan: readonly ChatbotParent[], createdBy: string | null): Promise<string[]> {
  const created: string[] = [];
  for (const p of plan) {
    await tx.node.create({ data: { id: generateId(), memoryId, loc: p.loc, name: p.name, description: p.description, createdBy } });
    created.push(p.loc);
  }
  return created;
}

/**
 * The retrofit step for one Agent system memory: the `prompts:<name>` parents of the prompts it already has. (The
 * `conversations` and `prompts` roots come from the skeleton, `seedAgentSkeleton`.) Same rules: only a loc the effective
 * memory lacks and no row holds. Returns the locs created.
 */
export async function seedPromptParents(tx: Prisma.TransactionClient, memoryId: string, createdBy: string | null): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ loc: string }>>`
    SELECT loc FROM nodes WHERE memory_id = ${memoryId} AND deleted_at IS NULL AND loc LIKE 'prompts:%:%'`;
  const wanted = [...new Set(rows.map((r) => `prompts:${r.loc.split(':')[1]}`))].sort();
  const created: string[] = [];
  for (const loc of wanted) {
    if (await findEffectiveNodeIdByLoc(tx, memoryId, loc)) continue;
    if (await tx.node.findFirst({ where: { memoryId, loc }, select: { id: true } })) continue;
    created.push(...await createChatbotParents(tx, memoryId, [parentFor(loc)], createdBy));
  }
  return created;
}
