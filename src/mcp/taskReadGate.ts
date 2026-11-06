/**
 * #1329 — task readability on the MCP write surface. A refusal's READABLE promises
 * that `hadron_get_node` loads the task, so MCP asks the gate that tool applies,
 * on the write's own transaction. GraphQL's gate is not this one: for user-backed
 * principals (holdings, shared personal memories, App-scoped own memories) the two
 * disagree (hadron-server#3519), and that memory is then concealed here, as a task
 * that does not exist would be. A database fault propagates: it never reads as
 * unreadable. Xan's ruling on #1329, 6661007376.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import type { TaskReadGate } from '../lib/authoringAttestation.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory, EXPLICIT_REF } from './access-control.js';

export function mcpReadsTask(auth: AuthContext): TaskReadGate {
  return (tx, memoryId) => canReadMemory(tx as unknown as PrismaClient, auth, memoryId, EXPLICIT_REF);
}
