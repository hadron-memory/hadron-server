import type { PrismaClient } from '@prisma/client';
import type { AuthContext } from '../../middleware/auth.js';
import { canReadMemory } from '../../mcp/access-control.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';

/**
 * #4689 (cor:dmo:150:04, cor:api:060:05; Holger's ruling A, 2026-11-23): the reader of a run render's
 * foreign full-URN includes. A render is read as the caller; an executed run is read as the run principal,
 * and judged as automation adoption judges a partial (`captureAutomationPin`): the target is readable by
 * the principal, plaintext, and in the run's organization, so what runs is what was pinned. A target that
 * fails any of these is the same notice as a missing one (cor:dmo:150:05).
 *
 * The answer is per memory and kept for the render, so each target memory costs one read decision.
 */
export function foreignIncludeReader(db: PrismaClient, auth: AuthContext): (memoryId: string) => Promise<boolean> {
  const decided = new Map<string, Promise<boolean>>();
  return (memoryId) => {
    let answer = decided.get(memoryId);
    if (!answer) {
      answer = (async () => {
        if (isRunPrincipal(auth)) {
          const memory = await db.memory.findUnique({
            where: { id: memoryId },
            select: { organizationId: true, isEncrypted: true, deletedAt: true },
          });
          if (!memory || memory.deletedAt || memory.isEncrypted || memory.organizationId !== auth.organizationId) return false;
        }
        return canReadMemory(db, auth, memoryId);
      })();
      decided.set(memoryId, answer);
    }
    return answer;
  };
}
