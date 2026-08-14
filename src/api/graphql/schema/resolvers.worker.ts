// Workers — #974 (re-cut): the named casting of an installed Agent into an
// App (cor:dmo:050:11, cor:agt:020:01/:02). A persona is universal DRESSING on
// an Agent (`personaRole` + the `personaPrompt` template); the Worker is the
// local named identity ("Iris") that does attributable work. `castWorker`
// supersedes `createTeamPersona`'s minting semantics: it no longer mints an
// Agent at all — it casts an EXISTING installed agent under a name, allocating
// that name against the `workers_app_name_uniq` constraint (the allocation
// primitive — no lease, no lock; cor:agt:020:02).
//
// Cast lists stay ergonomics, never gates (cor:agt:020:01): role definitions
// and name registers remain CONTENT in the Team Agent's system memory
// (`roles:<role>` nodes, `data.names`), read at CASTING time — and only when
// the caller names no explicit worker name. Casting with an explicit name
// needs no Team Agent at all.
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { deriveSlugFromName, normalizeUrnForLookup } from '../../../lib/urn.js';
import {
  getMemoryEncryptionInfo,
  decryptNodeFields,
} from '../../../lib/nodeCrypto.js';
import { applyPersonaTemplate } from '../../../lib/personaDescription.js';
import { resolveMemoryRoot } from './chat-scope.js';
import { mentionTokenOf } from '../../../lib/mentionToken.js';
import {
  type Context,
  requireOrgRole,
  requireOwnerOrOrgRole,
  isAppParticipant,
  isNonReaderAppMember,
  clampListTake,
} from './resolvers.helpers.js';

/** Loc prefix of the role-definition branch in a Team Agent's system memory. */
const ROLES_BRANCH_PREFIX = 'roles:';

type AppRow = {
  id: string;
  name: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  uninstalledAt: Date | null;
};

const forbidden = (): GraphQLError =>
  new GraphQLError('You are not authorized to manage workers in this App.', {
    extensions: { code: 'FORBIDDEN' },
  });

/**
 * Staffing gate (inherited from #935's persona-mint lean): casting, retiring,
 * and hard-deleting a Worker are everyday team acts, so the bar sits below
 * org ADMIN. May staff:
 *   - an org member with CONTRIBUTOR+ on the App's org,
 *   - an AppMember of the App whose role is not (case-insensitively)
 *     'reader' (#952's shared predicate), or
 *   - the owner of a user-owned App (strictly owner-only, spec 047).
 *
 * Principal shapes (findings:auth-appid-credential-vs-selection): a PURE
 * App-key principal (appId, no userId) is DENIED — staffing is a human act.
 * A hybrid user+selection principal is judged solely on the USER's own
 * rights. Impersonation sessions are read-only support views — never staff.
 */
async function requireWorkerStaffAccess(ctx: Context, app: AppRow): Promise<void> {
  if (ctx.impersonation) throw forbidden();
  if (!ctx.userId) throw forbidden();
  if (app.ownerUserId !== null) {
    // spec 047: user-owned entities are strictly owner-only —
    // findings:org-xor-owner-null-comparison-bypass: branch on the ownership
    // class BEFORE comparing owner columns.
    if (ctx.userId === app.ownerUserId) return;
    throw forbidden();
  }
  if (app.organizationId !== null) {
    try {
      await requireOrgRole(ctx, app.organizationId, 'CONTRIBUTOR');
      return;
    } catch (e) {
      // requireOrgRole signals denial with a plain Error('Forbidden'); anything
      // else (a DB failure inside the membership lookup) must propagate rather
      // than read as "not a member" (review:narrow-catch-blocks).
      if (!(e instanceof Error && e.message === 'Forbidden')) throw e;
      // fall through to the AppMember path
    }
    if (await isNonReaderAppMember(ctx, app)) return;
  }
  throw forbidden();
}

/**
 * Read gate for the staff list (mirrors requireTeamChatAccess's 'read' mode —
 * cor:acl:030:01's audience): an AppMember at ANY role, org CONTRIBUTOR+, or
 * the owner of a user-owned App. A pure App-key principal may read its OWN
 * App's staff (team automation follows the roster); impersonation reads are
 * bounded to the support session's single org (#876 class).
 */
async function requireWorkerReadAccess(ctx: Context, app: AppRow): Promise<void> {
  if (ctx.impersonation) {
    if (app.organizationId === null || app.organizationId !== ctx.impersonation.orgId) {
      throw forbidden();
    }
  }
  if (!ctx.userId) {
    if (ctx.appId && ctx.appId === app.id) return;
    throw forbidden();
  }
  if (await isAppParticipant(ctx, app)) return;
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
 * a guess. Also used by the team-chat and worklog bootstraps.
 */
export async function locateTeamAgent(
  ctx: Context,
  appId: string,
  teamAgentRef: string | null | undefined,
): Promise<TeamAgentRow> {
  if (teamAgentRef) {
    const { id } = await resolveAgentRef(ctx.db, teamAgentRef);
    // The explicit ref must name an agent INSTALLED in this App — otherwise
    // the operation would read cast lists (and allocate against a register)
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

type WorkerRow = {
  id: string;
  appId: string;
  agentId: string;
  name: string;
  role: string | null;
  promptOverride: string | null;
  memoryId: string | null;
  retiredAt: Date | null;
};

/**
 * Resolve a workerRef to its row. Workers deliberately have NO URN — names
 * never appear in slugs or URNs (cor:agt:020:02), so unlike the other
 * `resolve<Entity>Ref` helpers (cor:api:140) this accepts the PK only.
 */
async function resolveWorkerRef(ctx: Context, workerRef: string): Promise<WorkerRow> {
  const worker = await ctx.db.worker.findUnique({
    where: { id: (workerRef ?? '').trim() },
    select: {
      id: true,
      appId: true,
      agentId: true,
      name: true,
      role: true,
      promptOverride: true,
      memoryId: true,
      retiredAt: true,
    },
  });
  if (!worker) {
    throw new GraphQLError('Worker not found.', {
      extensions: { code: 'WORKER_NOT_FOUND', workerRef },
    });
  }
  return worker;
}

/**
 * True when the refusal is one of the two per-App name uniques: the display
 * name itself (`workers_app_name_uniq`) or its MENTION TOKEN
 * (`workers_app_mention_token_uniq`, PR #978 review — Copilot). Both mean the
 * same thing to an allocator — this name's slot is occupied — so both are the
 * register loop's advance signal.
 */
function isNameTaken(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2002' &&
    /workers_app_name_uniq|workers_app_mention_token_uniq|app_id.*name|name/i.test(
      String(e.meta?.target ?? e.message),
    )
  );
}

/**
 * True when the refusal came from the mention-token unique specifically.
 *
 * Matches on `regexp_replace`, not on the index NAME: for an index Prisma
 * doesn't know about, P2002's `meta.target` carries the index EXPRESSION, not
 * its name — `["app_id", "regexp_replace(regexp_replace(...lower(name)", …]`
 * here versus `["app_id", "lower(name)"]` for `workers_app_name_uniq`. The two
 * are distinguishable, but only on the expression.
 */
function isMentionTokenTaken(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2002' &&
    /regexp_replace|workers_app_mention_token_uniq/i.test(String(e.meta?.target ?? e.message))
  );
}

/** The typed WORKER_NAME_TAKEN refusal — the allocation contract's advance
 *  signal (cor:agt:020:02). A token collision says so explicitly: the caller's
 *  name is NOT literally taken, and without the reason "Mary-Jane is taken"
 *  reads like a server bug when the roster only shows "Mary Jane". */
function nameTaken(name: string, appId: string, viaMentionToken = false): GraphQLError {
  return new GraphQLError(
    viaMentionToken
      ? `Worker name ${JSON.stringify(name)} resolves to the same @mention as a worker already cast in this App (@${mentionTokenOf(name) ?? ''}) — mentions must address exactly one worker, so pick a name that differs by more than punctuation.`
      : `Worker name ${JSON.stringify(name)} is already taken in this App — a name binds to one casting forever, so pick another.`,
    { extensions: { code: 'WORKER_NAME_TAKEN', name, appId } },
  );
}

/**
 * Read the name register from the Team Agent's `roles:<role>` node
 * (`data.names`, ordered, first spelling wins on a case-insensitive dupe).
 * The node's CONTENT (the old prompt template) is no longer read: the persona
 * prompt lives on the role-agent as dressing (cor:agt:020:01).
 */
async function readNameRegister(
  ctx: Context,
  appId: string,
  role: string,
  teamAgentRef: string | null | undefined,
): Promise<string[]> {
  const teamAgent = await locateTeamAgent(ctx, appId, teamAgentRef);
  if (!teamAgent.systemMemoryId) {
    throw new GraphQLError(
      `Team Agent ${teamAgent.name} has no system memory, so it carries no cast list.`,
      { extensions: { code: 'WORKER_ROLE_NOT_FOUND', role } },
    );
  }
  // Memory-scoped composite unique (findings:unscoped-loc-lookup-crosses-memories).
  const roleNode = await ctx.db.node.findUnique({
    where: {
      loc_memoryId: { loc: `${ROLES_BRANCH_PREFIX}${role}`, memoryId: teamAgent.systemMemoryId },
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
      `Role "${role}" is not defined in ${teamAgent.name}'s system memory (no ${ROLES_BRANCH_PREFIX}${role} node).${available.length ? ` Available roles: ${available.join(', ')}.` : ''}`,
      { extensions: { code: 'WORKER_ROLE_NOT_FOUND', role, availableRoles: available } },
    );
  }
  // Encrypted system memory: `data` (where the register lives) is ciphertext
  // without the active session key (spec 041) — refuse with the typed
  // SESSION_EXPIRED the encrypted node mutations emit.
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
  return register;
}

const MINT_RETRY_LIMIT = 3;

/**
 * Provision the Worker's casting-scoped working memory in the App's container
 * (cor:agt:020:01) — best-effort AFTER the casting exists: a failed provision
 * leaves `Worker.memoryId` null (the spec allows lazy provisioning) rather
 * than failing or compensating the cast. Identity is the `Worker.memoryId`
 * COLUMN, never the URN string (#723 / findings:shared-memory-identity-is-a-
 * column), so the urn is minted FLAT (`<root>:<app-slug>-<worker-slug>`,
 * aliased on collision) like every other memory — a multi-atom slug would
 * break node-URN round-tripping and 404 every portal link (the #723 lesson;
 * the slug convention is tunable per cor:agt:020:01).
 */
async function provisionWorkerMemory(
  ctx: Context,
  app: AppRow,
  worker: { id: string; name: string },
): Promise<string | null> {
  try {
    const appSlug = normalizeUrnForLookup(app.urn).split(':').pop() ?? app.urn;
    const workerSlug = deriveSlugFromName(worker.name);
    const root = await resolveMemoryRoot(ctx.db, {
      organizationId: app.organizationId,
      ownerUserId: app.ownerUserId,
      appUrn: app.urn,
    });
    for (let attempt = 0; ; attempt++) {
      const urn = await mintMemoryUrnV2(ctx.db, {
        root,
        desiredSlug: `${appSlug}-${workerSlug}`,
        authorRoot: worker.id.slice(0, 8),
      });
      try {
        // Memory create + Worker.memoryId attach in ONE transaction (PR #978
        // review — Copilot): a concurrent deleteWorker can observe
        // `memoryId: null`, hard-delete the never-used casting, and land the
        // worker.update on a vanished row — the rollback then takes the
        // just-created memory with it instead of leaving a permanent orphan.
        return await ctx.db.$transaction(async (tx) => {
          const created = await tx.memory.create({
            data: {
              organizationId: app.organizationId,
              // Owner XOR (`chk_memory_owner_xor`): follows the App's owner.
              ownerUserId: app.organizationId === null ? app.ownerUserId : null,
              urn,
              name: `${app.name} — ${worker.name} — working memory`,
              class: 'app',
              // 035-visibility-enum-cleanup: app-class visibility is NULL.
              visibility: null,
              appId: app.id,
              userId: null,
              createdBy: ctx.userId ?? null,
            },
            select: { id: true },
          });
          await tx.worker.update({
            where: { id: worker.id },
            data: { memoryId: created.id },
          });
          return created.id;
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
          throw err;
        }
        // A urn clash — mint again and alias around the winner. Bounded so a
        // genuinely unwinnable clash surfaces rather than spinning.
        if (attempt >= MINT_RETRY_LIMIT) throw err;
      }
    }
  } catch (err) {
    console.warn(
      `[castWorker] working-memory provisioning failed for worker ${worker.id} — left for lazy provisioning:`,
      err,
    );
    return null;
  }
}

export const workerMutations = {
  /**
   * castWorker — #974 (cor:dmo:050:11): cast an installed agent into the App
   * under a name. Opt-in, never requires a Team Agent (an explicit name skips
   * the register entirely); multiple castings of one agent per App are legal
   * (Iris and Henry, both `backend-engineer`). The agent must be installed in
   * the App AT CAST TIME; the Worker row survives a later uninstall
   * (cor:agt:020:02 — the name binds forever).
   *
   * Agent resolution: an explicit agentRef must be installed here; with no
   * agentRef the role picks it — the single installed, non-deleted agent
   * whose `personaRole` dressing equals the requested role (zero or two-plus
   * matches are typed refusals, never a guess).
   *
   * Name allocation: caller-supplied wins (one attempt — the typed
   * WORKER_NAME_TAKEN refusal IS the answer); else the Team Agent's cast-list
   * register for the role is walked first-to-last, relying on the
   * `workers_app_name_uniq` constraint as the atomic allocation primitive
   * (advance on WORKER_NAME_TAKEN, exhausted register is typed).
   */
  castWorker: async (
    _: unknown,
    {
      appRef,
      agentRef,
      role,
      name,
      teamAgentRef,
      promptOverride,
    }: {
      appRef: string;
      agentRef?: string | null;
      role?: string | null;
      name?: string | null;
      teamAgentRef?: string | null;
      promptOverride?: string | null;
    },
    ctx: Context,
  ) => {
    const roleNorm = (role ?? '').trim() || null;
    if (roleNorm !== null && roleNorm.includes(':')) {
      throw new GraphQLError('role must be a single loc atom (no ":").', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    // cor:agt:020:02 blank-is-absent: a whitespace-only name is no name.
    const requestedName = (name ?? '').trim() || null;
    const override = (promptOverride ?? '').trim() === '' ? null : (promptOverride as string);

    // 1. Resolve the App (cor:api:140 — PK or URN) and gate.
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    if (app.uninstalledAt) {
      throw new GraphQLError('Cannot cast a worker in an uninstalled App.', {
        extensions: { code: 'APP_UNINSTALLED', appId },
      });
    }
    await requireWorkerStaffAccess(ctx, app);

    // 2. Resolve the agent being cast — installed in this App at cast time.
    let agent: { id: string; name: string; personaRole: string | null };
    if (agentRef && agentRef.trim() !== '') {
      // resolveAgentRef throws a plain AgentNotFoundError (which would read
      // INTERNAL_SERVER_ERROR on the wire) — translate to the typed refusal,
      // matching startSession's agentRef handling.
      let id: string;
      try {
        ({ id } = await resolveAgentRef(ctx.db, agentRef.trim()));
      } catch (e) {
        if (e instanceof AgentNotFoundError) {
          throw new GraphQLError(`Agent not found: ${agentRef.trim()}`, {
            extensions: { code: 'BAD_USER_INPUT' },
          });
        }
        throw e;
      }
      const row = await ctx.db.appAgent.findUnique({
        where: { appId_agentId: { appId, agentId: id } },
        select: {
          agent: { select: { id: true, name: true, personaRole: true, deletedAt: true } },
        },
      });
      if (!row || row.agent.deletedAt) {
        throw new GraphQLError(
          'agentRef must name an Agent installed in this App — casting requires the agent on the roster at cast time.',
          { extensions: { code: 'WORKER_AGENT_NOT_INSTALLED', appId, agentId: id } },
        );
      }
      agent = row.agent;
    } else {
      if (!roleNorm) {
        throw new GraphQLError('Pass agentRef, or a role that identifies the installed agent to cast.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const installed = await ctx.db.appAgent.findMany({
        where: { appId },
        orderBy: { createdAt: 'asc' },
        select: {
          agent: { select: { id: true, name: true, urn: true, personaRole: true, deletedAt: true } },
        },
      });
      // In-memory case-insensitive equality — never a LIKE-backed filter
      // (findings:prisma-string-filters-are-unescaped-like).
      const matches = installed
        .map((r) => r.agent)
        .filter(
          (a) => a && !a.deletedAt && (a.personaRole ?? '').toLowerCase() === roleNorm.toLowerCase(),
        );
      if (matches.length === 0) {
        throw new GraphQLError(
          `No installed Agent carries personaRole "${roleNorm}" — install the role-agent first, or pass agentRef.`,
          { extensions: { code: 'WORKER_AGENT_NOT_FOUND', appId, role: roleNorm } },
        );
      }
      if (matches.length > 1) {
        throw new GraphQLError(
          `More than one installed Agent carries personaRole "${roleNorm}" — pass agentRef to pick one. Candidates: ${matches
            .map((a) => `${a.name} (${a.urn})`)
            .join(', ')}.`,
          {
            extensions: {
              code: 'WORKER_AGENT_AMBIGUOUS',
              appId,
              role: roleNorm,
              candidates: matches.map((a) => ({ id: a.id, name: a.name, urn: a.urn })),
            },
          },
        );
      }
      agent = matches[0];
    }
    // The casting's role: explicit wins, else the agent's dressing.
    const workerRole = roleNorm ?? agent.personaRole ?? null;

    // 3. Name candidates: explicit, or the cast-list register for the role.
    let candidates: string[];
    if (requestedName) {
      candidates = [requestedName];
    } else {
      if (!workerRole) {
        throw new GraphQLError(
          'Pass a name, or a role whose cast-list register can allocate one.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      candidates = await readNameRegister(ctx, appId, workerRole, teamAgentRef);
      if (candidates.length === 0) {
        throw new GraphQLError(
          `The name register for role "${workerRole}" is empty — add names to the ${ROLES_BRANCH_PREFIX}${workerRole} node's data.names, or pass an explicit name.`,
          { extensions: { code: 'WORKER_REGISTER_EXHAUSTED', role: workerRole } },
        );
      }
    }

    // 4. Allocate + create: the uniqueness constraint IS the allocation
    //    primitive (cor:agt:020:02) — a P2002 on workers_app_name_uniq maps
    //    to WORKER_NAME_TAKEN; register mode advances past it.
    let created: { id: string; name: string } | null = null;
    for (const candidate of candidates) {
      try {
        created = await ctx.db.worker.create({
          data: {
            appId,
            agentId: agent.id,
            name: candidate,
            role: workerRole,
            promptOverride: override,
            createdBy: ctx.userId ?? null,
          },
          select: { id: true, name: true },
        });
        break;
      } catch (e) {
        if (isNameTaken(e)) {
          if (!requestedName) continue;
          throw nameTaken(candidate, appId, isMentionTokenTaken(e));
        }
        throw e;
      }
    }
    if (!created) {
      throw new GraphQLError(
        `Every name in the register for role "${workerRole}" is taken (${candidates.length} tried). Add names to the ${ROLES_BRANCH_PREFIX}${workerRole} node's data.names, or pass an explicit name.`,
        {
          extensions: {
            code: 'WORKER_REGISTER_EXHAUSTED',
            role: workerRole,
            namesTried: candidates.length,
          },
        },
      );
    }

    // 5. Working memory — best-effort; a failure leaves memoryId null.
    await provisionWorkerMemory(ctx, app, created);

    return ctx.db.worker.findUniqueOrThrow({ where: { id: created.id } });
  },

  /**
   * retireWorker — end the casting while reserving its name FOREVER
   * (cor:agt:020:02): a retired worker stops authoring (team chat's
   * worker-App pin checks retirement at post time) and refuses new session
   * bindings; the row — and its name reservation — survive. Idempotent: the
   * claim is guarded on `retiredAt: null`, so retiring twice (or racing
   * another retirer) returns the already-retired row unchanged.
   */
  retireWorker: async (
    _: unknown,
    { workerRef }: { workerRef: string },
    ctx: Context,
  ) => {
    const worker = await resolveWorkerRef(ctx, workerRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: worker.appId } });
    await requireWorkerStaffAccess(ctx, app);
    await ctx.db.worker.updateMany({
      where: { id: worker.id, retiredAt: null },
      data: { retiredAt: new Date(), retiredBy: ctx.userId ?? null },
    });
    return ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  },

  /**
   * deleteWorker — the ONLY removal escape (cor:dmo:050:11): the hard delete
   * of a never-used miscast. "Never did anything" is checked, not asserted:
   * no session was EVER bound (ended ones included — chat authorship and
   * worklog records both require a bound session, so zero sessions implies
   * zero references), and the working memory (if provisioned) holds no nodes
   * and no assets. Anything else is WORKER_IN_USE — retire instead.
   */
  deleteWorker: async (
    _: unknown,
    { workerRef }: { workerRef: string },
    ctx: Context,
  ) => {
    const worker = await resolveWorkerRef(ctx, workerRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: worker.appId } });
    await requireWorkerStaffAccess(ctx, app);

    const sessions = await ctx.db.session.count({ where: { workerId: worker.id } });
    if (sessions > 0) {
      throw new GraphQLError(
        'This worker has driven sessions — its name is bound to that history forever. Retire it instead.',
        { extensions: { code: 'WORKER_IN_USE', workerId: worker.id } },
      );
    }
    if (worker.memoryId) {
      const [nodes, assets] = await Promise.all([
        ctx.db.node.count({ where: { memoryId: worker.memoryId } }),
        ctx.db.asset.count({ where: { memoryId: worker.memoryId } }),
      ]);
      if (nodes > 0 || assets > 0) {
        throw new GraphQLError(
          'This worker\'s working memory holds content — it did something. Retire it instead.',
          { extensions: { code: 'WORKER_IN_USE', workerId: worker.id } },
        );
      }
    }
    // Count-then-act: SERIALIZABLE so a session binding (or memory write)
    // committing between the checks above and the delete cannot slip a
    // referenced worker through (conventions:count-then-act-serializable-txn;
    // the counts re-run inside the transaction).
    await ctx.db.$transaction(
      async (tx) => {
        const inTxSessions = await tx.session.count({ where: { workerId: worker.id } });
        if (inTxSessions > 0) {
          throw new GraphQLError(
            'This worker has driven sessions — its name is bound to that history forever. Retire it instead.',
            { extensions: { code: 'WORKER_IN_USE', workerId: worker.id } },
          );
        }
        await tx.worker.delete({ where: { id: worker.id } });
        if (worker.memoryId) {
          const nodes = await tx.node.count({ where: { memoryId: worker.memoryId } });
          const assets = await tx.asset.count({ where: { memoryId: worker.memoryId } });
          if (nodes > 0 || assets > 0) {
            throw new GraphQLError(
              'This worker\'s working memory holds content — it did something. Retire it instead.',
              { extensions: { code: 'WORKER_IN_USE', workerId: worker.id } },
            );
          }
          await tx.memory.delete({ where: { id: worker.memoryId } });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return true;
  },
};

export const workerQueries = {
  /** Read one worker (cor:api:120 find-one; PK-only ref — workers have no URN). */
  worker: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const worker = await resolveWorkerRef(ctx, ref);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: worker.appId } });
    await requireWorkerReadAccess(ctx, app);
    return ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  },

  /**
   * The App's staff list (cor:agt:020:01 — Workers are the staff; AppAgent is
   * the install roster). Retired castings are hidden by default; pass
   * includeRetired for the full historical staff.
   */
  workers: async (
    _: unknown,
    {
      appRef,
      includeRetired,
      limit,
      offset,
    }: { appRef: string; includeRetired?: boolean | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const { id: appId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
    await requireWorkerReadAccess(ctx, app);
    const where = {
      appId,
      ...(includeRetired ? {} : { retiredAt: null }),
    };
    const [items, total] = await Promise.all([
      ctx.db.worker.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: clampListTake(limit),
        skip: offset ?? 0,
      }),
      ctx.db.worker.count({ where }),
    ]);
    return { items, total };
  },
};

export const workerFieldResolvers = {
  Worker: {
    /**
     * The role-agent behind the casting — behind Query.agent's OWN read gate
     * (PUBLIC, else owner / org READER), masked to null on deny. The Worker
     * read gate is WIDER than the Agent's (App participants, App keys), and a
     * nested object hands the caller the Agent's field resolvers — systemPrompt
     * included — which assume the outer query authorized them
     * (findings:broadening-read-gate-leaks-nested-objects, #552). The
     * installed-agent read grant cannot stand in for that gate either: Worker
     * rows survive uninstall, so "a Worker exists" does not imply the grant
     * still does (PR #978 review — codex P1 + Copilot).
     */
    agent: async (worker: { agentId: string }, _: unknown, ctx: Context) => {
      const agent = await ctx.db.agent.findUnique({ where: { id: worker.agentId } });
      if (!agent || agent.deletedAt) return null;
      if (agent.visibility !== 'PUBLIC') {
        try {
          await requireOwnerOrOrgRole(ctx, agent, 'READER');
        } catch {
          return null;
        }
      }
      return agent;
    },
    /**
     * The App whose staff this casting fills — behind Query.app's OWN read
     * gate (owner / org READER), masked to null on deny: an AppMember who is
     * not an org member can read the Worker but must not reach App.keys /
     * App.members through it (the same #552 class as `agent` above).
     */
    app: async (worker: { appId: string }, _: unknown, ctx: Context) => {
      const app = await ctx.db.app.findUnique({ where: { id: worker.appId } });
      if (!app || app.deletedAt) return null;
      try {
        await requireOwnerOrOrgRole(ctx, app, 'READER');
      } catch {
        return null;
      }
      return app;
    },
    /**
     * The worker's boot prompt, resolved (cor:agt:020:01 — "how {{name}} and
     * the override compose is tunable"): the agent's `personaPrompt` template
     * with `{{name}}`/`{{role}}` bound, then the per-worker `promptOverride`
     * appended as its own paragraph. Null when the agent carries no template
     * and the worker no override.
     */
    prompt: async (
      worker: { agentId: string; name: string; role: string | null; promptOverride: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUnique({
        where: { id: worker.agentId },
        select: { personaPrompt: true, personaRole: true },
      });
      const template = agent?.personaPrompt ?? null;
      const role = worker.role ?? agent?.personaRole ?? '';
      const bound = template ? applyPersonaTemplate(template, worker.name, role) : null;
      if (bound && worker.promptOverride) return `${bound}\n\n${worker.promptOverride}`;
      return worker.promptOverride ?? bound;
    },
  },
};
