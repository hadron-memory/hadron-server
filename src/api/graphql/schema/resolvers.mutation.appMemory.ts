/**
 * App-scoped memory mutations — add a memory to an App.
 *
 * `createMemory` (resolvers.mutation.memory.ts) deliberately creates only
 * FREE-STANDING memories (app_id / agent stay NULL) and rejects class='app'.
 * These two mutations are the explicit, caller-invokable way to add every
 * App-associable memory class to a chosen App:
 *
 *   - createMemoryInApp — create a new memory born App-scoped (app | personal |
 *     private).
 *   - attachMemoryToApp — bind an existing free-standing personal/private memory
 *     to an App (an app-class memory can't exist free-standing, so it has
 *     nothing to attach).
 *
 * Split auth model (matches the App membership model, cf. requireAiConfigPicker
 * Access):
 *   - class='app' is shared deployment data → org OWNER/ADMIN (requireOrgRole).
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
import { generateId } from '../../../lib/id.js';
import { Prisma, type EmbeddingSource } from '../../../generated/prisma/index.js';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { isAgentInstalled } from '../../../lib/appAgent.js';
import { agentSlugFromUrn, deriveSlugFromName } from '../../../lib/urn.js';
import { createNode } from '../../../controller/operations/createNode.js';
import { type Context, requireOrgRole, MEMORY_INCLUDE } from './resolvers.helpers.js';

/** App-associable memory classes (the DB CHECK forbids app_id on the others). */
type AppMemoryClass = 'app' | 'personal' | 'private';

/**
 * Load the target App, reject an uninstalled one, and enforce the class-split
 * authorization. Returns the loaded App (id, urn, organizationId).
 */
async function loadAppAndAuthorize(
  ctx: Context,
  appRef: string,
  klass: AppMemoryClass,
): Promise<{ id: string; urn: string; organizationId: string }> {
  const { id: appId } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findUniqueOrThrow({
    where: { id: appId },
    select: { id: true, urn: true, organizationId: true, uninstalledAt: true },
  });
  // resolveAppRef filters uninstalledAt on the URN path but NOT the ID path —
  // re-check explicitly (mirrors installAgentIntoAppCore).
  if (app.uninstalledAt) {
    throw new GraphQLError('This App has been uninstalled and cannot be written to.', {
      extensions: { code: 'APP_UNINSTALLED' },
    });
  }

  if (klass === 'app') {
    // Shared deployment data — an org-management action.
    await requireOrgRole(ctx, app.organizationId, 'ADMIN');
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
  return { id: app.id, urn: app.urn, organizationId: app.organizationId };
}

/** Resolve the agent and assert it is installed in the App. */
async function resolveInstalledAgent(
  ctx: Context,
  appId: string,
  agentRef: string,
): Promise<{ id: string; urn: string }> {
  const { id: agentId } = await resolveAgentRef(ctx.db, agentRef);
  if (!(await isAgentInstalled(ctx.db, appId, agentId))) {
    throw new GraphQLError('That Agent is not installed in this App.', {
      extensions: { code: 'AGENT_NOT_INSTALLED' },
    });
  }
  const agent = await ctx.db.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { id: true, urn: true },
  });
  return { id: agent.id, urn: agent.urn };
}

export const appMemoryMutations = {
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
    if (memoryClass !== 'app' && memoryClass !== 'personal' && memoryClass !== 'private') {
      throw new GraphQLError(
        `createMemoryInApp does not accept class='${memoryClass}'. Only ` +
          `'app', 'personal', and 'private' can be scoped to an App.`,
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
    let memoryUrn: string;
    if (isUserOwned) {
      const memOrg = await ctx.db.organization.findUniqueOrThrow({
        where: { id: app.organizationId },
        select: { urn: true },
      });
      memoryUrn = `${memOrg.urn}:${agentSlug}:app-user:${generateId()}`;
    } else {
      memoryUrn = `${app.urn}:${agentSlug}:app-mem:${slug}`;
    }

    // URN uniqueness is the only dedup (no composite unique on Memory). A live
    // collision is a conflict; a soft-deleted one is cleared and reused.
    const existing = await ctx.db.memory.findUnique({ where: { urn: memoryUrn } });
    if (existing) {
      if (existing.deletedAt) {
        await ctx.db.memory.delete({ where: { id: existing.id } });
      } else {
        throw new GraphQLError(`A memory with URN "${memoryUrn}" already exists.`, {
          extensions: { code: 'MEMORY_URN_CONFLICT', urn: memoryUrn },
        });
      }
    }

    let memory;
    try {
      memory = await ctx.db.memory.create({
        data: {
          id: generateId(),
          organizationId: app.organizationId,
          urn: memoryUrn,
          name,
          shortDescription,
          description,
          ...(data !== undefined ? { data: data as InputJsonValue } : {}),
          tags: tags ?? [],
          // visibility MUST be NULL for app/personal/private (chk_memory_visibility_class).
          visibility: null,
          class: klass,
          appId: app.id,
          // app-class is agent-scoped-by-URN only (no owner, no agent pivot);
          // personal/private carry the (app, user, agent) pivot required by
          // chk_memory_personal_agent_id + chk_personal_visibility_user.
          userMemoryOfAgentId: isUserOwned ? agent.id : null,
          userId: isUserOwned ? ctx.userId : null,
          vectorIndexEnabled: vectorIndexEnabled ?? false,
          ...(embeddingSource != null ? { embeddingSource } : {}),
          ...(maxRevCount != null ? { maxRevCount } : {}),
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: MEMORY_INCLUDE,
      });
    } catch (err) {
      // Race on the unique URN between the pre-check and the insert.
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
    if (!ctx.userId || memory.userId !== ctx.userId) {
      throw new GraphQLError('You can only attach a memory you own.', {
        extensions: { code: 'FORBIDDEN' },
      });
    }

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

    // Set the (app, agent) pivot; keep URN/class/userId. Setting the agent
    // satisfies chk_memory_personal_agent_id (app-scoped ⇒ agent required).
    return ctx.db.memory.update({
      where: { id: memory.id },
      data: { appId: app.id, userMemoryOfAgentId: agent.id, updatedBy: ctx.userId },
      include: MEMORY_INCLUDE,
    });
  },
};
