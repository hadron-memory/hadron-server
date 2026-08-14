// Team-boundness gates (#974 — spec cor:agt:020:01/:02).
//
// Two rules, each with more than one enforcement site, live here so the sites
// cannot drift apart (PR #975 review — the founding-agent guard, the roster
// install gate, and the cascade-install path had each restated the first rule,
// and two of the three App-reclaim paths had restated the second):
//
//   1. A team-bound Agent belongs to EXACTLY ONE App. The predicate is
//      `teamAppId`, NOT `personaName` — see assertAgentNotTeamBound.
//   2. A team App with personas never has its slug recycled, because a persona
//      name is reserved forever (cor:agt:020:02) and a persona's derived slug
//      spells its team's slug.
import { GraphQLError } from 'graphql';

/** The columns every team-boundness decision reads. */
export type TeamBoundAgent = {
  id: string;
  personaName: string | null;
  teamAppId: string | null;
};

/** Minimal Prisma surface these guards need — the client or a tx client. */
type AgentCounter = { agent: { count: (args: { where: Record<string, unknown> }) => Promise<number> } };

/**
 * Refuse to attach a team-bound Agent to an App that isn't its own team
 * (cor:agt:020:01). Pass `targetAppId: null` when the App does not exist yet —
 * founding a NEW App with a team-bound Agent is always a refusal.
 *
 * The predicate is `teamAppId`, deliberately not `personaName`. Testing the
 * name left a hole (PR #975 review, codex): clearing `personaName` via
 * updateAgent leaves `teamAppId` in place, so the agent stopped looking like a
 * persona to a name-based guard, could be installed into or found a second App,
 * and then had its name restored — a persona on two rosters, which is exactly
 * what team-scoped name uniqueness assumes cannot happen. An Agent that carries
 * a team binding is spoken for whether or not it currently wears the name.
 */
export function assertAgentNotTeamBound(
  agent: TeamBoundAgent,
  targetAppId: string | null,
  context: { appId?: string | null } = {},
): void {
  if (agent.teamAppId === null) return;
  if (targetAppId !== null && agent.teamAppId === targetAppId) return;
  const subject = agent.personaName ?? 'This agent';
  throw new GraphQLError(
    `${subject} is bound to its own team App and cannot join another — a persona belongs to exactly one team (cor:agt:020:01).` +
      (agent.personaName === null
        ? ' Its persona name is cleared, but the binding (and its reserved name) survives.'
        : ''),
    {
      extensions: {
        code: 'PERSONA_TEAM_BOUND',
        agentId: agent.id,
        teamAppId: agent.teamAppId,
        ...(context.appId !== undefined ? { appId: context.appId } : {}),
      },
    },
  );
}

/**
 * Refuse an operation that would recycle or orphan a team App's slug while it
 * still has personas (cor:agt:020:02 — a persona name is never recycled, and a
 * persona's derived slug `<team-app-slug>.<persona-name>` spells that slug).
 *
 * Two callers, both destructive in the same way:
 *   - hard-deleting a soft-deleted App to reuse its URN. `Agent.teamAppId` is
 *     `onDelete: Cascade`, so the delete would take the personas with it and
 *     release their names silently.
 *   - renaming a team App. The personas keep URNs spelling the OLD slug while
 *     that slug goes back on the market; a new App there, minting the same
 *     name, would derive an already-occupied compound (PR #975 review — both
 *     bots, independently).
 */
export async function assertNoTeamPersonas(
  db: AgentCounter,
  appId: string,
  appUrn: string,
  action: 'reclaim' | 'rename',
): Promise<void> {
  const personaCount = await db.agent.count({
    where: { teamAppId: appId, personaName: { not: null } },
  });
  if (personaCount === 0) return;
  const why =
    action === 'reclaim'
      ? `URN "${appUrn}" is reserved by a retired team App with ${personaCount} persona(s) — their names are never recycled (cor:agt:020:02). Pick a different slug.`
      : `This team App has ${personaCount} persona(s) whose agent slugs are derived from its current slug, so it cannot be renamed (cor:agt:020:02) — the old slug would be freed for reuse while those personas still spell it.`;
  throw new GraphQLError(why, { extensions: { code: 'PERSONA_TEAM_BOUND', appId } });
}
