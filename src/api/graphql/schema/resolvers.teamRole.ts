// Team roles as a platform surface — #960 (cor:agt:020:01/:02), re-keyed by
// the Worker model (#974): a role definition is the `roles:<role>` node in the
// Team Agent's system memory, carrying the NAME REGISTER (`data.names`,
// ordered) plus the register conventions (`data.nameRange`,
// `data.nameConvention`). The persona prompt template is NOT here — it lives
// on the role-agent as dressing (`Agent.personaRole` + `personaPrompt`), which
// this surface only points at.
//
// Why this is a server surface and not a client-side join (#960): the one
// question the read exists to answer — "which names are still free?" — needs
// the App's FULL worker roster (names are unique per App, case-insensitively,
// forever — cor:agt:020:02), and a client sees only the workers it can read.
// A client-computed FREE column systematically over-reports (the
// hadron-cli#383 failure shape). The writes own the register invariants a
// client cannot check (hadron-cli#410): a minted name may never leave the
// register, a name may not appear in two of the App's registers, and sibling
// `data` keys survive every edit.
import { GraphQLError } from 'graphql';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import {
  getMemoryEncryptionInfo,
  decryptNodeFields,
} from '../../../lib/nodeCrypto.js';
import {
  locateTeamAgent,
  parseNameRegister,
  requireWorkerReadAccess,
  withRegisterLock,
  ROLES_BRANCH_PREFIX,
} from './resolvers.worker.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import {
  type Context,
  requireMemoryWriteAccess,
  requireOwnerOrOrgRole,
  clampListTake,
} from './resolvers.helpers.js';

type WorkerRosterRow = Record<string, unknown> & { name: string };

/** Case-insensitive roster index: lower(worker name) → the Worker row. */
async function loadRosterByName(
  ctx: Context,
  appId: string,
): Promise<Map<string, WorkerRosterRow>> {
  const rows = await ctx.db.worker.findMany({ where: { appId } });
  const byName = new Map<string, WorkerRosterRow>();
  for (const w of rows) {
    // The per-App unique is case-insensitive, so lower() can't collide.
    byName.set(w.name.toLowerCase(), w as WorkerRosterRow);
  }
  return byName;
}

type RoleAgentEntry = {
  /** The single installed agent whose personaRole matches, or null (zero or 2+). */
  agent: (Record<string, unknown> & { personaPrompt: string | null }) | null;
  /** How many installed agents carry the role — 2+ means castWorker would refuse ambiguous. */
  matches: number;
};

/**
 * Index the App's installed agents by lower(personaRole) — the same
 * resolution castWorker runs when the caller names a role without an
 * agentRef, so `TeamRole.roleAgent` shows exactly the agent a cast would use.
 */
async function loadRoleAgentIndex(
  ctx: Context,
  appId: string,
): Promise<Map<string, RoleAgentEntry>> {
  const installed = await ctx.db.appAgent.findMany({
    where: { appId },
    orderBy: { createdAt: 'asc' },
    select: { agent: true },
  });
  const index = new Map<string, RoleAgentEntry>();
  for (const { agent } of installed) {
    if (!agent || agent.deletedAt || !agent.personaRole) continue;
    const key = agent.personaRole.toLowerCase();
    const entry = index.get(key);
    if (!entry) {
      index.set(key, { agent: agent as RoleAgentEntry['agent'], matches: 1 });
    } else {
      entry.matches += 1;
      entry.agent = null; // ambiguous — castWorker would refuse; show neither
    }
  }
  return index;
}

type DecryptedRoleNode = {
  id: string;
  loc: string;
  description: string | null;
  data: Record<string, unknown> | null;
};

/**
 * Load + decrypt the Team Agent's role nodes (SESSION_EXPIRED typed for an
 * encrypted system memory without an active session key, matching the cast
 * path). Single-atom locs only — `roles:<role>:notes` sub-nodes are content,
 * not role definitions (the same filter the cast path's enumeration applies).
 */
async function loadRoleNodes(
  ctx: Context,
  systemMemoryId: string,
): Promise<DecryptedRoleNode[]> {
  const rows = await ctx.db.node.findMany({
    // Memory-scoped by construction (findings:unscoped-loc-lookup-crosses-
    // memories): the loc match never leaves this agent's system memory.
    where: {
      memoryId: systemMemoryId,
      deletedAt: null,
      loc: { startsWith: ROLES_BRANCH_PREFIX },
    },
    orderBy: { loc: 'asc' },
  });
  const memInfo = await getMemoryEncryptionInfo(ctx.db, systemMemoryId);
  const out: DecryptedRoleNode[] = [];
  for (const row of rows) {
    const slug = row.loc.slice(ROLES_BRANCH_PREFIX.length);
    if (slug === '' || slug.includes(':')) continue;
    try {
      decryptNodeFields(row, memInfo);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('SESSION_EXPIRED')) {
        throw new GraphQLError(
          `SESSION_EXPIRED: memory ${memInfo.id} is encrypted but no active session key is available.`,
          { extensions: { code: 'SESSION_EXPIRED', memoryId: memInfo.id } },
        );
      }
      throw e;
    }
    out.push({
      id: row.id,
      loc: row.loc,
      description: row.description,
      data: (row.data as Record<string, unknown> | null) ?? null,
    });
  }
  return out;
}

/** Read a string data key, tolerating absent/non-string values as null. */
function stringKey(data: Record<string, unknown> | null, key: string): string | null {
  const v = data?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Assemble one TeamRole projection from a decrypted role node + the roster
 * and role-agent indexes. `taken` consults the ONE per-App name unique
 * (`workers_app_name_uniq`, case-insensitive; retirement never frees a name —
 * cor:agt:020:02), so the read can never report free a name the cast would
 * refuse. `hasNamePlaceholder` moved to the role-AGENT's dressing with the
 * Worker model: it flags a `personaPrompt` that never binds `{{name}}` — the
 * silent-breakage check #960 kept on the read because agents authored before
 * the guard exist. Null when no single role-agent resolves.
 */
async function buildTeamRole(
  ctx: Context,
  node: DecryptedRoleNode,
  rosterByName: Map<string, WorkerRosterRow>,
  roleAgentIndex: Map<string, RoleAgentEntry>,
) {
  const role = node.loc.slice(ROLES_BRANCH_PREFIX.length);
  const names = parseNameRegister(node.data?.names);
  const register = names.map((name) => {
    const heldBy = rosterByName.get(name.toLowerCase()) ?? null;
    return { name, taken: heldBy !== null, heldBy };
  });
  const freeCount = register.filter((r) => !r.taken).length;

  const entry = roleAgentIndex.get(role.toLowerCase());
  let roleAgent: Record<string, unknown> | null = null;
  let hasNamePlaceholder: boolean | null = null;
  if (entry?.agent) {
    // The read-side check stays computed even when the agent object below is
    // masked: it discloses one boolean about the caller's OWN App's casting
    // default, and it is exactly what an operator needs to find templates
    // authored before any write-path guard existed.
    hasNamePlaceholder = /\{\{\s*name\s*\}\}/.test(entry.agent.personaPrompt ?? '');
    // The agent OBJECT runs Query.agent's own read gate, masked to null on
    // deny — the same #552 posture as Worker.agent: a nested Agent hands the
    // caller its field resolvers (systemPrompt included).
    const agent = entry.agent as unknown as {
      visibility: string | null;
      organizationId: string | null;
      ownerUserId: string | null;
    };
    if (agent.visibility === 'PUBLIC') {
      roleAgent = entry.agent;
    } else {
      try {
        await requireOwnerOrOrgRole(ctx, agent, 'READER');
        roleAgent = entry.agent;
      } catch {
        roleAgent = null;
      }
    }
  }

  return {
    role,
    loc: node.loc,
    nodeId: node.id,
    description: node.description,
    register,
    freeCount,
    exhausted: freeCount === 0,
    nameRange: stringKey(node.data, 'nameRange'),
    nameConvention: stringKey(node.data, 'nameConvention'),
    roleAgent,
    hasNamePlaceholder,
  };
}

type AppRow = {
  id: string;
  name: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  uninstalledAt: Date | null;
  deletedAt: Date | null;
};

async function resolveApp(ctx: Context, appRef: string): Promise<AppRow> {
  const { id: appId } = await resolveAppRef(ctx.db, appRef);
  return ctx.db.app.findUniqueOrThrow({ where: { id: appId } }) as Promise<AppRow>;
}

/** Parse a `nameRange` convention like "F-J" → inclusive initial bounds, or null when unparseable. */
function parseNameRange(range: string): { from: string; to: string } | null {
  const m = /^\s*([A-Za-z])\s*-\s*([A-Za-z])\s*$/.exec(range);
  if (!m) return null;
  const from = m[1].toLowerCase();
  const to = m[2].toLowerCase();
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * The register-diff invariants (#960 + hadron-cli#410) — run against the DIFF
 * between the stored and submitted registers, so the checks hold regardless
 * of how the client phrased the edit (`names add/rm/set/mv` are all
 * read-modify-submit sugar over the one wholesale mutation):
 *
 *   1. a name MINTED in this App may not be removed — keeping `Iris` in the
 *      register is what records the allocation; dropping her leaves a gap
 *      another role can claim (the #942 §2 shared-handle ambiguity,
 *      reintroduced through bookkeeping);
 *   2. an added name may not appear in another of this App's registers — a
 *      name in two registers is a latent WORKER_NAME_TAKEN where whichever
 *      role casts first silently costs the other an entry;
 *   3. an added name must fall inside `nameRange` when one is present and
 *      parseable ("F-J" = initial letter bounds), unless the caller passes
 *      `allowOutOfRange` for a deliberate exception. No range ⇒ no check
 *      (GraphQL deliberately has no warning channel — #960's decided shape).
 *
 * App-scoped throughout (#972: the App is the name namespace — a name in
 * ANOTHER App's register is legitimate). Why the deadline is hard: a name is
 * permanent once cast (cor:agt:020:02) — before the cast a register mistake
 * is a typo; after it, it can only be abandoned. The register edit is the
 * last point at which the mistake is cheap.
 */
function checkRegisterInvariants(args: {
  role: string;
  submitted: string[];
  stored: string[];
  rosterByName: Map<string, WorkerRosterRow>;
  otherRegisters: Map<string, string>; // lower(name) → role slug holding it
  nameRange: string | null;
  allowOutOfRange: boolean;
}): void {
  const { role, submitted, stored, rosterByName, otherRegisters, nameRange, allowOutOfRange } = args;
  const submittedLower = new Set(submitted.map((n) => n.toLowerCase()));

  const removedMinted = stored.filter(
    (n) => !submittedLower.has(n.toLowerCase()) && rosterByName.has(n.toLowerCase()),
  );
  if (removedMinted.length > 0) {
    throw new GraphQLError(
      `Cannot remove ${removedMinted.map((n) => JSON.stringify(n)).join(', ')} from the "${role}" register: the name is minted in this App (a Worker holds it — retirement never frees a name), and the register entry is what records the allocation. Names may be added or reordered; a minted name stays.`,
      { extensions: { code: 'TEAM_ROLE_NAME_MINTED', role, names: removedMinted } },
    );
  }

  const storedLower = new Set(stored.map((n) => n.toLowerCase()));
  const added = submitted.filter((n) => !storedLower.has(n.toLowerCase()));

  const duplicated = added.filter((n) => otherRegisters.has(n.toLowerCase()));
  if (duplicated.length > 0) {
    const first = duplicated[0];
    throw new GraphQLError(
      `Name ${JSON.stringify(first)} already appears in this App's "${otherRegisters.get(first.toLowerCase())}" register — a name in two registers is a latent WORKER_NAME_TAKEN (whichever role casts first wins, and the other silently loses an entry).`,
      {
        extensions: {
          code: 'TEAM_ROLE_NAME_DUPLICATE',
          role,
          names: duplicated,
          heldByRoles: duplicated.map((n) => otherRegisters.get(n.toLowerCase())),
        },
      },
    );
  }

  if (nameRange && !allowOutOfRange) {
    const bounds = parseNameRange(nameRange);
    if (bounds) {
      const outOfRange = added.filter((n) => {
        const initial = n[0]?.toLowerCase() ?? '';
        return initial < bounds.from || initial > bounds.to;
      });
      if (outOfRange.length > 0) {
        throw new GraphQLError(
          `Name ${outOfRange.map((n) => JSON.stringify(n)).join(', ')} falls outside this register's nameRange "${nameRange}" (a worker's initial identifies its role at a glance). Pass allowOutOfRange: true for a deliberate exception.`,
          { extensions: { code: 'TEAM_ROLE_NAME_OUT_OF_RANGE', role, names: outOfRange, nameRange } },
        );
      }
    }
  }
}

/** lower(name) → holding role slug, across every OTHER role node of the memory. */
function indexOtherRegisters(
  nodes: DecryptedRoleNode[],
  excludeLoc: string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const node of nodes) {
    if (node.loc === excludeLoc) continue;
    const slug = node.loc.slice(ROLES_BRANCH_PREFIX.length);
    for (const name of parseNameRegister(node.data?.names)) {
      if (!index.has(name.toLowerCase())) index.set(name.toLowerCase(), slug);
    }
  }
  return index;
}

/** Shared write-path argument shape. */
type TeamRoleWriteArgs = {
  appRef: string;
  teamAgentRef?: string | null;
  role: string;
  names?: string[] | null;
  nameRange?: string | null;
  nameConvention?: string | null;
  description?: string | null;
  allowOutOfRange?: boolean | null;
};

/**
 * Validate + normalize the role slug: a single loc atom (no ":"), non-empty.
 * The full `roles:<role>` loc still runs writeNodeCore's validateLoc, so
 * character-level rules stay the node surface's (one source of truth).
 */
function normalizeRoleSlug(role: string): string {
  const slug = (role ?? '').trim();
  if (slug === '' || slug.includes(':')) {
    throw new GraphQLError('role must be a single non-empty loc atom (no ":").', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return slug;
}

/**
 * Shared write body for createTeamRole / updateTeamRole. Both delegate the
 * actual node write to `writeNodeCore` — the single-write seam that owns the
 * definition-edit gate (`requireMemoryWriteAccess`, exactly the gate the
 * generic node surface runs on the Team Agent's system memory: Holger's
 * 2026-08-14 ruling — an ADMIN-only mutation gate here would lock one of two
 * doors), encryption (decrypt→mutate→re-encrypt), the NodeRevision snapshot,
 * and the git mirror. What THIS module adds is the spec knowledge a
 * hand-authoring caller had to carry (#960): the loc shape, the register
 * living in `data.names` (ordered), sibling-key preservation, and the
 * register-diff invariants above.
 */
async function writeTeamRole(
  args: TeamRoleWriteArgs,
  ctx: Context,
  mode: 'create' | 'update',
) {
  const role = normalizeRoleSlug(args.role);
  // A caller-supplied nameRange must PARSE, or the range validation it
  // promises silently never runs (#984 review, Copilot). Legacy malformed
  // STORED ranges (hand-authored before this surface) stay tolerated when the
  // argument is omitted — checkRegisterInvariants skips an unparseable one.
  if (typeof args.nameRange === 'string' && !parseNameRange(args.nameRange)) {
    throw new GraphQLError(
      `nameRange must be an initial-letter range like "F-J" (got ${JSON.stringify(args.nameRange)}). Pass null to clear it.`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
  const app = await resolveApp(ctx, args.appRef);
  if (app.deletedAt) {
    throw new GraphQLError(`App not found: ${args.appRef}`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  if (app.uninstalledAt) {
    throw new GraphQLError('Cannot edit team roles of an uninstalled App.', {
      extensions: { code: 'APP_UNINSTALLED', appId: app.id },
    });
  }
  // Locate the Team Agent, HOLDING any locator error until an App-scoped
  // gate has passed (#984 review, Copilot): TEAM_AGENT_NOT_FOUND /
  // _AMBIGUOUS / _NOT_INSTALLED disclose the App's installed-agent topology
  // (candidate names and URNs), and on this failure path there is no system
  // memory to run the real write gate against — so the errors are shown only
  // to the audience the teamRoles READ already grants them to
  // (requireWorkerReadAccess); everyone else gets FORBIDDEN. On the success
  // path the memory-write gate below remains the sole authority, so a
  // generic-memory writer who is not an App participant (a cross-org
  // subscription CONTRIBUTOR) is unaffected.
  let teamAgent: Awaited<ReturnType<typeof locateTeamAgent>>;
  try {
    teamAgent = await locateTeamAgent(ctx, app.id, args.teamAgentRef);
  } catch (e) {
    await requireWorkerReadAccess(ctx, app);
    throw e;
  }
  if (!teamAgent.systemMemoryId) {
    throw new GraphQLError(
      `Team Agent ${teamAgent.name} has no system memory to hold role definitions.`,
      { extensions: { code: 'TEAM_AGENT_NOT_FOUND', appId: app.id } },
    );
  }
  // The definition-edit gate, UP FRONT — before any refusal that would
  // disclose register or roster contents to a caller who may not edit them.
  // writeNodeCore re-runs the same predicate at the write seam; this early
  // call just moves the denial ahead of the invariant errors.
  await requireMemoryWriteAccess(ctx, teamAgent.systemMemoryId);

  const loc = `${ROLES_BRANCH_PREFIX}${role}`;
  const systemMemoryId = teamAgent.systemMemoryId;

  // Everything from the invariant reads through the node write runs inside
  // the register lock (#984 review, Codex P1): without it, two concurrent
  // role writes can each observe a name absent and both persist it, and a
  // register-mode cast can interleave with a removal. castWorker's register
  // mode takes the same lock, so cast-vs-edit serializes too.
  return withRegisterLock(ctx, systemMemoryId, async () => {
    const allNodes = await loadRoleNodes(ctx, systemMemoryId);
    const existing = allNodes.find((n) => n.loc === loc) ?? null;

    if (mode === 'create' && existing) {
      throw new GraphQLError(
        `Role "${role}" already exists in ${teamAgent.name}'s system memory — updateTeamRole is the edit path.`,
        { extensions: { code: 'TEAM_ROLE_EXISTS', role, nodeId: existing.id } },
      );
    }
    if (mode === 'update' && !existing) {
      const available = allNodes.map((n) => n.loc.slice(ROLES_BRANCH_PREFIX.length));
      throw new GraphQLError(
        `Role "${role}" is not defined in ${teamAgent.name}'s system memory.${available.length ? ` Available roles: ${available.join(', ')}.` : ''} createTeamRole is the create path.`,
        { extensions: { code: 'WORKER_ROLE_NOT_FOUND', role, availableRoles: available } },
      );
    }

    const storedData = existing?.data ?? null;
    const storedNames = parseNameRegister(storedData?.names);

    // Omitted preserves (the omitted-vs-null contract): an update that sends
    // no `names` edits conventions without touching the register.
    const submitted =
      args.names === undefined || args.names === null
        ? storedNames
        : parseNameRegister(args.names);

    // The effective range for validating ADDED names: the one being written,
    // else the stored one (explicit null clears — and with it, the check).
    const effectiveRange =
      args.nameRange === undefined
        ? stringKey(storedData, 'nameRange')
        : (args.nameRange ?? null);

    checkRegisterInvariants({
      role,
      submitted,
      stored: storedNames,
      rosterByName: await loadRosterByName(ctx, app.id),
      otherRegisters: indexOtherRegisters(allNodes, loc),
      nameRange: effectiveRange,
      allowOutOfRange: args.allowOutOfRange === true,
    });

    // Merge: replace only the keys this surface owns; every sibling `data`
    // key survives (the hadron-cli#410 clobber hazard, unreachable through
    // this surface by construction). Explicit null deletes a convention key.
    const mergedData: Record<string, unknown> = { ...(storedData ?? {}) };
    mergedData.names = submitted;
    if (args.nameRange !== undefined) {
      if (args.nameRange === null) delete mergedData.nameRange;
      else mergedData.nameRange = args.nameRange;
    }
    if (args.nameConvention !== undefined) {
      if (args.nameConvention === null) delete mergedData.nameConvention;
      else mergedData.nameConvention = args.nameConvention;
    }

    await writeNodeCore(
      {
        memoryId: systemMemoryId,
        loc,
        // Node name defaults to the role slug; description is optional and
        // preserve-on-omit via the shared seam's D4 semantics.
        ...(mode === 'create' ? { name: role } : {}),
        ...(args.description !== undefined && args.description !== null
          ? { description: args.description }
          : {}),
        data: mergedData,
        reason: `${mode === 'create' ? 'createTeamRole' : 'updateTeamRole'} (#960)`,
      },
      ctx,
      mode,
      mode === 'update' ? { targetNodeId: existing!.id } : undefined,
    );

    // Return the fresh projection through the same builder the read uses.
    const nodes = await loadRoleNodes(ctx, systemMemoryId);
    const node = nodes.find((n) => n.loc === loc);
    if (!node) {
      throw new GraphQLError(`Role "${role}" write did not persist.`, {
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
    }
    return buildTeamRole(
      ctx,
      node,
      await loadRosterByName(ctx, app.id),
      await loadRoleAgentIndex(ctx, app.id),
    );
  });
}

export const teamRoleQueries = {
  /**
   * teamRoles — #960: the role definitions of an App's Team Agent, with the
   * one answer a client cannot compute: which register names are still FREE,
   * judged against the App's full worker roster (cor:agt:020:02 App-scoped
   * permanence, #972). Read gate mirrors the staff list
   * (`requireWorkerReadAccess`): App participants, org CONTRIBUTOR+, the
   * owner of a user-owned App, or the App's own key. Page envelope per the
   * teamWorkItems precedent (cor:api:120); role definitions are few, so the
   * atom filter paginates in memory.
   */
  teamRoles: async (
    _: unknown,
    {
      appRef,
      teamAgentRef,
      limit,
      offset,
    }: { appRef: string; teamAgentRef?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const app = await resolveApp(ctx, appRef);
    if (app.deletedAt) {
      throw new GraphQLError(`App not found: ${appRef}`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    await requireWorkerReadAccess(ctx, app);
    const teamAgent = await locateTeamAgent(ctx, app.id, teamAgentRef);
    if (!teamAgent.systemMemoryId) {
      return { items: [], total: 0 };
    }
    const nodes = await loadRoleNodes(ctx, teamAgent.systemMemoryId);
    const rosterByName = await loadRosterByName(ctx, app.id);
    const roleAgentIndex = await loadRoleAgentIndex(ctx, app.id);
    const page = nodes.slice(offset ?? 0, (offset ?? 0) + clampListTake(limit));
    return {
      items: await Promise.all(
        page.map((n) => buildTeamRole(ctx, n, rosterByName, roleAgentIndex)),
      ),
      total: nodes.length,
    };
  },
};

export const teamRoleMutations = {
  /**
   * createTeamRole — #960: mint a `roles:<role>` definition. Refuses an
   * existing role (TEAM_ROLE_EXISTS — update is the edit path); a
   * soft-deleted tombstone at the loc is resurrected by the shared write
   * seam rather than P2002-blocking forever (the chat-bootstrap lesson).
   */
  createTeamRole: async (_: unknown, args: TeamRoleWriteArgs & { names: string[] }, ctx: Context) =>
    writeTeamRole(args, ctx, 'create'),

  /**
   * updateTeamRole — #960: edit a role definition. `names` is wholesale
   * (explicit, the natural fit for `team role names set`) but the invariants
   * run against the DIFF, so `add`/`rm`/`mv` sugar can never smuggle an
   * invariant violation. Omitted fields preserve; explicit null clears a
   * convention key.
   */
  updateTeamRole: async (_: unknown, args: TeamRoleWriteArgs, ctx: Context) =>
    writeTeamRole(args, ctx, 'update'),
};
