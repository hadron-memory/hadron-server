import type { PrismaClient, Prisma } from '../generated/prisma/index.js';
import { canManageAgentSystemMemory } from './auth/managedSystemMemory.js';
import { isAgentInstalledAndLicensed } from './appAgent.js';
import { AgentNotFoundError } from './entityRef/errors.js';

/** The principal fields reach is judged from, and nothing else (#4105): deliberately NOT the GraphQL Context, so lib code
 * does not import from the api layer and cannot read `caller.db`. Every database read goes through the handle passed beside it.
 * A Context satisfies this structurally. */
export type ChatCaller = Parameters<typeof canManageAgentSystemMemory>[1];

/** The Agent columns reach is decided from. A row carrying them is judged as it is (it was just read); any other row is re-read. */
type AgentReachRow = { id: string; systemMemoryId?: string | null; deletedAt?: Date | null };

/** A retained chat pointer is not authority to read an Agent's definition. Gate the already-resolved Agent before any
 * system-memory reads, independently of the home's class.
 *
 * - App-bearing home (#4043): the home's App must still install and license the Agent. No manager exemption.
 * - App-less home (#4112), when the caller is passed (the response): the CURRENT principal must manage the Agent's
 *   system memory (cor:acl:010:01 system row, cor:dmo:050:13), the same manager arm start applies. PUBLIC visibility,
 *   org READER reach, the chat's creator and a historical App are not substitutes. Send uses the same judgement below.
 *
 * Returning null means "no Agent definition for this turn": the caller records the turn and routes nothing, with no
 * error and no new oracle (cor:cht:020:01).
 */
export async function chatHomeAgentIfReachable<T extends AgentReachRow>(
  db: PrismaClient | Prisma.TransactionClient,
  home: { appId: string | null },
  agent: T | null,
  caller?: ChatCaller,
): Promise<T | null> {
  if (!agent) return agent;
  if (home.appId) return await isAgentInstalledAndLicensed(db, home.appId, agent.id) ? agent : null;
  // `sendChatMessage` omits the caller here: it refuses an unreachable Agent instead (see {@link refuseUnreachableChatHomeAgent}).
  if (!caller) return agent;
  return await callerReachesAgent(db, caller, agent) ? agent : null;
}

/** #4112: App-less definition admission uses the shared manager predicate through the supplied DB handle, never
 * caller.db. A deleted or definition-less Agent is rejected before asking about current management.
 *
 * #4105: a row that carries `systemMemoryId` and `deletedAt` is judged as it is: every caller passes the row its own lookup
 * read a moment before ({@link resolveChatHomeAgent}), so the send path resolves the Agent once per turn instead of twice.
 * A row without those columns is re-read through the same handle. A caller holding an OLD row must re-read it itself. */
async function callerReachesAgent(db: PrismaClient | Prisma.TransactionClient, caller: ChatCaller, agent: AgentReachRow): Promise<boolean> {
  const current = 'systemMemoryId' in agent && 'deletedAt' in agent
    ? agent
    : await db.agent.findUnique({ where: { id: agent.id }, select: { systemMemoryId: true, deletedAt: true } });
  return !!current && !current.deletedAt && !!current.systemMemoryId
    && await canManageAgentSystemMemory(db as PrismaClient, caller, current.systemMemoryId);
}

/** #4070 (send): an App-less home whose Agent the current caller cannot reach is refused as an unknown Agent,
 * AGENT_NOT_FOUND, exactly as the serve gate refuses it, but BEFORE any protected read (the pinned revision
 * included). App-bearing homes are unchanged (licence arm, empty result). Nothing has been written at this point. */
export async function refuseUnreachableChatHomeAgent(
  db: PrismaClient | Prisma.TransactionClient,
  home: { appId: string | null },
  agent: AgentReachRow | null,
  caller: ChatCaller,
): Promise<void> {
  if (agent && !home.appId && !await callerReachesAgent(db, caller, agent)) throw new AgentNotFoundError(agent.id);
}

/**
 * #4076: the ONE Agent lookup for a chat turn (sendChatMessage and processChatResponse).
 * Order is binding: resolve (a soft-deleted Agent is none, cor:dmo:010:04), then licence
 * ({@link chatHomeAgentIfReachable}), then the caller reads the Agent's definition.
 * A shared/user home pointer names its Agent; otherwise (legacy) the first non-deleted Agent
 * linked by a LIVE (not soft-deleted) memory item that has a system memory, in the documented order (createdAt, id).
 * `deletedAgentId` names a pointer's soft-deleted Agent so a caller can keep its own refusal.
 */
export async function resolveChatHomeAgent(
  db: PrismaClient | Prisma.TransactionClient,
  memory: { id: string; appId: string | null; sharedMemoryOfAgentId: string | null; userMemoryOfAgentId: string | null },
  caller?: ChatCaller,
): Promise<{ agent: any | null; deletedAgentId: string | null }> {
  const pointer = memory.sharedMemoryOfAgentId ?? memory.userMemoryOfAgentId;
  let agent: any | null = null;
  let deletedAgentId: string | null = null;
  if (pointer) {
    const found = await db.agent.findUnique({ where: { id: pointer } });
    if (found?.deletedAt) deletedAgentId = found.id;
    else agent = found;
  } else {
    const legacy = await db.agent.findMany({
      where: { deletedAt: null, memoryItems: { some: { memoryId: memory.id, deletedAt: null } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    agent = legacy.find((a) => (a as any).systemMemoryId) ?? null;
  }
  return { agent: await chatHomeAgentIfReachable(db, memory, agent, caller), deletedAgentId };
}
