/**
 * #2171 (R211, cor:dmo:050:04 "Which roles an App offers"): member roles stay
 * per Agent, an Agent's managers edit them, and an App offers the UNION of the
 * roles of its installed Agents. This file is the one place that reads that
 * union and the one place that validates an edit.
 *
 * Role strings carry no platform meaning here: nothing compares them except
 * joinApp's categorical refusal to self-grant `owner`.
 */
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** What a new Agent offers (R211). Existing Agents keep what they have; nothing backfills. */
export const DEFAULT_MEMBER_ROLES: readonly string[] = ['owner', 'member'];

export const MAX_MEMBER_ROLES = 20;
const ROLE_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;

const bad = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * Validate an edit: trim, refuse blank / malformed entries and an empty list,
 * collapse exact duplicates keeping the first position. The shape is
 * lowercase-only, so two entries differing only by case cannot both pass. An
 * invalid value is refused naming it, never coerced.
 */
export function normalizeMemberRoles(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const role = raw.trim();
    if (!ROLE_SHAPE.test(role)) {
      throw bad(
        `Invalid member role ${JSON.stringify(raw)}: use 1-32 characters, a lowercase letter first, then lowercase letters, digits, "_" or "-".`,
      );
    }
    if (!out.includes(role)) out.push(role);
  }
  if (out.length === 0) throw bad('memberRoles must name at least one role.');
  if (out.length > MAX_MEMBER_ROLES) throw bad(`memberRoles may name at most ${MAX_MEMBER_ROLES} roles.`);
  return out;
}

/** The roles an installationPolicy JSON declares; a malformed value declares none. */
export function rolesOfPolicy(policy: unknown): string[] {
  const roles = (policy as { memberRoles?: unknown } | null | undefined)?.memberRoles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

/**
 * The roles an App offers: the deduplicated union over its live installed
 * Agents, the primary (oldest install) first, then the rest by install order.
 * `installed` is false when no live Agent is installed (an orphan App).
 * An uninstall is a hard delete of the join row, so a row means installed;
 * a soft-deleted Agent offers nothing.
 */
export async function loadOfferedMemberRoles(
  db: Db,
  appId: string,
): Promise<{ installed: boolean; roles: string[] }> {
  const installs = await db.appAgent.findMany({
    where: { appId, agent: { deletedAt: null } },
    orderBy: [{ createdAt: 'asc' }, { agentId: 'asc' }],
    select: { agent: { select: { installationPolicy: true } } },
  });
  const roles: string[] = [];
  for (const i of installs) {
    for (const r of rolesOfPolicy(i.agent.installationPolicy)) if (!roles.includes(r)) roles.push(r);
  }
  return { installed: installs.length > 0, roles };
}

/**
 * Take the fences the union is decided under, inside the deciding transaction:
 * the App's install rows, then those Agents' rows, both FOR SHARE in id order.
 * An uninstall (deletes a join row) and the role editor (updates the Agent
 * row) conflict with these, so they serialize against an admission instead of
 * landing between its read and its insert. An install only widens the union
 * (an insert takes no conflicting lock), which makes a union read just before
 * it commits conservative. Order: app-capacity advisory lock (caller), then
 * join rows, then agents; the editor takes only the agent row.
 */
export async function lockOfferedMemberRoleRows(tx: Prisma.TransactionClient, appId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ agent_id: string }[]>`
    SELECT agent_id FROM app_agents WHERE app_id = ${appId} ORDER BY agent_id FOR SHARE
  `;
  const ids = rows.map((r) => r.agent_id);
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM agents WHERE id = ANY(${ids}) ORDER BY id FOR SHARE`;
}
