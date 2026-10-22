// Team roles as a platform surface — #960 (cor:agt:020:01/:02), re-keyed by
// the Worker model (#974): a role definition is the `roles:<role>` node in the
// Team Agent's system memory. The persona prompt template is NOT here — it
// lives on the role-agent as dressing (`Agent.personaRole` + `systemPrompt`),
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
import { writeNodeCore, deleteNodeInTransaction } from './resolvers.mutation.node.js';
import {
  type Context,
  requireMemoryWriteAccess,
  requireAgentAccess,
  requireOwnerOrOrgRole,
  clampListTake,
} from './resolvers.helpers.js';

type WorkerRosterRow = Record<string, unknown> & { id: string; name: string };

type RoleAgentEntry = {
  /** The single installed agent whose personaRole matches, or null (zero or 2+). */
  agent: (Record<string, unknown> & { systemPrompt: string | null }) | null;
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
 * Worker model: it flags a `systemPrompt` that never binds `{{name}}` — the
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
/**
 * `data.repos` → the role's repo affinity (#1024): the repos a worker in this
 * role normally works in.
 *
 * Tolerant by construction. This is a SOFT signal a client renders as a warning
 * (hadron-cli#456), never a gate, so a malformed value degrades to "no
 * affinity" rather than failing a read of the whole roster — a role list that
 * 500s because one node has a stray key is a worse outcome than a missing
 * warning. Non-strings are dropped, entries trimmed, blanks removed, order
 * preserved, exact duplicates collapsed.
 *
 * EMPTY AND UNSET MEAN THE SAME THING: no affinity, never warn. The issue left
 * that open and the simplest contract is the honest one — a client cannot act
 * differently on the two, since "spans everything" (the coordinator) and "not
 * configured yet" both mean "do not warn", and inventing a distinction would
 * make an unconfigured team look misconfigured.
 */
function parseRepoAffinity(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

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
    hasNamePlaceholder = templateBindsName(entry.agent.systemPrompt);
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
        await requireAgentAccess(ctx, agent, 'READER');
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
    // #1024 — repo affinity. The ONE piece of `data` this projection reads:
    // a curated field, not a generic `data` passthrough, so the surface keeps
    // deciding what it exposes rather than leaking whatever a node happens to
    // carry (`data.names` on a legacy role node is exactly what must NOT
    // appear here).
    repos: parseRepoAffinity(node.data?.repos),
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
  /** #1024 — repo affinity. Omitted preserves; an empty array clears. */
  repos?: string[] | null;
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
  return withRoleWriteLock(ctx, systemMemoryId, async (_tx, ctx, transaction) => {
    await requireMemoryWriteAccess(ctx, systemMemoryId);
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

    // #1050 — this surface owns NO `data` key by default, and therefore does
    // not send one. Omitting `data` is load-bearing rather than tidiness
    // (PR #1059 review, Codex P1): reading the node's data and writing it back
    // looks like "passing it through untouched" and is a wholesale
    // last-write-wins overwrite of a pre-write snapshot. Generic writers
    // (updateNode, hadron_update_node_data) do NOT take withRoleWriteLock, so a
    // concurrent edit landing in that window would be silently reverted. Legacy
    // `data.names` survives precisely because it is never rewritten.
    //
    // #1024 adds exactly ONE key this surface does own: `repos`. Writing it
    // reopens that window, so it is written the only safe way available —
    // merge just this key, and stake the #989 revision guard on the row we
    // read. A concurrent generic edit bumps revSeq and the write REFUSES
    // (NODE_WRITE_CONFLICT) rather than silently reverting it.
    //
    // The guard is why `data` is still absent when `repos` is omitted: an
    // unconditional merge would make every description edit a data write, and
    // pay the conflict risk for callers who touched no data at all.
    const wantsRepoWrite = args.repos !== undefined && args.repos !== null;
    // The base to merge onto. `existing` comes from loadRoleNodes, which
    // filters `deletedAt: null` — but writeNodeCore RESURRECTS a tombstone on
    // create (`isResurrect`), so a create over a soft-deleted role updates that
    // row rather than inserting a new one. Merging against `existing` alone
    // would therefore send `{ repos }` as the WHOLE data bag and erase the
    // tombstone's history — legacy `data.names` included — which is the one
    // thing this surface has promised throughout not to do
    // (PR #1071 review, Codex).
    //
    // Only looked up when a repo write is actually happening, and only on
    // create: an update already has the live row.
    // The merge base must be a PLAIN OBJECT. A `roles:<role>` node authored
    // generically can legally hold a scalar or an array in `data`, and
    // spreading those silently corrupts them — an array becomes numeric keys, a
    // string becomes character keys, a number vanishes entirely (PR #1071
    // review, Codex). This surface promises to modify only `repos`, so it
    // refuses rather than rewriting a shape it was never asked to touch.
    const mergeBase: Record<string, unknown> = wantsRepoWrite
      ? (() => {
          const v = existing?.data;
          if (v == null) return {};
          if (typeof v !== 'object' || Array.isArray(v)) {
            throw new GraphQLError(
              `Role "${role}" has non-object data, so setting repos would rewrite it. Fix the node's data first.`,
              { extensions: { code: 'TEAM_ROLE_DATA_NOT_OBJECT', role, loc } },
            );
          }
          return v as Record<string, unknown>;
        })()
      : {};

    const mergedData = wantsRepoWrite
      ? { ...mergeBase, repos: parseRepoAffinity(args.repos) }
      : undefined;

    try {
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
          // On CREATE we never send data. writeNodeCore resurrects a tombstone
        // through its upsert-update branch, and that branch takes no revision
        // guard — so a create racing a restoreNodeRevision could replace the
        // concurrent data with a stale merge (PR #1071 review, Codex). Omitting
        // data preserves whatever the row holds; the repos are then written by
        // the GUARDED update below, which is the same path an ordinary edit
        // takes. One write path for data, one guard, no special case.
        ...(mergedData !== undefined ? { data: mergedData } : {}),
          reason: `${mode === 'create' ? 'createTeamRole' : 'updateTeamRole'} (#960)`,
        },
        ctx,
        mode,
        { ...(mode === 'update'
          ? {
              targetNodeId: existing!.id,
              // Only when this write carries data. A description-only edit stays
              // last-write-wins like any other node field, as it was before
              // #1024 — the guard exists for the data merge, not for the row.
              // A guarded update is TWO node writes — the revNo claim, then the
            // main update guarded on the claimed value — and they are not in
            // one transaction (the role lock runs on a separate connection).
            // A writer landing between them leaves a consumed revSeq and a
            // revision describing an edit that then refuses. That is
            // pre-existing to #989's primitive rather than new here (#1072),
            // but re-enabling the option is what makes it reachable again, so
            // it is named at the call site rather than left to be rediscovered.
            // The refusal itself is correct; the residue is an audit artifact.
            ...(wantsRepoWrite ? { guardRevSeq: existing!.revSeq } : {}),
            }
          : undefined), transaction },
      );
    } catch (e) {
      // #1024: the guard fired. Translate rather than leak the generic node
      // code — a caller of updateTeamRole has no idea what NODE_WRITE_CONFLICT
      // refers to, and the actionable fact is specific: somebody edited this
      // role node's data outside this surface, so re-read and retry.
      //
      // Deliberately a REFUSAL rather than a retry-in-place. The competing
      // write is by definition one this surface cannot see the intent of, and
      // silently re-merging on top of it is how the last-write-wins revert
      // (PR #1059) happened in the first place.
      if (e instanceof GraphQLError && e.extensions?.code === 'NODE_WRITE_CONFLICT') {
        throw new GraphQLError(
          `The "${role}" role definition was modified while this edit ran — re-read it and retry.`,
          { extensions: { code: 'TEAM_ROLE_DATA_CONFLICT', role } },
        );
      }
      throw e;
    }

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

  return withRoleWriteLock(ctx, systemMemoryId, async (_tx, ctx, transaction) => {
    await requireMemoryWriteAccess(ctx, systemMemoryId);
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
    await deleteNodeInTransaction({ nodeRef: existing.id, recursive: true }, ctx, transaction);

    return {
      role,
      nodesDeleted: tombstoned.length,
    };
  });
}

/**
 * #1024 — role → repo affinity for ONE App, memoized per request.
 *
 * Deliberately NOT a call to the `teamRoles` query, which is what the first
 * version did (PR #1071 review, Codex found three defects in one decision):
 *
 * - it PAGES, so an App with more than 50 roles silently answered `[]` for
 *   every role sorting past the first page — a suppressed warning that looks
 *   exactly like "no affinity configured";
 * - it runs `locateTeamAgent`, which throws TEAM_AGENT_AMBIGUOUS for an App
 *   with several `roles:` branches — a SUPPORTED configuration — so those Apps
 *   could never use this field at all;
 * - it re-ran the whole projection per worker, so a 50-worker page reloaded and
 *   re-decrypted the same roster 50 times.
 *
 * All three came from reusing a public query for an internal lookup. This reads
 * the role nodes directly, across EVERY installed agent's system memory rather
 * than one inferred Team Agent — which is both cheaper and more correct: if any
 * installed agent defines the role, its affinity counts, and ambiguity stops
 * being an error to swallow. Ties resolve by INSTALL order, then `loc` order —
 * both explicitly ordered, since a tie-break is only deterministic if every
 * step of it is.
 *
 * Caching is per REQUEST (on `ctx`), never longer — an edit landing mid-request
 * is far less likely than a stale warning surviving a role change.
 */
export async function loadAppRepoAffinity(
  ctx: Context,
  appId: string,
  opts?: { memoize?: boolean },
): Promise<Map<string, string[]>> {
  // MEMOIZED ONLY FOR QUERIES (PR #1071 review, Codex, rounds 4-7).
  //
  // A request-scoped memo over data a request can also WRITE is stale by
  // construction, and each round of review found another writer that had to
  // invalidate it: the TeamRole mutations, then updateNode/updateNodeData, then
  // deleteNode/moveNode/restoreNodeRevision. Chasing the last writer is the
  // wrong shape — the set is open, and every miss is silent.
  //
  // The memo exists to stop a 50-worker LISTING reloading the roster 50 times,
  // and a listing is a query. A mutation pays the re-read and can never read
  // its own stale answer. That retires the whole class rather than its
  // instances, which is why the invalidation hooks are gone with it.
  type Cache = Map<string, Promise<Map<string, string[]>>>;
  const holder = ctx as Context & { repoAffinityCache?: Cache };
  const cache = opts?.memoize ? (holder.repoAffinityCache ??= new Map()) : null;
  let pending = cache?.get(appId);
  if (pending) return pending;

  pending = (async () => {
    const out = new Map<string, string[]>();
    // ORDERED, because the tie-break below depends on it. Without an explicit
    // orderBy, Prisma makes no ordering promise, so two installed agents each
    // defining the same role could answer differently between requests or
    // environments (PR #1071 review, Copilot) — and the comment below claimed a
    // determinism the query did not provide. Install order is the meaningful
    // one: the agent installed first owns the role by default.
    const installed = await ctx.db.appAgent.findMany({
      where: { appId },
      orderBy: [{ createdAt: 'asc' }, { agentId: 'asc' }],
      select: { agent: { select: { systemMemoryId: true, deletedAt: true } } },
    });
    const memoryIds = [
      ...new Set(
        installed
          .map(({ agent }) => (agent && !agent.deletedAt ? agent.systemMemoryId : null))
          .filter((id): id is string => !!id),
      ),
    ];
    if (memoryIds.length === 0) return out;

    for (const memoryId of memoryIds) {
      let nodes: DecryptedRoleNode[];
      try {
        nodes = await loadRoleNodes(ctx, memoryId);
      } catch (e) {
        // ONLY the documented case: an encrypted system memory with no active
        // session key must not fail a worker read for the sake of an optional
        // warning. Everything else propagates (review:narrow-catch-blocks) — a
        // bare catch would turn a DB or runtime failure into "no affinity",
        // which is undiagnosable precisely because an empty answer is normal.
        if (!(e instanceof GraphQLError && e.extensions?.code === 'SESSION_EXPIRED')) {
          throw e;
        }
        // STOP rather than skip (PR #1071 review, Codex). Skipping an
        // unreadable memory let a LATER agent's duplicate role supply an
        // affinity the earlier, unreadable one might have overridden —
        // breaking the first-install precedence declared above and inventing a
        // false mismatch warning out of a memory nobody could read.
        //
        // Everything already in `out` came from a strictly EARLIER memory, so
        // it keeps its precedence and stays. Everything not yet set is now
        // unknowable, and unknown answers [] — never warn. A partial answer
        // that could be wrong is worse than no answer for a signal whose whole
        // job is to be trusted when it fires.
        break;
      }
      for (const node of nodes) {
        const role = node.loc.slice(ROLES_BRANCH_PREFIX.length).toLowerCase();
        // FIRST definition wins, even when its affinity is EMPTY (PR #1071
        // review, Codex). Recording only non-empty results made an empty
        // first-installed definition invisible, so a later agent's affinity
        // silently won — contradicting the install-order tie-break declared
        // just above it, and worse, the contract that empty means "no
        // affinity, never warn". The observable failure is a FALSE mismatch
        // warning: the role that deliberately spans everything gets told it is
        // in the wrong repo.
        //
        // Empty is an answer here, not the absence of one. This is the same
        // conflation the field's own doc warns about, in the loader that
        // implements it.
        if (out.has(role)) continue;
        out.set(role, parseRepoAffinity(node.data?.repos));
      }
    }
    return out;
  })();
  cache?.set(appId, pending);
  return pending;
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
    writeTeamRole({ ...args, repos: undefined }, ctx, 'create'),

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
