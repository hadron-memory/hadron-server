/**
 * Publish a dependency edge from a parent Agent to an imported Agent.
 * Per spec 008-agent-installation FR-005 + research.md §R-8 (sparse-int
 * positions) + §R-2 (AgentOrgGrant as the universal Builder grant).
 *
 * Validation:
 *   1. Self-import is rejected (`parentAgentId !== importedAgentId`).
 *   2. v1 enforces 1-level imports — `importedAgentId` must not itself
 *      already be a parent of any AgentImport row. (Cycle detection beyond
 *      one level is reserved for a future spec.)
 *   3. An active `AgentOrgGrant(parentAgent.organization_id, importedAgentId)`
 *      MUST exist — the parent Agent's org needs the license to bundle
 *      the dep. Throws `MissingGrantError` otherwise.
 *   4. Position uniqueness within `(parent_agent_id, position)` is enforced
 *      by the @@unique constraint at the DB layer; collisions surface as
 *      `PositionConflictError`.
 */

import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import { isLifecycleActive } from '../../lib/lifecycle.js';

export class SelfImportError extends Error {
  constructor() {
    super('An Agent cannot import itself.');
    this.name = 'SelfImportError';
  }
}

export class MultiLevelImportError extends Error {
  constructor(importedAgentId: string) {
    super(
      `Agent ${importedAgentId} already imports other Agents. v1 supports 1-level imports only.`,
    );
    this.name = 'MultiLevelImportError';
  }
}

export class MissingGrantError extends Error {
  constructor(orgId: string, agentId: string) {
    super(
      `You don't have an active license to bundle Agent ${agentId} from Org ${orgId}. Subscribe to it first.`,
    );
    this.name = 'MissingGrantError';
  }
}

export class PositionConflictError extends Error {
  constructor(parentAgentId: string, position: number) {
    super(
      `Position ${position} is already used under parent Agent ${parentAgentId}. Pick a different position.`,
    );
    this.name = 'PositionConflictError';
  }
}

interface PublishAgentImportInput {
  parentAgentId: string;
  importedAgentId: string;
  position: number;
  required?: boolean;
  actorId?: string | null;
}

export async function publishAgentImport(
  db: PrismaClient,
  input: PublishAgentImportInput,
) {
  const { parentAgentId, importedAgentId, position, required = true, actorId = null } = input;

  // 1. Self-import.
  if (parentAgentId === importedAgentId) {
    throw new SelfImportError();
  }

  // 2. 1-level enforcement: the imported Agent must not itself be a parent.
  const importedAsParent = await db.agentImport.findFirst({
    where: { parentAgentId: importedAgentId },
  });
  if (importedAsParent) {
    throw new MultiLevelImportError(importedAgentId);
  }

  // 3. Builder grant: the parent Agent's owning org must have an active
  //    AgentOrgGrant for the imported Agent.
  const parentAgent = await db.agent.findUniqueOrThrow({
    where: { id: parentAgentId },
    select: { organizationId: true },
  });
  const grant = await db.agentOrgGrant.findUnique({
    where: {
      orgId_agentId: {
        orgId: parentAgent.organizationId,
        agentId: importedAgentId,
      },
    },
  });
  if (!grant || !isLifecycleActive(grant)) {
    throw new MissingGrantError(parentAgent.organizationId, importedAgentId);
  }

  // 4. INSERT — the @@unique([parent_agent_id, position]) constraint catches
  //    collisions; surface those as PositionConflictError. Other unique
  //    violations (the composite PK on (parent, imported)) surface as a
  //    rethrown error so callers see the underlying issue.
  try {
    return await db.agentImport.create({
      data: {
        parentAgentId,
        importedAgentId,
        position,
        required,
        agentOrgGrantOrgId: parentAgent.organizationId,
        agentOrgGrantAgentId: importedAgentId,
        createdBy: actorId,
      },
    });
  } catch (e: unknown) {
    if (
      typeof e === 'object' &&
      e !== null &&
      (e as Prisma.PrismaClientKnownRequestError).code === 'P2002'
    ) {
      // Unique violation. Determine whether it was the position constraint
      // or the PK by inspecting the meta target (Prisma surfaces field names).
      const target = ((e as Prisma.PrismaClientKnownRequestError).meta as
        | { target?: string[] }
        | undefined)?.target;
      if (target?.includes('position')) {
        throw new PositionConflictError(parentAgentId, position);
      }
    }
    throw e;
  }
}
