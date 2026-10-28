/**
 * App-scoped memory mutations — add a memory to an App.
 *
 * `createMemory` (resolvers.mutation.memory.ts) deliberately creates only
 * FREE-STANDING memories (app_id / agent stay NULL) and rejects class='app'.
 * The legacy mutations are the explicit, caller-invokable way to add every
 * App-associable memory class to a chosen App:
 *
 *   - createAppMemory (#2661) — new org-admin-only app-class creation without
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
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { agentSlugFromUrn, deriveSlugFromName } from '../../../lib/urn.js';
import { createNode } from '../../../controller/operations/createNode.js';
import { reclaimTombstonedMemory } from '../../../lib/mintedSpecPermanence.js';
import { type Context, requireOrgRole, requireOwnerOrOrgRole, MEMORY_INCLUDE, concealUnreadableDenial, withoutRequestCaches } from './resolvers.helpers.js';

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
  // One query does the install check AND fetches the agent's urn (via the
  // AppAgent join) instead of isAgentInstalled + a separate agent read.
  const appAgent = await ctx.db.appAgent.findUnique({
    where: { appId_agentId: { appId, agentId } },
    select: { agent: { select: { id: true, urn: true } } },
  });
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

export const appMemoryMutations = {
  /**
   * #2661 / cor:acl:010:01: NEW free-standing app memory, not an Agent's
   * install memory. The org-admin gate is shared; the principal restriction
   * admits only a person acting as themselves. App/org authority anchors order
   * both installation removal and membership revocation before the decision.
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
    if (!name.trim()) throw new GraphQLError('Memory name must not be empty.', { extensions: { code: 'BAD_USER_INPUT' } });
    const { id } = await resolveAppRef(ctx.db, appRef);
    const observed = await ctx.db.app.findUniqueOrThrow({ where: { id } });
    if (!observed.organizationId) {
      throw new GraphQLError('Creating an app memory for a user-owned App is not yet supported.', {
        extensions: { code: 'USER_OWNED_APP_UNSUPPORTED' },
      });
    }
    await requireOrgRole(ctx, observed.organizationId, 'ADMIN');
    const memory = await withAuthorizedTx(ctx, [
      { kind: 'org', id: observed.organizationId }, { kind: 'app', id },
    ], async txCtx => {
      const current = await txCtx.db.app.findUniqueOrThrow({ where: { id } });
      if (current.organizationId !== observed.organizationId || current.ownerUserId !== observed.ownerUserId) {
        throw authorizationDenied();
      }
      await requireOrgRole(txCtx, observed.organizationId!, 'ADMIN');
      // Uninstall takes the App anchor exclusively. Its committed removal is
      // observed here after any wait, and cannot pass this writer until commit.
      const installed = await txCtx.db.appAgent.findFirst({
        where: { appId: id, agent: { deletedAt: null } }, select: { agentId: true },
      });
      if (!installed) throw new GraphQLError('This App has no Agent installed.', {
        extensions: { code: 'AGENT_NOT_INSTALLED' },
      });
    }, async tx => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: observed.organizationId! }, select: { urn: true } });
      const urn = await mintMemoryUrnV2(tx, {
        root: org.urn, desiredSlug: deriveSlugFromName(name), authorRoot: observed.urn.split(':').pop()!,
      });
      return tx.memory.create({ data: {
        id: generateId(), organizationId: observed.organizationId, appId: id,
        urn, name, shortDescription, description, tags: tags ?? [], class: 'app',
        visibility: null, isInstallMemory: false, installOfAgentId: null,
        createdBy: ctx.userId,
      }, include: MEMORY_INCLUDE });
    });
    await createNode({ memoryId: memory.id, loc: name, name: name.split(':').pop() ?? name,
      description: 'Root node for this memory.' });
    return memory;
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
      name: string;
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

    const app = await loadAppAndAuthorize(ctx, appRef, klass);
    const agent = await resolveInstalledAgent(ctx, app.id, agentRef);
    const agentSlug = agentSlugFromUrn(agent.urn);
    const slug = deriveSlugFromName(name);

    // URN uses a registered role marker so :↔:: canonicalization stays correct
    // (MEMORY_ROLE_MARKERS). app-class is shared and name-addressable, hung under
    // the App URN (distinct from the runtime `:shared` memory); a duplicate name
    // is a real conflict. personal/private are per-owner, so the URN MUST be
    // owner-unique — reuse the runtime per-user scheme (`app-user:<opaqueId>`,
    // hung under the org URN) rather than the name-slug, so two members can name
    // their own memories the same and one owner's names never leak to another.
    const isUserOwned = klass === 'personal' || klass === 'private';
    if (isUserOwned && !app.organizationUrn) {
      throw new GraphQLError(
        'Personal/private App-scoped memories are not yet supported for a user-owned App.',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    // #697 Stage 3: mint a FLAT single-atom v2 urn (`<root>:<slug>`). The
    // app-user/app-mem scope lives in the row columns (class/appId/userId/
    // userMemoryOfAgentId), not the URN path, so node URNs in the memory
    // round-trip through splitNodeUrn. Root is the owning org or user (from
    // the App URN); the Memory inherits the matching tenant-owner column.
    const memRoot = app.organizationUrn ?? app.urn.split(':')[0]!;
    // Recreate-after-delete keeps its clean slug: hard-delete an EXACT
    // soft-deleted collision on the desired slug before minting, so the mint
    // reuses the freed slug rather than aliasing around its own tombstone.
    // (app-user's fresh opaque id can't collide, so this only ever fires for a
    // named app-mem slug.)
    const desiredSlug = isUserOwned ? generateId() : slug;
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
      memory = await withAppMemoryAuthorityTx(ctx, app, agent.id, klass, async (tx) => {
      const created = await tx.memory.create({
        data: {
          id: generateId(),
          organizationId: app.organizationId,
          ownerUserId: app.ownerUserId,
          urn: memoryUrn,
          name,
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
      return created;
      });
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

    // Root node, as createMemory does.
    const rootName = name.split(':').pop() ?? name;
    await createNode({ memoryId: memory.id, loc: name, name: rootName });

    return memory;
  },

  attachMemoryToApp: async (
    _: unknown,
    { memoryRef, appRef, agentRef }: { memoryRef: string; appRef: string; agentRef: string },
    ctx: Context,
  ) => {
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
