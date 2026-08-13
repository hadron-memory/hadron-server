/**
 * #950 — data fix for personas minted before createTeamPersona set their
 * metadata correctly.
 *
 * Two values were wrong on every persona minted by #935/PR #936, and neither
 * is caller-settable, so the code fix alone leaves the existing roster wrong:
 *
 *   1. `visibility` defaulted to PERSONAL. For a persona installed into an
 *      ORG-owned team App that is backwards — the roster is the team's shared
 *      view of who is on it (`cor:agt:020:01`), and a PERSONAL Agent is
 *      owner-only, so teammates cannot see their teammates.
 *   2. `description` was copied verbatim from the role node, which legitimately
 *      describes the role-definition ARTIFACT ("Role definition + name register
 *      for …"). Every persona of a role also ended up identical.
 *
 * The description rewrite is EVIDENCE-BASED: it only fires when the persona's
 * current description still equals the role node's own description (the
 * fingerprint of the copy bug). A description someone has since edited by hand
 * is left alone — a backfill that overwrites deliberate content is worse than
 * one that skips a row.
 *
 * Encrypted system memories are skipped, not guessed at: reading the role node
 * needs an active session key (spec 041), which a batch job does not have.
 */
import type { PrismaClient } from '../generated/prisma/index.js';

/** What the sweep decided for one persona Agent. */
export interface PersonaRepairPlan {
  agentId: string;
  agentUrn: string;
  personaRole: string;
  /** Non-null when visibility should change (org-owned personas only). */
  visibility?: { from: string; to: string };
  /** Non-null when the description is a verbatim copy of the role node's. */
  description?: { from: string; to: string };
  /** Set when the role node could not be read (encrypted / not found). */
  note?: string;
}

/**
 * Synthesized persona description — must stay in step with
 * `composePersonaDescription` in resolvers.mutation.teamPersona.ts (the mint
 * path). Kept as a separate small function rather than imported from the
 * resolver module so this admin sweep doesn't pull the whole GraphQL layer in.
 */
export function synthesizePersonaDescription(
  roleData: unknown,
  name: string,
  role: string,
): string {
  const template = (roleData as { personaDescription?: unknown } | null)?.personaDescription;
  if (typeof template === 'string' && template.trim() !== '') {
    return template.split('{{name}}').join(name).split('{{role}}').join(role);
  }
  return `AI coding agent using ${role} role`;
}

/**
 * Locate the `roles:<role>` node that a persona was minted from, by walking
 * the Apps the persona is installed in and looking at each OTHER installed
 * agent's system memory — the same marker createTeamPersona locates the Team
 * Agent by. Returns null when no role node is reachable (a detached persona,
 * or an encrypted system memory).
 */
async function findRoleNode(
  db: PrismaClient,
  agentId: string,
  role: string,
): Promise<{ description: string | null; data: unknown; encrypted: boolean } | null> {
  const apps = await db.appAgent.findMany({ where: { agentId }, select: { appId: true } });
  if (apps.length === 0) return null;
  const siblings = await db.appAgent.findMany({
    where: { appId: { in: apps.map((a) => a.appId) }, agentId: { not: agentId } },
    select: { agent: { select: { systemMemoryId: true, deletedAt: true } } },
  });
  const memoryIds = [
    ...new Set(
      siblings
        .map((s) => s.agent)
        .filter((a): a is { systemMemoryId: string; deletedAt: Date | null } =>
          !!a && !a.deletedAt && !!a.systemMemoryId)
        .map((a) => a.systemMemoryId),
    ),
  ];
  if (memoryIds.length === 0) return null;
  const node = await db.node.findFirst({
    // loc-scope-ok: memory-scoped by construction — the candidate set is the
    // system memories of the agents installed alongside this persona.
    where: { loc: `roles:${role}`, deletedAt: null, memoryId: { in: memoryIds } },
    select: { description: true, data: true, memory: { select: { isEncrypted: true } } },
  });
  if (!node) return null;
  return {
    description: node.description,
    data: node.data,
    encrypted: node.memory?.isEncrypted === true,
  };
}

/**
 * Plan the repair for every persona Agent (`personaRole IS NOT NULL`). Pure
 * read — `applyPersonaRepairs` performs the writes.
 */
export async function planPersonaRepairs(db: PrismaClient): Promise<PersonaRepairPlan[]> {
  const personas = await db.agent.findMany({
    where: { deletedAt: null, personaRole: { not: null } },
    select: {
      id: true,
      urn: true,
      name: true,
      description: true,
      visibility: true,
      personaName: true,
      personaRole: true,
      organizationId: true,
      ownerUserId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const plans: PersonaRepairPlan[] = [];
  for (const p of personas) {
    const plan: PersonaRepairPlan = {
      agentId: p.id,
      agentUrn: p.urn,
      personaRole: p.personaRole!,
    };
    // Visibility: only an ORG-owned persona changes. A user-owned Agent must
    // stay PERSONAL (spec 047 — createAgentCore/updateAgent both refuse
    // anything else), and a PUBLIC persona was a deliberate act.
    if (p.organizationId !== null && p.visibility === 'PERSONAL') {
      plan.visibility = { from: p.visibility, to: 'ORGANIZATION' };
    }
    const roleNode = await findRoleNode(db, p.id, p.personaRole!);
    if (!roleNode) {
      plan.note = 'role node not reachable — description left as is';
    } else if (roleNode.encrypted) {
      plan.note = 'role node lives in an encrypted memory — description left as is';
    } else if (p.description && p.description === roleNode.description) {
      plan.description = {
        from: p.description,
        to: synthesizePersonaDescription(
          roleNode.data,
          p.personaName ?? p.name,
          p.personaRole!,
        ),
      };
    }
    if (plan.visibility || plan.description || plan.note) plans.push(plan);
  }
  return plans;
}

/** Apply a set of plans. Returns the number of Agent rows actually written. */
export async function applyPersonaRepairs(
  db: PrismaClient,
  plans: PersonaRepairPlan[],
  opts: { actorId?: string | null } = {},
): Promise<number> {
  let written = 0;
  for (const plan of plans) {
    if (!plan.visibility && !plan.description) continue;
    await db.agent.update({
      where: { id: plan.agentId },
      data: {
        ...(plan.visibility ? { visibility: plan.visibility.to as 'ORGANIZATION' } : {}),
        ...(plan.description ? { description: plan.description.to } : {}),
        updatedBy: opts.actorId ?? null,
      },
    });
    written += 1;
  }
  return written;
}
