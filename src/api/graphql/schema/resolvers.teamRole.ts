// Team roles as a platform surface — #960 (cor:agt:020:01/:02), re-keyed by
// the Worker model (#974): a role definition is the `roles:<role>` node in the
// Team Agent's system memory. The persona prompt template is NOT here — it
// lives on the role-agent as dressing (`Agent.personaRole` + `personaPrompt`),
// which this surface only points at.
//
// #1050 — the NAME REGISTER is gone. `data.names` and its conventions
// (`nameRange`, `nameConvention`), the allocation order, the diff invariants
// and the #987 compare-and-swap that protected them are all removed, because
// names are no longer allocated from a pool: a cast supplies its own and
// `workers_app_name_uniq` is the sole arbiter.
//
// That takes most of this module's original justification with it. The read
// existed chiefly to answer "which names are still free?", which needed the
// App's FULL roster and so could not be computed client-side; the writes
// existed to own register invariants a client could not check. What remains is
// a thin, honest surface over role DEFINITIONS — slug, description, and the
// role-agent a cast would use — with one thing a client still cannot do for
// itself: resolve the role-agent behind its own read gate.
//
// Legacy `data.names` on existing role nodes is neither read nor rewritten. It
// records what was once allocated to a role, and erasing it would destroy
// provenance to tidy a field with no reader.

import { GraphQLError } from 'graphql';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import {
  getMemoryEncryptionInfo,
  decryptNodeFields,
} from '../../../lib/nodeCrypto.js';
import {
  locateTeamAgent,
  requireWorkerReadAccess,
  withRoleWriteLock,
  ROLES_BRANCH_PREFIX,
} from './resolvers.worker.js';
import { templateBindsName } from '../../../lib/personaDescription.js';
import { writeNodeCore, nodeMutations } from './resolvers.mutation.node.js';
import {
  type Context,
  requireMemoryWriteAccess,
  requireOwnerOrOrgRole,
  clampListTake,
} from './resolvers.helpers.js';

type WorkerRosterRow = Record<string, unknown> & { id: string; name: string };

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
  /** Optimistic-concurrency anchor for the #989 guarded write (Node.revSeq). */
  revSeq: number;
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
      revSeq: row.revSeq,
    });
  }
  return out;
}

/**
 * Assemble one TeamRole projection from a decrypted role node + the role-agent
 * index. `hasNamePlaceholder` moved to the role-AGENT's dressing with the
 * Worker model: it flags a `personaPrompt` that never binds `{{name}}` — the
 * silent-breakage check #960 kept on the read because agents authored before
 * the guard exist. Null when no single role-agent resolves.
 *
 * #1050: the name REGISTER is gone from this projection — no `register`,
 * `freeCount`, `exhausted`, `nameRange` or `nameConvention`. A role is now a
 * definition (slug, description, role-agent) and nothing about allocation,
 * because names are no longer allocated: a cast supplies its own, and
 * `workers_app_name_uniq` is the only arbiter of whether one is free.
 *
 * Any `data.names` still on the node is deliberately NOT read. It is the
 * historical record of what was allocated to this role and is left intact
 * rather than migrated away — inert data is cheaper than lost provenance.
 */
async function buildTeamRole(
  ctx: Context,
  node: DecryptedRoleNode,
  roleAgentIndex: Map<string, RoleAgentEntry>,
) {
  const role = node.loc.slice(ROLES_BRANCH_PREFIX.length);
  const entry = roleAgentIndex.get(role.toLowerCase());
  let roleAgent: Record<string, unknown> | null = null;
  let hasNamePlaceholder: boolean | null = null;
  if (entry?.agent) {
    // The read-side check stays computed even when the agent object below is
    // masked: it discloses one boolean about the caller's OWN App's casting
    // default, and it is exactly what an operator needs to find templates
    // authored before any write-path guard existed.
    // Shared with applyPersonaTemplate's exact token (#985 review): a
    // whitespace-tolerant probe would bless `{{ name }}`, which the composer
    // leaves literal.
    hasNamePlaceholder = templateBindsName(entry.agent.personaPrompt);
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

/** Shared write-path argument shape. */
type TeamRoleWriteArgs = {
  appRef: string;
  teamAgentRef?: string | null;
  role: string;
  description?: string | null;
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
  return withRoleWriteLock(ctx, systemMemoryId, async () => {
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

    // #1050: this surface no longer owns ANY `data` key. The register, its
    // conventions and the #987 compare-and-swap that protected it are gone, so
    // a role write now touches only the node's name and description.
    //
    // Existing `data` is passed through untouched rather than stripped —
    // `data.names` on a legacy role node is the record of what was once
    // allocated to that role, and erasing it would destroy provenance to tidy
    // a field nothing reads. Sibling-key preservation therefore stops being a
    // special measure and becomes the whole behaviour.
    const mergedData: Record<string, unknown> | undefined = existing?.data ?? undefined;

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
      // #1050: no guardRevSeq. The #989 revision guard existed to close a
      // TOCTOU window on the REGISTER — a generic node write slipping between
      // the locked read and the write — and there is no longer a register for
      // an off-road write to clobber. Role writes now set only name and
      // description, which are last-write-wins like every other node field.
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
    return buildTeamRole(ctx, node, await loadRoleAgentIndex(ctx, app.id));
  });
}

/**
 * deleteTeamRole — #1002: retire a `roles:<role>` definition and its sub-nodes.
 *
 * #1050 — unconditional. The minted-name gate, `TEAM_ROLE_IN_USE`, the
 * `transferTo` supersede, the post-delete recheck and the restore
 * compensation all existed to protect the register as a LEDGER of which names
 * had been allocated to this role. With no register there is no ledger, and
 * with no second write there is nothing to compensate.
 *
 * What that machinery protected is untouched, and was never the register's
 * doing: a Worker's name is permanent per App (`cor:agt:020:02`), enforced by
 * `workers_app_name_uniq` on `(app_id, lower(name))` irrespective of any role
 * — so deleting a role can no more free a taken name than it could before.
 * Superseding a role is now create-the-successor then delete-the-old; the
 * names were never the thing being moved.
 */
async function deleteTeamRoleImpl(
  args: { appRef: string; teamAgentRef?: string | null; role: string },
  ctx: Context,
) {
  const role = normalizeRoleSlug(args.role);
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
  // Same hold-the-locator-error posture as writeTeamRole: TEAM_AGENT_* names
  // the App's installed-agent topology, so it is shown only to the audience
  // the teamRoles read already grants it to.
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
  // The definition-edit gate up front — ahead of any refusal that would
  // disclose register or roster contents to a caller who may not edit them.
  await requireMemoryWriteAccess(ctx, teamAgent.systemMemoryId);

  const systemMemoryId = teamAgent.systemMemoryId;
  const loc = `${ROLES_BRANCH_PREFIX}${role}`;

  return withRoleWriteLock(ctx, systemMemoryId, async () => {
    const allNodes = await loadRoleNodes(ctx, systemMemoryId);
    const existing = allNodes.find((n) => n.loc === loc) ?? null;
    if (!existing) {
      const available = allNodes.map((n) => n.loc.slice(ROLES_BRANCH_PREFIX.length));
      throw new GraphQLError(
        `Role "${role}" is not defined in ${teamAgent.name}'s system memory.${available.length ? ` Available roles: ${available.join(', ')}.` : ''}`,
        { extensions: { code: 'WORKER_ROLE_NOT_FOUND', role, availableRoles: available } },
      );
    }

    // #1050: a bare, unconditional soft-delete. Everything that used to guard
    // this — the minted-name check, TEAM_ROLE_IN_USE, transferTo's supersede,
    // the post-delete recheck and the restore-compensation — existed to protect
    // the REGISTER as a ledger of which names had been allocated to this role.
    // With no register there is no ledger to protect, and no second write to
    // compensate for: the delete is now one operation.
    //
    // What that machinery protected is unchanged and was never the register's
    // doing: a Worker's name is permanent per App (cor:agt:020:02, enforced by
    // workers_app_name_uniq), so deleting a role can no more free a taken name
    // than it could before. Superseding a role is now: create the successor,
    // delete the old one. The names were never the thing being moved.
    //
    // recursive because roles:<role>:notes is content OF this role. Delegated
    // to the shared node seam so descendant handling, tombstone semantics and
    // the write gate stay in one place.
    const tombstoned = (
      await ctx.db.node.findMany({
        where: {
          memoryId: systemMemoryId,
          deletedAt: null,
          OR: [{ loc }, { loc: { startsWith: `${loc}:` } }],
        },
        select: { id: true },
      })
    ).map((n) => n.id);
    await nodeMutations.deleteNode(null, { nodeRef: existing.id, recursive: true }, ctx);

    return {
      role,
      nodesDeleted: tombstoned.length,
    };
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
    const roleAgentIndex = await loadRoleAgentIndex(ctx, app.id);
    const page = nodes.slice(offset ?? 0, (offset ?? 0) + clampListTake(limit));
    return {
      items: await Promise.all(page.map((n) => buildTeamRole(ctx, n, roleAgentIndex))),
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
  createTeamRole: async (_: unknown, args: TeamRoleWriteArgs, ctx: Context) =>
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

  /**
   * deleteTeamRole — #1002: retire a role definition and its sub-nodes.
   * Unconditional since #1050; see {@link deleteTeamRoleImpl} for why the
   * minted-name gate and the transfer machinery went with the register.
   */
  deleteTeamRole: async (
    _: unknown,
    args: { appRef: string; teamAgentRef?: string | null; role: string },
    ctx: Context,
  ) => deleteTeamRoleImpl(args, ctx),
};
