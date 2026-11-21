/**
 * #3275: shared data-only projection; each caller retains its own target-visibility gate.
 * #3526 (ruling 0222, cor:agt:010:01): a grant row never shows a prefix without its URN. A prefix is a node path inside the target
 * memory, so for a target the caller was not shown (`memory` null) it is withheld with the URN; a caller that passes the memory
 * (the give, revoke and list doors, for a manager of the target) still gets both.
 */
import type { AppAutomationReadGrant } from '../../../generated/prisma/index.js';
import { safeCanonicalUrn } from './resolvers.helpers.js';

export function projectAutomationReadGrant(row: AppAutomationReadGrant, memory: { urn: string } | null) {
  const memoryUrn = memory ? safeCanonicalUrn('memory', memory.urn) : null;
  return {
    id: row.id, appId: row.appId, triggerKind: row.triggerKind, triggerId: row.triggerId,
    memoryUrn,
    prefix: memoryUrn === null ? null : row.prefix, grantedBy: row.grantedBy,
    createdAt: row.createdAt, revokedAt: row.revokedAt, revokedBy: row.revokedBy,
  };
}
