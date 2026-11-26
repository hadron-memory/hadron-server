import { resolveAppInstallation, listAppInstallations } from '../../../lib/appInstallations.js';
/**
 * App-scoped memory mutations — add a memory to an App.
 *
 * `createMemory` (resolvers.mutation.memory.ts) deliberately creates only
 * FREE-STANDING memories (app_id / agent stay NULL) and rejects class='app'.
 * The mutations below are the explicit, caller-invokable way to add every
 * App-associable memory class to a chosen App:
 *
 *   - createAppMemory (#2661, #2843) — new tenant-managed app-class creation without
 *     selecting an Agent; no existing memory attachment.
 *   - createMemoryInApp — create a new memory born App-scoped (app | knowledge |
 *     personal | private).
 *   - attachMemoryToApp — bind an existing free-standing personal/private memory
 *     to an App (an app-class memory can't exist free-standing, so it has
 *     nothing to attach).
 *
 * Split auth model (matches the App membership model, cf. requireAiConfigPicker
 * Access):
 *   - class='app' and class='knowledge' are shared data → App tenant owner
 *     (user owner or org OWNER/ADMIN). #653: an app-scoped knowledge memory is App-internal
 *     shared reference content — it is linked to the App's agent (AgentMemoryItem)
 *     so agents read it via the App surface, and is excluded from every org-wide
 *     read/write grant (getOrgReadableMemoryIds / requireMemoryWriteAccess).
 *   - personal/private are the CALLER'S OWN memory → App membership is the bar
 *     (an App member who is neither org admin nor App owner may still add their
 *     own memory). The caller always owns the resulting personal/private row.
 *
 * No schema/constraint change: the existing CHECKs (chk_memory_class_app_id,
 * chk_personal_visibility_user, chk_memory_personal_agent_id,
 * chk_memory_visibility_class) already permit these rows — we just set the
 * columns correctly per class.
 */
import { GraphQLError } from 'graphql';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { generateId } from '../../../lib/id.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { Prisma, type EmbeddingSource } from '../../../generated/prisma/index.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { isAgentInstalledAndLicensed } from '../../../lib/appAgent.js';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { isAppRefResolutionFailure } from '../../../lib/auth/workerRead.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { agentSlugFromUrn, normalizeUrnForLookup } from '../../../lib/urn.js';
import { refusedAppUserMemoryPrincipal, heldAppUserMemoryClasses } from './appUserMemoryEligibility.js';
import { appUserMemorySlug, APP_USER_MEMORY_MAX_TAIL } from '../../../lib/appUserMemoryName.js';
import { withFsProjectionRollback } from '../../../lib/fsProjectionRollback.js';
import { reclaimTombstonedMemory, SPEC_MINTED_PERMANENT } from '../../../lib/mintedSpecPermanence.js';
import { assertStorableText } from '../../../lib/unstorableTextInput.js';
import { type Context, requireOrgRole, requireOwnerOrOrgRole, MEMORY_INCLUDE, concealUnreadableDenial, withoutRequestCaches, deriveMemorySlug, requireCallerIdentity } from './resolvers.helpers.js';

/** App-associable memory classes (the DB CHECK forbids app_id only on system). */
type AppMemoryClass = 'app' | 'knowledge' | 'personal' | 'private';

/**
 * Load the target App, reject an uninstalled one, and enforce the class-split
 * authorization. Returns the loaded App (id, urn, tenant owner, and the
 * org's urn — eagerly loaded so the createMemoryInApp URN derivation needs no
 * second query).
 */
async function loadAppAndAuthorize(
  ctx: Context,
  appRef: string,
  klass: AppMemoryClass,
): Promise<{
  id: string;
  urn: string;
  organizationId: string | null;
  ownerUserId: string | null;
  organizationUrn: string | null;
}> {
  const { id: appId } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findUniqueOrThrow({
    where: { id: appId },
    select: {
      id: true,
      urn: true,
      organizationId: true,
      ownerUserId: true,
      uninstalledAt: true,
      organization: { select: { urn: true } },
    },
  });
  // resolveAppRef filters uninstalledAt on the URN path but NOT the ID path —
  // re-check explicitly (mirrors installAgentIntoAppCore).
  if (app.uninstalledAt) {
    throw new GraphQLError('This App has been uninstalled and cannot be written to.', {
      extensions: { code: 'APP_UNINSTALLED' },
    });
  }

  if (klass === 'app' || klass === 'knowledge') {
    // Shared data (deployment config / reference knowledge) — org-management.
    await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
  } else {
    // personal/private: the caller OWNS the resulting memory, so App membership
    // is the bar (not org admin) and the membership must be genuine — no
    // platform-admin bypass, or a non-member could own an app-scoped row.
    if (!ctx.userId) {
      throw new GraphQLError(
        'Adding a personal/private memory to an App requires an authenticated user (the creator is the owner).',
        { extensions: { code: 'UNAUTHENTICATED' } },
      );
    }
    const membership = await ctx.db.appMember.findUnique({
      where: { appId_userId: { appId: app.id, userId: ctx.userId } },
    });
    if (!membership) {
      throw new GraphQLError(
        'You must be a member of this App to add a personal/private memory to it.',
        { extensions: { code: 'FORBIDDEN' } },
      );
    }
  }
  return {
    id: app.id,
    urn: app.urn,
    organizationId: app.organizationId,
    ownerUserId: app.ownerUserId,
    organizationUrn: app.organization?.urn ?? null,
  };
}

/** Resolve the agent and assert it is installed in the App (single query). */
async function resolveInstalledAgent(
  ctx: Context,
  appId: string,
  agentRef: string,
): Promise<{ id: string; urn: string }> {
  // #1946 (ruling A): "no such Agent" answers exactly as "not installed in
  // this App" — one answer, no id.
  const notInstalled = () => new GraphQLError('That Agent is not installed in this App.', {
    extensions: { code: 'AGENT_NOT_INSTALLED' },
  });
  let agentId: string;
  try {
    ({ id: agentId } = await resolveAgentRef(ctx.db, agentRef));
  } catch (e) {
    if (e instanceof AgentNotFoundError) throw notInstalled();
    throw e;
  }
  // Resolve physical or derived membership through the shared installation
  // source, which also supplies the Agent identity used below.
  const appAgent = await resolveAppInstallation(ctx.db, appId, agentId);
  if (!appAgent) throw notInstalled();
  return appAgent.agent;
}

/**
 * #1573: an App-scoped memory write is an authority write. `createMemoryInApp`
 * (an `AgentMemoryItem` read link, or a personal/private memory pivoted on the
 * App's agent) and `attachMemoryToApp` (scoping a user's memory to the App and
 * its agent) both decide from the caller's App role or membership and from the
 * agent's install. Run the gate and the write in ONE anchored transaction,
 * holding the App, its owner (org or user), and the agent, the anchors their
 * revokers take exclusively (`removeAppMember`, `deleteApp`, uninstall,
 * `revokeAgentOrgGrant`). Inside it the App owner tuple is compared with the
 * locked row, the class gate re-runs on `txCtx`, and the install must still be
 * LIVE and licensed (`isAgentInstalledAndLicensed`): a retained AppAgent
 * pointer alone is not authority (#1526).
 */
async function withAppMemoryAuthorityTx<T>(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
  agentId: string,
  klass: AppMemoryClass,
  write: (tx: Prisma.TransactionClient, txCtx: Context) => Promise<T>,
): Promise<T> {
  return withAuthorizedTx(
    ctx,
    [
      { kind: 'app', id: app.id },
      ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
      ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
      { kind: 'agent', id: agentId },
    ],
    async (txCtx) => {
      const locked = await loadAppAndAuthorize(txCtx, app.id, klass);
      if (locked.organizationId !== app.organizationId || locked.ownerUserId !== app.ownerUserId) {
        throw new Error('App ownership changed; retry the operation');
      }
      if (!(await isAgentInstalledAndLicensed(txCtx.db, app.id, agentId))) {
        throw new GraphQLError('That Agent is not installed in this App.', {
          extensions: { code: 'AGENT_NOT_INSTALLED' },
        });
      }
    },
    write,
  );
}

/** #2843 / cor:acl:010:01: a user tenant's ACTUAL owner, or the existing org ADMIN gate; no user-App platform bypass. */
async function requireAppMemoryCreator(ctx: Context, app: { organizationId: string | null; ownerUserId: string | null }): Promise<void> {
  if (app.organizationId) await requireOrgRole(ctx, app.organizationId, 'ADMIN');
  else if (!ctx.userId || app.ownerUserId !== ctx.userId) throw authorizationDenied();
}


/** #5183: a collision answer for a personal/private memory carries no URN: the holder may not be the caller's. */
function conflictWithoutUrn(): GraphQLError {
  return new GraphQLError('That memory name is taken. Try again.', { extensions: { code: 'MEMORY_URN_CONFLICT' } });
}

/** A P2002 whose violated unique is the memory URN (Prisma reports the column list, or the index name, in meta.target). */
function isUrnUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  const names = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return names.some((n) => n === 'urn' || n.includes('urn'));
}

type UrnBlocker = { id: string; userId: string | null; appId: string | null; class: string; deletedAt: Date | null };

/**
 * #5183: every memory that holds `urn` as its `urn` or `legacyUrn` (live or soft-deleted) or that an alias row of type
 * MEMORY points the URN at. The mint takes a candidate only when this list is empty, or holds only the caller's own
 * soft-deleted memory of the same App and class, which the caller reclaims.
 */
async function findUrnBlockers(tx: Prisma.TransactionClient, urn: string): Promise<UrnBlocker[]> {
  const select = { id: true, userId: true, appId: true, class: true, deletedAt: true } as const;
  const direct = await tx.memory.findMany({ where: { OR: [{ urn }, { legacyUrn: urn }] }, select });
  const aliases = await tx.urnAlias.findMany({
    where: { urn: normalizeUrnForLookup(urn), entityType: 'MEMORY' },
    select: { entityId: true },
  });
  const known = new Set(direct.map((m) => m.id));
  const viaAlias = aliases.filter((a) => !known.has(a.entityId)).map((a) => a.entityId);
  const aliased = viaAlias.length > 0 ? await tx.memory.findMany({ where: { id: { in: viaAlias } }, select }) : [];
  // An alias whose memory row no longer exists (hard-deleted, e.g. reclaimed) resolves to nothing: it is not a holder.
  return [...direct, ...aliased];
}

export const appMemoryMutations = {
  /**
   * #2661 / cor:acl:010:01: NEW free-standing app memory, not an Agent's
   * install memory. #2843 admits the user-owned App's actual owner as ruled
   * by D2; org Apps keep the shared ADMIN gate. Only a person acting as
   * themselves creates. App/tenant anchors fence ownership, uninstall and revocation.
   */
  createAppMemory: async (
    _: unknown,
    { appRef, name, shortDescription, description, tags }: {
      appRef: string; name: string; shortDescription?: string; description?: string; tags?: string[];
    },
    ctx: Context,
  ) => {
    if (!ctx.userId || ctx.appKeyId || ctx.sessionId || ctx.sessionBindingRefused || ctx.impersonation || isRunPrincipal(ctx)) {
      throw authorizationDenied();
    }
    let id: string;
    try { ({ id } = await resolveAppRef(ctx.db, appRef)); }
    catch (error) {
      // #2843: a stranger and an unknown/deleted App have one public answer.
      // #4893: the whole shared resolution list folds — a malformed ref is the same answer.
      if (isAppRefResolutionFailure(error)) throw authorizationDenied();
      throw error;
    }
    const observed = await ctx.db.app.findUniqueOrThrow({ where: { id } });
    if (observed.deletedAt || observed.uninstalledAt) throw authorizationDenied();
    await requireAppMemoryCreator(ctx, observed);
    if (!name.trim()) throw new GraphQLError('Memory name must not be empty.', { extensions: { code: 'BAD_USER_INPUT' } });
    // #5149: the name's only refusals besides empty, after authorization and before any write.
    const desiredSlug = deriveMemorySlug(name);
    assertStorableText({ shortDescription, description, tags }); // #4106: caller text, refused typed before any write
    return withFsProjectionRollback(() => withAuthorizedTx(ctx, [
      ...(observed.organizationId ? [{ kind: 'org' as const, id: observed.organizationId }] : []),
      ...(observed.ownerUserId ? [{ kind: 'user' as const, id: observed.ownerUserId }] : []),
      { kind: 'app', id },
    ], async txCtx => {
      const current = await txCtx.db.app.findUniqueOrThrow({ where: { id } });
      if (current.organizationId !== observed.organizationId || current.ownerUserId !== observed.ownerUserId) {
        throw authorizationDenied();
      }
      await requireAppMemoryCreator(txCtx, current);
      // Uninstall takes the App anchor exclusively. Its committed removal is
      // observed here after any wait, and cannot pass this writer until commit.
      const installed = (await listAppInstallations(txCtx.db, id))[0];
      if (!installed) throw new GraphQLError('This App has no Agent installed.', {
        extensions: { code: 'AGENT_NOT_INSTALLED' },
      });
    }, async tx => {
      // Reload the canonical name after any anchor wait (e.g. an owner rename).
      const locked = await tx.app.findUniqueOrThrow({ where: { id } });
      // Same flat tenant root as createMemoryInApp; ownerUserId is tenancy, not a personal pivot.
      const root = locked.organizationId
        ? (await tx.organization.findUniqueOrThrow({ where: { id: locked.organizationId }, select: { urn: true } })).urn
        : locked.urn.split(':')[0]!;
      const urn = await mintMemoryUrnV2(tx, {
        root, desiredSlug, authorRoot: locked.urn.split(':').pop()!,
      });
      const memory = await tx.memory.create({ data: {
        id: generateId(), organizationId: observed.organizationId, ownerUserId: observed.ownerUserId, appId: id,
        urn, name, shortDescription, description, tags: tags ?? [], class: 'app',
        visibility: null, isInstallMemory: false, installOfAgentId: null,
        createdBy: ctx.userId,
      }, include: MEMORY_INCLUDE });
      // #3952 (R11): no root node on create. The memory row is this door's ONLY write: no org defaults, owner or
      // member row, agent grant or audit row follows it, so there is no later step whose failure needs a rollback pin
      // (resolvers.noRootNode3952.test.ts pins the doors that do have one). A write added after this row needs that pin.
      return memory;
    }));
  },

  createMemoryInApp: async (
    _: unknown,
    {
      appRef,
      agentRef,
      memoryClass,
      name,
      shortDescription,
      description,
      data,
      tags,
      vectorIndexEnabled,
      embeddingSource,
      maxRevCount,
    }: {
      appRef: string;
      agentRef: string;
      memoryClass: string;
      name?: string | null;
      shortDescription?: string;
      description?: string;
      data?: unknown;
      tags?: string[];
      vectorIndexEnabled?: boolean;
      embeddingSource?: EmbeddingSource;
      maxRevCount?: number | null;
    },
    ctx: Context,
  ) => {
    if (
      memoryClass !== 'app' &&
      memoryClass !== 'knowledge' &&
      memoryClass !== 'personal' &&
      memoryClass !== 'private'
    ) {
      throw new GraphQLError(
        `createMemoryInApp does not accept class='${memoryClass}'. Only ` +
          `'app', 'knowledge', 'personal', and 'private' can be scoped to an App.`,
        { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' } },
      );
    }
    const klass = memoryClass as AppMemoryClass;

    // #621 — friendly guard mirroring chk_memory_max_rev_count_positive.
    if (maxRevCount === null || (maxRevCount !== undefined && maxRevCount < 1)) {
      throw new GraphQLError('maxRevCount must be at least 1.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const isUserOwned = klass === 'personal' || klass === 'private';
    // #5183 (cor:dmo:060:20 S12, "Person only"): only the signed-in member acting as themselves creates a personal or
    // private memory. A run principal (even one carrying the member's user id), a worker session, a refused session
    // binding, an App key and an impersonation are refused the way createAppMemory refuses them, before any read of
    // the App. No user id at all keeps its own UNAUTHENTICATED answer from the class gate below.
    if (isUserOwned && ctx.userId && refusedAppUserMemoryPrincipal(ctx)) {
      throw authorizationDenied();
    }

    const app = await loadAppAndAuthorize(ctx, appRef, klass);
    const agent = await resolveInstalledAgent(ctx, app.id, agentRef);
    // A user-owned App is A4's (#5186): its personal/private creation stays refused.
    if (isUserOwned && !app.organizationUrn) {
      throw new GraphQLError(
        'Personal/private App-scoped memories are not yet supported for a user-owned App.',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    // #5183: a personal or private memory's slug and display name are derived by the server; `name` sets neither and
    // is not judged. app and knowledge keep the caller's name, so a missing one is refused after the gates.
    let slug = '';
    if (!isUserOwned) {
      if (name == null) {
        throw new GraphQLError('A name is required for an app or knowledge memory.', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      // #5149: the name's only refusals, after the gates and before the tombstone reclaim or any create.
      slug = deriveMemorySlug(name);
    }
    assertStorableText({ shortDescription, description, tags }); // #4106: caller text, refused typed before any write
    const agentSlug = agentSlugFromUrn(agent.urn);

    // The write shared by both paths: the row's columns are the caller's, `urn`/`name`/tenancy/marker come from the path.
    const createRow = async (
      tx: Prisma.TransactionClient,
      own: { urn: string; name: string; organizationId: string | null; ownerUserId: string | null; appUserMemory: boolean },
    ) => {
      const created = await tx.memory.create({
        data: {
          id: generateId(),
          organizationId: own.organizationId,
          ownerUserId: own.ownerUserId,
          urn: own.urn,
          name: own.name,
          appUserMemory: own.appUserMemory,
          shortDescription,
          description,
          ...(data !== undefined ? { data: data as InputJsonValue } : {}),
          tags: tags ?? [],
          // visibility: NULL for app/personal/private; ORGANIZATION for an
          // app-scoped knowledge memory (chk_memory_visibility_class permits a
          // non-null visibility only for knowledge/group). Access is App-scoped
          // regardless — #653 excludes app-scoped rows from org-visibility grants.
          visibility: klass === 'knowledge' ? 'ORGANIZATION' : null,
          class: klass,
          appId: app.id,
          // app/knowledge have no strict user owner or agent pivot;
          // personal/private carry the (app, user, agent) pivot required
          // by chk_memory_personal_agent_id + chk_personal_visibility_user.
          userMemoryOfAgentId: isUserOwned ? agent.id : null,
          userId: isUserOwned ? ctx.userId : null,
          vectorIndexEnabled: vectorIndexEnabled ?? false,
          ...(embeddingSource != null ? { embeddingSource } : {}),
          ...(maxRevCount != null ? { maxRevCount } : {}),
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: MEMORY_INCLUDE,
      });
      // #653: link an app-scoped knowledge memory to the App's agent so it is
      // readable via the App surface (getAppMemoryAccess → READ_ONLY). Nothing
      // else grants read on it — it is excluded from every org-wide gate, so this
      // link is the ONLY read path (besides platform ADMIN/OWNER). role='read':
      // agents read this reference content; writes stay with the org admin.
      // #1573: written in the same anchored transaction as the memory.
      if (klass === 'knowledge') {
        await tx.agentMemoryItem.create({
          data: {
            id: generateId(),
            agentId: agent.id,
            memoryId: created.id,
            role: 'read',
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
        });
      }
      // #3952 (R11): no root node on create.
      return created;
    };

    if (isUserOwned) {
      // #5183: a personal or private memory is always the person's own: owner and tenant are the user, the URN roots
      // on their handle. One live marked memory per (App, user, class); the name is derived INSIDE the authority
      // transaction, after every wait, so a handle or App rename that won the race is seen.
      const memoryClass2 = klass as 'personal' | 'private';
      // A concurrent create in ANOTHER App of the same slug can take our candidate between the probe and the insert
      // (the two lock different member rows). The loser re-runs the whole transaction and takes the next tail:
      // a name collision never refuses (R2).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await withFsProjectionRollback(() => withAppMemoryAuthorityTx(ctx, app, agent.id, klass, async (tx) => {
            // Lock order: advisory anchors, org/user/App/Agent rows FOR SHARE (the helper), then the caller's
            // app_members row, then an own tombstone row. A merge holds the users rows first, so this never
            // takes app_members before the helper.
            const member = await tx.$queryRaw<Array<{ user_id: string }>>`
              SELECT user_id FROM app_members WHERE app_id = ${app.id} AND user_id = ${ctx.userId!} FOR UPDATE`;
            if (member.length === 0) {
              throw new GraphQLError(
                'You must be a member of this App to add a personal/private memory to it.',
                { extensions: { code: 'FORBIDDEN' } },
              );
            }
            // A new statement after the lock: READ COMMITTED sees a winner that committed while we waited.
            if ((await heldAppUserMemoryClasses(tx, app.id, ctx.userId!)).includes(memoryClass2)) {
              throw new GraphQLError(
                `You already have a ${klass} memory in this App.`,
                { extensions: { code: 'APP_USER_MEMORY_ALREADY_EXISTS', memoryClass: klass } },
              );
            }
            // After every wait: the App's slug and the caller's handle are both in the name and the URN root.
            const lockedApp = await tx.app.findUniqueOrThrow({ where: { id: app.id }, select: { urn: true } });
            const owner = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId! }, select: { handle: true } });
            const appSlug = lockedApp.urn.split(':').pop()!;
            for (let n = 1; n <= APP_USER_MEMORY_MAX_TAIL; n++) {
              const candidate = appUserMemorySlug({ appSlug, handle: owner.handle, memoryClass: memoryClass2 }, n);
              const urn = `${owner.handle}:${candidate}`;
              const blockers = await findUrnBlockers(tx, urn);
              if (blockers.length > 0) {
                // Taken, unless every holder is the caller's OWN soft-deleted memory of this App and class (R6):
                // that row is removed to make room. Any other holder (another user's tombstone included) is
                // taken, and nothing of it is touched.
                const ownTombstones = blockers.filter((b) =>
                  b.deletedAt !== null && b.userId === ctx.userId && b.appId === app.id && b.class === klass);
                if (ownTombstones.length !== blockers.length) continue;
                // A tombstone the reclaim refuses to remove (it holds a question or a protected minted spec) keeps its
                // address: that candidate is taken and the next tail is tried, so a name collision never refuses (R2).
                // All-or-nothing per candidate: a savepoint undoes any tombstone already removed for this candidate.
                await tx.$executeRaw`SAVEPOINT app_user_memory_reclaim`;
                let kept = false;
                for (const b of ownTombstones.sort((x, y) => x.id.localeCompare(y.id))) {
                  try {
                    await reclaimTombstonedMemory(tx, b.id);
                  } catch (e) {
                    const code = e instanceof GraphQLError ? e.extensions?.code : undefined;
                    if (code !== 'QUESTION_CONTAINED' && code !== SPEC_MINTED_PERMANENT) throw e;
                    kept = true;
                    break;
                  }
                }
                if (kept) {
                  await tx.$executeRaw`ROLLBACK TO SAVEPOINT app_user_memory_reclaim`;
                  continue;
                }
                await tx.$executeRaw`RELEASE SAVEPOINT app_user_memory_reclaim`;
              }
              return createRow(tx, {
                urn, name: candidate, organizationId: null, ownerUserId: ctx.userId!, appUserMemory: true,
              });
            }
            throw conflictWithoutUrn();
          }));
        } catch (err) {
          // Only a collision on the URN is a name collision: any other unique violation is a real fault.
          if (isUrnUniqueViolation(err)) {
            if (attempt < 2) continue;
            throw conflictWithoutUrn();
          }
          throw err;
        }
      }
      // Unreachable: the last attempt returns or throws. Kept so the function's return type is total.
      throw conflictWithoutUrn();
    }

    // app / knowledge: unchanged. URN uses a registered role marker so :↔:: canonicalization stays correct
    // (MEMORY_ROLE_MARKERS). app-class is shared and name-addressable, hung under
    // the App URN (distinct from the runtime `:shared` memory); a duplicate name
    // is a real conflict.
    // #697 Stage 3: mint a FLAT single-atom v2 urn (`<root>:<slug>`). The
    // app-user/app-mem scope lives in the row columns (class/appId/userId/
    // userMemoryOfAgentId), not the URN path, so node URNs in the memory
    // round-trip through splitNodeUrn. Root is the owning org or user (from
    // the App URN); the Memory inherits the matching tenant-owner column.
    const memRoot = app.organizationUrn ?? app.urn.split(':')[0]!;
    // Recreate-after-delete keeps its clean slug: hard-delete an EXACT
    // soft-deleted collision on the desired slug before minting, so the mint
    // reuses the freed slug rather than aliasing around its own tombstone.
    const desiredSlug = slug;
    const tombstone = await ctx.db.memory.findFirst({
      where: { urn: `${memRoot}:${desiredSlug}`, deletedAt: { not: null } },
      select: { id: true },
    });
    // #1468 — refused for a stamped corpus still holding a spec.
    if (tombstone) await ctx.db.$transaction((tx) => reclaimTombstonedMemory(tx, tombstone.id));
    // A LIVE collision on a name-addressable app-mem slug now DETERMINISTICALLY
    // aliases (`<slug>-<agent>`) via mintLocalSlug — replacing the pre-v2 hard
    // MEMORY_URN_CONFLICT — so two apps/agents in one org can each name a memory
    // the same (they differ by the `appId`/agent columns). The mint probe covers
    // live + soft-deleted rows, so the minted urn is never already occupied.
    const memoryUrn = await mintMemoryUrnV2(ctx.db, {
      root: memRoot,
      desiredSlug,
      authorRoot: agentSlug,
    });

    let memory;
    try {
      memory = await withFsProjectionRollback(() => withAppMemoryAuthorityTx(ctx, app, agent.id, klass, async (tx) =>
        createRow(tx, {
          urn: memoryUrn, name: name!, organizationId: app.organizationId, ownerUserId: app.ownerUserId, appUserMemory: false,
        })));
    } catch (err) {
      // Race backstop: a concurrent create claimed the just-minted urn between
      // the mint probe and this insert (mintMemoryUrnV2 aliases around known
      // rows, so this only fires on a genuine race, not a same-name conflict).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new GraphQLError(`A memory with URN "${memoryUrn}" already exists.`, {
          extensions: { code: 'MEMORY_URN_CONFLICT', urn: memoryUrn },
        });
      }
      throw err;
    }

    return memory;
  },

  attachMemoryToApp: async (
    _: unknown,
    { memoryRef, appRef, agentRef }: { memoryRef: string; appRef: string; agentRef: string },
    ctx: Context,
  ) => {
    requireCallerIdentity(ctx);
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    const memory = await ctx.db.memory.findUniqueOrThrow({
      where: { id: memoryId },
      select: { id: true, class: true, appId: true, userId: true, organizationId: true },
    });

    // OWNERSHIP FIRST — before revealing anything about the memory's class or
    // app-scoped state. Attach is owner-only, so a non-owner must get a uniform
    // FORBIDDEN whatever the memory is; leaking class/appId here would let any
    // caller enumerate other users' (incl. private) memories.
    // #1381: a caller who cannot open this memory gets resolveMemoryRef's miss.
    await concealUnreadableDenial(ctx, memoryId, memoryRef, async () => {
      if (!ctx.userId || memory.userId !== ctx.userId) {
        throw new GraphQLError('You can only attach a memory you own.', {
          extensions: { code: 'FORBIDDEN' },
        });
      }
    });

    // Attach only applies to the owner-owned free-standing classes.
    if (memory.class !== 'personal' && memory.class !== 'private') {
      throw new GraphQLError(
        `Only personal/private memories can be attached to an App; this memory is class='${memory.class}'.`,
        { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' } },
      );
    }
    if (memory.appId) {
      throw new GraphQLError('This memory is already scoped to an App.', {
        extensions: { code: 'MEMORY_ALREADY_APP_SCOPED' },
      });
    }

    // Authorize against the target App (App membership — personal/private path).
    const app = await loadAppAndAuthorize(ctx, appRef, memory.class as AppMemoryClass);
    const agent = await resolveInstalledAgent(ctx, app.id, agentRef);

    if (memory.organizationId !== app.organizationId) {
      throw new GraphQLError("The memory does not belong to this App's organization.", {
        extensions: { code: 'ORGANIZATION_MISMATCH' },
      });
    }

    // Transfer can change the owner, class and organization after the
    // preflight checks. Recheck them under its Memory-row fence before setting
    // the App/Agent pivot; a stale attachment must not scope the new tenant's
    // knowledge or group memory to the former tenant's App.
    return withAppMemoryAuthorityTx(ctx, app, agent.id, memory.class as AppMemoryClass, async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR NO KEY UPDATE`;
      const current = await tx.memory.findUniqueOrThrow({
        where: { id: memory.id },
        select: { class: true, appId: true, userId: true, organizationId: true, deletedAt: true },
      });
      const txCtx = withoutRequestCaches(ctx, tx);
      await concealUnreadableDenial(txCtx, memoryId, memoryRef, async () => {
        if (!ctx.userId || current.deletedAt || current.userId !== ctx.userId) {
          throw new GraphQLError('You can only attach a memory you own.', {
            extensions: { code: 'FORBIDDEN' },
          });
        }
      });
      if (current.class !== 'personal' && current.class !== 'private') {
        throw new GraphQLError(`Only personal/private memories can be attached to an App; this memory is class='${current.class}'.`, {
          extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' },
        });
      }
      if (current.appId) {
        throw new GraphQLError('This memory is already scoped to an App.', {
          extensions: { code: 'MEMORY_ALREADY_APP_SCOPED' },
        });
      }
      if (current.organizationId !== app.organizationId) {
        throw new GraphQLError("The memory does not belong to this App's organization.", {
          extensions: { code: 'ORGANIZATION_MISMATCH' },
        });
      }
      // Keep URN/class/userId. Setting the agent satisfies
      // chk_memory_personal_agent_id (app-scoped ⇒ agent required).
      return tx.memory.update({
        where: { id: memory.id },
        data: { appId: app.id, userMemoryOfAgentId: agent.id, updatedBy: ctx.userId },
        include: MEMORY_INCLUDE,
      });
    });
  },
};
