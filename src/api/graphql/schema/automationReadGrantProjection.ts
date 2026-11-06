/** #3275: shared data-only projection; each caller retains its own target-visibility gate. */
import type { AppAutomationReadGrant } from '../../../generated/prisma/index.js';
import { safeCanonicalUrn } from './resolvers.helpers.js';

export function projectAutomationReadGrant(row: AppAutomationReadGrant, memory: { urn: string } | null) {
  return {
    id: row.id, appId: row.appId, triggerKind: row.triggerKind, triggerId: row.triggerId,
    memoryUrn: memory ? safeCanonicalUrn('memory', memory.urn) : null,
    prefix: row.prefix, grantedBy: row.grantedBy,
    createdAt: row.createdAt, revokedAt: row.revokedAt, revokedBy: row.revokedBy,
  };
}
