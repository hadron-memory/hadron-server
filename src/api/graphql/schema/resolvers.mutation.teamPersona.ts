// createTeamPersona — #935: server-side persona instantiation (spec
// cor:agt:020:01/:02/:06). Role templates + the name register live as CONTENT
// in the Team Agent's system memory; this operation reads them, allocates a
// name against the personaName uniqueness constraint (the allocation primitive
// — no lease, no lock), creates the persona Agent through the shared
// createAgentCore (no behavior fork on persona fields), and installs it into
// the team App so a minted persona is on the roster immediately.
//
// #974 re-scoped all three of those to the TEAM App: the minted Agent carries
// `teamAppId`, its name only has to be free within that team, and its slug is
// derived as `<team-app-slug>.<persona-name>` — the platform's only dotted
// agent slug. This is therefore the ONE place a persona can come into being
// (createAgent refuses personaName), and the one writer of dotted slugs.
//
// Node shape (#935 — adopted into cor:agt:020:01's volatile section on merge):
//   roles:<role>  in the Team Agent's system memory
//     content     — the persona prompt template; {{name}} / {{role}}
//                   placeholders are substituted at mint time
//     data.names  — the name register: an ordered array of strings, tried
//                   first-to-last
//     data.personaDescription (optional, #950) — template for the minted
//                   Agent's `description`, same placeholders. The node's OWN
//                   `description` is never copied onto the persona: it
//                   describes the role-definition artifact, not the persona.
import { GraphQLError } from 'graphql';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { normalizeHandleOrNull } from '../../../lib/userHandle.js';
import {
  getMemoryEncryptionInfo,
  decryptNodeFields,
} from '../../../lib/nodeCrypto.js';
import { type Context, requireOrgRole, isNonReaderAppMember } from './resolvers.helpers.js';
import {
  applyPersonaTemplate,
  composePersonaDescription,
} from '../../../lib/personaDescription.js';
import { createAgentCore } from './resolvers.mutation.agent.js';
import { derivePersonaAgentSlug } from '../../../lib/personaSlug.js';

/** Loc prefix of the role-definition branch in a Team Agent's system memory. */
const ROLES_BRANCH_PREFIX = 'roles:';

const forbidden = (): GraphQLError =>
  new GraphQLError('You are not authorized to create a persona in this App.', {
    extensions: { code: 'FORBIDDEN' },
  });

/**
 * #935 auth lean (open question 2 — flagged for Holger in the PR): minting is
 * an everyday team act, so the bar is deliberately below createAgent's org
 * ADMIN. May mint:
 *   - an org member with CONTRIBUTOR+ on the App's org (parity with the
 *     installAgentIntoApp gate, which this operation subsumes), or
 *   - an AppMember of the team App whose role is not (case-insensitively)
 *     'reader' — AppMember roles are free-form strings from the Team Agent's
 *     installationPolicy.memberRoles, so 'reader' is the one conventional
 *     read-only spelling this gate recognizes, or
 *   - the owner of a user-owned team App (strictly owner-only, spec 047).
 *
 * Principal shapes (findings:auth-appid-credential-vs-selection): a PURE
 * App-key principal (appId, no userId) is DENIED — persona minting is a human
 * act and the created org-owned Agent needs a human creator; note the
 * installAgentIntoApp org-role gate denies App-key callers today too. A
 * hybrid user+selection principal is judged solely on the USER's own rights;
 * auth.appId (a selection, not a credential) grants nothing.
 */
async function requireTeamPersonaMintAccess(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
): Promise<void> {
  // Impersonation sessions are read-only support views — never mint.
  if (ctx.impersonation) throw forbidden();
  if (!ctx.userId) throw forbidden();
  if (app.ownerUserId !== null) {
    // spec 047: user-owned entities are strictly owner-only (no platform-admin
    // bypass, no org path) — findings:org-xor-owner-null-comparison-bypass:
    // branch on the ownership class BEFORE comparing owner columns.
    if (ctx.userId === app.ownerUserId) return;
    throw forbidden();
  }
  if (app.organizationId !== null) {
    try {
      await requireOrgRole(ctx, app.organizationId, 'CONTRIBUTOR');
      return;
    } catch {
      // fall through to the AppMember path
    }
    // #952 extracted the 'reader' rule to one predicate, shared with
    // installAgentIntoAppCore, so the two roster-write gates can't drift on
    // what counts as read-only membership.
    if (await isNonReaderAppMember(ctx, app)) return;
  }
  throw forbidden();
}

type TeamAgentRow = {
  id: string;
  name: string;
  urn: string;
  systemMemoryId: string | null;
};

/**
 * Locate the Team Agent (#935 open question 1 — the marker default): with no
 * explicit teamAgentRef, the Team Agent is the SINGLE installed Agent whose
 * system memory carries a roles: branch — the marker makes the App
 * self-describing. Zero markers or two-plus markers are typed refusals, never
 * a guess.
 */
export async function locateTeamAgent(
  ctx: Context,
  appId: string,
  teamAgentRef: string | null | undefined,
): Promise<TeamAgentRow> {
  if (teamAgentRef) {
    const { id } = await resolveAgentRef(ctx.db, teamAgentRef);
    // The explicit ref must name an agent INSTALLED in this App — otherwise
    // the operation would read role templates (and mint against a register)
    // from an agent the team App never adopted.
    const row = await ctx.db.appAgent.findUnique({
      where: { appId_agentId: { appId, agentId: id } },
      select: { agent: { select: { id: true, name: true, urn: true, systemMemoryId: true } } },
    });
    if (!row) {
      throw new GraphQLError('teamAgentRef must name an Agent installed in this App.', {
        extensions: { code: 'TEAM_AGENT_NOT_INSTALLED', appId, agentId: id },
      });
    }
    return row.agent;
  }
  const installed = await ctx.db.appAgent.findMany({
    where: { appId },
    orderBy: { createdAt: 'asc' },
    select: { agent: { select: { id: true, name: true, urn: true, systemMemoryId: true, deletedAt: true } } },
  });
  const candidates: TeamAgentRow[] = [];
  for (const { agent } of installed) {
    if (!agent || agent.deletedAt || !agent.systemMemoryId) continue;
    const marker = await ctx.db.node.findFirst({
      // Memory-scoped by construction (findings:unscoped-loc-lookup-crosses-
      // memories): the loc match never leaves this agent's system memory.
      where: {
        memoryId: agent.systemMemoryId,
        deletedAt: null,
        OR: [{ loc: 'roles' }, { loc: { startsWith: ROLES_BRANCH_PREFIX } }],
      },
      select: { id: true },
    });
    if (marker) candidates.push(agent);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new GraphQLError(
      'No installed Agent in this App carries a roles: branch in its system memory, so the Team Agent cannot be inferred. Pass teamAgentRef explicitly, or add role definitions (roles:<role> nodes) to the Team Agent\'s system memory.',
      { extensions: { code: 'TEAM_AGENT_NOT_FOUND', appId } },
    );
  }
  throw new GraphQLError(
    `More than one installed Agent carries a roles: branch — pass teamAgentRef to pick one. Candidates: ${candidates
      .map((c) => `${c.name} (${c.urn})`)
      .join(', ')}.`,
    {
      extensions: {
        code: 'TEAM_AGENT_AMBIGUOUS',
        appId,
        candidates: candidates.map((c) => ({ id: c.id, name: c.name, urn: c.urn })),
      },
    },
  );
}

/**
 * Substitute {{name}} / {{role}} into the role's PROMPT template — the raw
 * role, as it has always been. (#950's description string lives in
 * `src/lib/personaDescription.ts`, shared with the backfill sweep.)
 */
const composePersonaPrompt = applyPersonaTemplate;

/**
 * #974 / cor:agt:020:06 — the ONE refusal that means "this name is spoken for
 * in this team", which the register loop advances past.
 *
 * The derived compound slug made the second refusal impossible to reach
 * legitimately: with the dot reserved (cor:urn:010:03), a persona slug can only
 * collide with another persona slug of the same (team App, name), so an
 * `AGENT_URN_TAKEN` on a mint IS a name collision — {@link asNameTaken}
 * translates it before it can escape. Pre-#974 the two codes were genuinely
 * different situations (an ordinary agent named "Iris" squatted the flat slug
 * `<org>:iris`); that leg is gone.
 */
function isNameOccupied(e: unknown): boolean {
  return e instanceof GraphQLError && e.extensions?.code === 'PERSONA_NAME_TAKEN';
}

/**
 * Translate the slug-level refusal into the name-level one for persona mints.
 * The client contract is `PERSONA_NAME_TAKEN` (cor:agt:020:02): a caller of
 * `createTeamPersona` never chose a slug, so `AGENT_URN_TAKEN` would name a
 * concept it can't act on. The holder is a persona of this team with this name
 * — including a RETIRED one, whose name stays reserved forever.
 */
function asNameTaken(e: unknown, personaName: string): unknown {
  if (!(e instanceof GraphQLError) || e.extensions?.code !== 'AGENT_URN_TAKEN') return e;
  return new GraphQLError(
    `Persona name ${JSON.stringify(personaName)} is already taken in this team (its derived agent slug ${JSON.stringify(String(e.extensions?.urn ?? ''))} is reserved) — pick another name.`,
    { extensions: { code: 'PERSONA_NAME_TAKEN', urn: e.extensions?.urn } },
  );
}

export const teamPersonaMutations = {
  /**
   * #935 — mint a team persona as a platform operation (six steps, spec
   * cor:agt:020:01/:02): resolve the team App, locate the Team Agent, read
   * the role definition from its system memory, allocate a name (caller-
   * supplied wins; else the register's next free one, retrying past
   * PERSONA_NAME_TAKEN — the constraint IS the allocation), compose
   * personaPrompt, create the Agent owned by the App's owner, and install it
   * into the App. Create + install are NOT one transaction: the install
   * failure path compensates by hard-deleting the just-minted Agent (allowed
   * by cor:agt:020:02's never-did-anything escape hatch — it cannot have any
   * history yet).
   */
  createTeamPersona: async (
    _: unknown,
    { appRef, role, teamAgentRef, name }: { appRef: string; role: string; teamAgentRef?: string | null; name?: string | null },
    ctx: Context,
  ) => {
    const roleNorm = (role ?? '').trim();
    if (roleNorm === '' || roleNorm.includes(':')) {
      throw new GraphQLError('role must be a single non-empty loc atom (no ":").', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    // cor:agt:020:02 blank-is-absent: a whitespace-only name is no name.
    const requestedName = (name ?? '').trim() || null;

    // 1. Resolve the team App (cor:api:140 — PK or URN) and gate.
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    if (app.uninstalledAt) {
      throw new GraphQLError('Cannot create a persona in an uninstalled App.', {
        extensions: { code: 'APP_UNINSTALLED', appId },
      });
    }
    await requireTeamPersonaMintAccess(ctx, app);

    // 2. Locate the Team Agent (explicit ref or the roles:-branch marker).
    const teamAgent = await locateTeamAgent(ctx, appId, teamAgentRef);
    if (!teamAgent.systemMemoryId) {
      throw new GraphQLError(
        `Team Agent ${teamAgent.name} has no system memory, so it carries no role definitions.`,
        { extensions: { code: 'PERSONA_ROLE_NOT_FOUND', role: roleNorm } },
      );
    }

    // 3. Read the role definition node (memory-scoped composite unique —
    //    findings:unscoped-loc-lookup-crosses-memories).
    const roleNode = await ctx.db.node.findUnique({
      where: {
        loc_memoryId: { loc: `${ROLES_BRANCH_PREFIX}${roleNorm}`, memoryId: teamAgent.systemMemoryId },
      },
    });
    if (!roleNode || roleNode.deletedAt) {
      const siblings = await ctx.db.node.findMany({
        where: {
          memoryId: teamAgent.systemMemoryId,
          deletedAt: null,
          loc: { startsWith: ROLES_BRANCH_PREFIX },
        },
        select: { loc: true },
        orderBy: { loc: 'asc' },
      });
      const available = siblings
        .map((s) => s.loc.slice(ROLES_BRANCH_PREFIX.length))
        .filter((l) => l !== '' && !l.includes(':'));
      throw new GraphQLError(
        `Role "${roleNorm}" is not defined in ${teamAgent.name}'s system memory (no ${ROLES_BRANCH_PREFIX}${roleNorm} node).${available.length ? ` Available roles: ${available.join(', ')}.` : ''}`,
        { extensions: { code: 'PERSONA_ROLE_NOT_FOUND', role: roleNorm, availableRoles: available } },
      );
    }
    // Encrypted system memory: decrypt with the active session key (spec 041);
    // without one, refuse with the typed SESSION_EXPIRED (the same code the
    // encrypted node mutations emit — decryptNodeFields' bare Error would
    // read INTERNAL_SERVER_ERROR on the wire).
    const memInfo = await getMemoryEncryptionInfo(ctx.db, teamAgent.systemMemoryId);
    try {
      decryptNodeFields(roleNode, memInfo);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('SESSION_EXPIRED')) {
        throw new GraphQLError(
          `SESSION_EXPIRED: memory ${memInfo.id} is encrypted but no active session key is available.`,
          { extensions: { code: 'SESSION_EXPIRED', memoryId: memInfo.id } },
        );
      }
      throw e;
    }
    // The template is used VERBATIM (intentional leading/trailing whitespace
    // survives); trim only decides blankness.
    const template = typeof roleNode.content === 'string' ? roleNode.content : '';
    if (template.trim() === '') {
      throw new GraphQLError(
        `Role "${roleNorm}" has no prompt template — the ${ROLES_BRANCH_PREFIX}${roleNorm} node's content is empty.`,
        { extensions: { code: 'PERSONA_ROLE_INVALID', role: roleNorm } },
      );
    }
    // Register order is the allocation order (first-to-last), and on a
    // case-insensitive duplicate the FIRST spelling wins.
    const rawNames = (roleNode.data as { names?: unknown } | null)?.names;
    const register: string[] = [];
    if (Array.isArray(rawNames)) {
      const seen = new Set<string>();
      for (const raw of rawNames) {
        if (typeof raw !== 'string') continue;
        const trimmed = raw.trim();
        if (trimmed === '' || seen.has(trimmed.toLowerCase())) continue;
        seen.add(trimmed.toLowerCase());
        register.push(trimmed);
      }
    }

    // 4. Owner + URN namespace: the minted persona is owned by the App's
    //    owner (org XOR user), like every entity the App provisions.
    let namespace: string;
    if (app.organizationId !== null) {
      const org = await ctx.db.organization.findUniqueOrThrow({
        where: { id: app.organizationId },
        select: { urn: true },
      });
      namespace = org.urn;
    } else {
      const owner = await ctx.db.user.findUniqueOrThrow({
        where: { id: app.ownerUserId! },
        select: { handle: true },
      });
      const handle = normalizeHandleOrNull(owner.handle);
      if (!handle) {
        throw new GraphQLError(
          'The App owner needs a valid handle before a user-owned persona can be created.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      namespace = handle;
    }

    // 5. Allocate + create. Caller-supplied name: one attempt, the typed
    //    refusal IS the answer (cor:agt:020:02). Register mode: walk the
    //    pool relying on the uniqueness constraint as the atomic primitive —
    //    a P2002-mapped PERSONA_NAME_TAKEN advances to the next name. #974
    //    dropped the AGENT_URN_TAKEN advance leg: the derived compound slug
    //    is collision-free by construction (cor:agt:020:06), so a slug-level
    //    refusal can only BE a name collision and is translated as one.
    const candidates = requestedName ? [requestedName] : register;
    if (candidates.length === 0) {
      throw new GraphQLError(
        `The name register for role "${roleNorm}" is empty — add names to the ${ROLES_BRANCH_PREFIX}${roleNorm} node's data.names, or pass an explicit name.`,
        { extensions: { code: 'PERSONA_REGISTER_EXHAUSTED', role: roleNorm } },
      );
    }
    // #950: the roster is the team's shared view of who is on it
    // (cor:agt:020:01 — "the AppAgent join is the roster"), so a persona in an
    // ORG-owned team App is ORGANIZATION-visible; PERSONAL would make every
    // teammate's persona invisible to the others. A user-owned team App stays
    // PERSONAL — spec 047 keeps a user-owned agent owner-only, and
    // createAgentCore refuses anything else.
    const personaVisibility = app.ownerUserId !== null ? 'PERSONAL' : 'ORGANIZATION';
    let created: Awaited<ReturnType<typeof createAgentCore>> | null = null;
    for (const candidate of candidates) {
      try {
        created = await createAgentCore(ctx, {
          organizationId: app.organizationId,
          ownerUserId: app.ownerUserId,
          namespace,
          name: candidate,
          // #974 / cor:agt:020:06: the slug is DERIVED, never chosen —
          // `<team-app-slug>.<persona-name-slug>`, the platform's only dotted
          // agent slug. Two teams may each mint an Iris; their slugs differ by
          // construction, so nothing here retries a slug.
          slug: derivePersonaAgentSlug(app.urn, candidate),
          description: composePersonaDescription(roleNode.data, candidate, roleNorm),
          visibility: personaVisibility,
          personaName: candidate,
          personaRole: roleNorm,
          personaPrompt: composePersonaPrompt(template, candidate, roleNorm),
          // #974 / cor:agt:020:01: the persona's home team, fixed at mint —
          // the scope of its name's uniqueness and of the slug prefix above.
          teamAppId: appId,
        });
        break;
      } catch (e) {
        const refusal = asNameTaken(e, candidate);
        if (!requestedName && isNameOccupied(refusal)) continue;
        throw refusal;
      }
    }
    if (!created) {
      throw new GraphQLError(
        `Every name in the register for role "${roleNorm}" is taken (${candidates.length} tried). Add names to the ${ROLES_BRANCH_PREFIX}${roleNorm} node's data.names, or pass an explicit name.`,
        { extensions: { code: 'PERSONA_REGISTER_EXHAUSTED', role: roleNorm, namesTried: candidates.length } },
      );
    }

    // 6. Install into the team App so the minted persona is on the roster
    //    immediately. Same-org grant parity with installAgentIntoAppCore; a
    //    user-owned App installing its owner's own agent needs no
    //    subscription (ownership licenses it). On failure, compensate by
    //    hard-deleting the just-minted Agent + its system memory — it has no
    //    history yet, so this is exactly cor:agt:020:02's escape hatch.
    try {
      if (app.organizationId !== null) {
        await ensureAgentOrgGrant(ctx.db, app.organizationId, created.id, {
          createdBy: ctx.userId ?? null,
        });
      }
      await ctx.db.appAgent.create({
        data: {
          appId,
          agentId: created.id,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });
    } catch (e) {
      const sysMemId = created.systemMemoryId;
      await ctx.db.agent.delete({ where: { id: created.id } }).catch((err) => {
        console.warn('[createTeamPersona] compensation failed (agent):', err);
      });
      if (sysMemId) {
        await ctx.db.memory.delete({ where: { id: sysMemId } }).catch((err) => {
          console.warn('[createTeamPersona] compensation failed (system memory):', err);
        });
      }
      throw e;
    }

    return created;
  },
};
