import type { PrismaClient } from '../../generated/prisma/index.js';
import type { AuthContext } from '../../middleware/auth.js';
import { canReadMemory } from '../../mcp/access-control.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { isOwnedBy, ownerRefOf } from '../owner.js';

/**
 * #4689 (cor:dmo:150:04, cor:api:060:05; Holger's ruling A, 2026-11-23): the reader of a run render's
 * foreign full-URN includes. A render is read as the caller; an executed run is read as the run principal,
 * and judged as automation adoption judges a partial (`captureAutomationPin`): the target is readable by
 * the principal, plaintext, and in a memory the run's App's owner owns (#5077), so what runs is what was pinned. A target that
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
          // #5077: the run's tenant is its App's owner, an organization or a person, read from the App (a person's run
          // principal carries no organization, and `!==` between two nulls would admit another person's memory).
          const app = auth.appId
            ? await db.app.findUnique({ where: { id: auth.appId }, select: { organizationId: true, ownerUserId: true } })
            : null;
          const tenant = app ? ownerRefOf(app) : null;
          if (!tenant) return false;
          const memory = await db.memory.findUnique({
            where: { id: memoryId },
            select: { organizationId: true, ownerUserId: true, isEncrypted: true, deletedAt: true },
          });
          if (!memory || memory.deletedAt || memory.isEncrypted || !isOwnedBy(memory, tenant)) return false;
        }
        return canReadMemory(db, auth, memoryId);
      })();
      decided.set(memoryId, answer);
    }
    return answer;
  };
}
