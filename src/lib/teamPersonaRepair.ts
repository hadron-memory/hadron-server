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
 * BOTH fixes are EVIDENCE-BASED, because `personaRole IS NOT NULL` does not
 * prove `createTeamPersona` minted the row — the persona fields are settable
 * directly through createAgent/updateAgent:
 *
 *   - visibility changes only for a persona that is on a team ROSTER — installed
 *     in an App alongside a Team Agent defining `roles:<its role>`. PERSONAL →
 *     ORGANIZATION is a widening (it exposes the Agent's systemPrompt + system
 *     memory to the org), so a deliberately creator-only Agent that merely
 *     carries persona metadata must not be swept up.
 *   - description changes only where the persona's current value still equals
 *     the role node's own description (the fingerprint of the copy bug). One
 *     edited by hand since is left alone — a backfill that overwrites
 *     deliberate content is worse than one that skips a row.
 *
 * Encrypted system memories are skipped, not guessed at: reading the role node
 * needs an active session key (spec 041), which a batch job does not have.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
// The backfill writes exactly what the mint path would write — one shared
// definition rather than a second copy here (two copies with a "keep in step"
// comment is what let the role slug's hyphen diverge from #950's wording).
import { composePersonaDescription } from './personaDescription.js';

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
    const roleNode = await findRoleNode(db, p.id, p.personaRole!);
    // Visibility: only an ORG-owned persona changes, and only on EVIDENCE that
    // it came from the buggy mint path — it is installed in an App alongside a
    // Team Agent that defines `roles:<its role>`, i.e. it is on a team roster
    // (`cor:agt:020:01`). The persona fields are settable directly through
    // createAgent/updateAgent, so `personaRole IS NOT NULL` alone does not
    // imply createTeamPersona minted it, and PERSONAL → ORGANIZATION is a
    // WIDENING: it exposes the Agent's definition (systemPrompt, system
    // memory) to the whole org. A deliberately creator-only Agent that merely
    // carries persona metadata must not be caught by a data fix. (Codex P2 on
    // PR #953 — same exposure class as the #952 gate decision.)
    if (p.organizationId !== null && p.visibility === 'PERSONAL' && roleNode) {
      plan.visibility = { from: p.visibility, to: 'ORGANIZATION' };
    }
    if (!roleNode) {
      plan.note =
        'no team role definition reachable — not treated as a minted persona; left as is';
    } else if (roleNode.encrypted) {
      plan.note = 'role node lives in an encrypted memory — description left as is';
    } else if (p.description && p.description === roleNode.description) {
      plan.description = {
        from: p.description,
        to: composePersonaDescription(
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
