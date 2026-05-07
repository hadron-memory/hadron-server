/**
 * Class-eligibility gate for soft-delete (011-soft-delete-memory FR-003).
 *
 * Only `knowledge`-class memories are eligible for soft-delete via the
 * user-facing flow (Portal Delete button, GraphQL `deleteMemory`, MCP
 * `h-delete-memory`). The other three classes route to their own delete
 * pivots:
 *
 *   - `system` / `AGENT_SYSTEM` → delete the owning Agent instead.
 *   - `app` → bound to App.delete CASCADE; the App is the deletion pivot.
 *   - `personal` → owning user, via account deletion or a future
 *     user-driven personal-memory flow. Never via the org-admin path
 *     (Constitution Invariant 13: strict ownership).
 *
 * The legacy `Memory.type` field carries `KNOWLEDGE | AGENT_SYSTEM` from
 * before 005-agent-subscription introduced the four-class typology;
 * `Memory.class` carries the post-005 class. Both are checked: a memory
 * whose `type === 'AGENT_SYSTEM'` is treated as the protected agent-system
 * case regardless of `class` (defense in depth — pre-005 rows might still
 * exist with mismatched type/class pairings in test fixtures).
 */

import type { MemoryClass, MemoryType } from '../../generated/prisma/index.js';
import { ProtectedMemoryError } from './errors.js';

/** The minimum-shaped Memory record `assertMemoryClassDeletable` needs. */
export type ClassEligibilityInput = {
  id: string;
  type: MemoryType;
  class: MemoryClass;
};

/**
 * Throws `ProtectedMemoryError` if the memory's class is not eligible for
 * soft-delete via the user-facing flow. No-op (returns void) for
 * `knowledge`-class memories. The error's message is the FR-003
 * alternative-path text — surface it verbatim to callers.
 */
export function assertMemoryClassDeletable(memory: ClassEligibilityInput): void {
  // Existing rule preserved verbatim (resolvers.ts:2891 prior to 011).
  if (memory.type === 'AGENT_SYSTEM' || memory.class === 'system') {
    throw new ProtectedMemoryError(
      memory.id,
      'agent_system',
      'Cannot delete an agent system memory directly. Delete the owning agent instead.',
    );
  }

  if (memory.class === 'app') {
    throw new ProtectedMemoryError(
      memory.id,
      'app',
      'Cannot delete an app memory directly. The memory is removed automatically when its App is deleted.',
    );
  }

  if (memory.class === 'personal') {
    throw new ProtectedMemoryError(
      memory.id,
      'personal',
      'Cannot delete a personal memory through the org-admin path. The owning user must delete it (or it will be removed when the user account is deleted).',
    );
  }

  // class === 'knowledge' — eligible. No-op.
}
