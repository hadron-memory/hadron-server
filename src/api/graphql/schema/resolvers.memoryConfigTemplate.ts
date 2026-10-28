/**
 * #1325 part (c) — the MemoryConfigTemplate API.
 *
 * A template is a named, reusable rulebook with EXACTLY ONE owner — the
 * Hadron server, an organization, a user or an App (CHECK
 * `chk_memory_config_template_owner`; the Scope owner-of-one mechanism with a
 * User owner). Templates are COPIED into a memory's config, never live-linked:
 * applying one is #1334, not here, and nothing here touches a config.
 *
 * ## Who may see and change a template: its owner's MANAGERS (H4)
 *
 * Holger's H4 (#1325, 2026-09-25): templates are read and managed by their
 * owner's admins — the same rule as a memory's config. Per owner:
 *   - HADRON_SERVER: a platform admin;
 *   - ORGANIZATION: an org ADMIN/OWNER (`requireOrgRole`, which also admits a
 *     platform admin);
 *   - USER: that user, strictly — no platform-admin bypass, no impersonation
 *     (the `requireOwnerOrOrgRole` user-owned rule);
 *   - APP: `requireOwnerOrOrgRole(app, 'ADMIN')` on a live, installed App.
 * Everyone else gets the answer a MISSING template gets: `memoryConfigTemplate`
 * is null, the list leaves it out, and a mutation's not-found is the same as
 * for a template that does not exist. Impersonation reads what its target may
 * manage inside the one shared org (the #876 support view) and never writes.
 *
 * ## Rules
 *
 * A template's rules are the node-role rule shape (part b) minus the
 * config-only columns (`locked`, `sourceTemplateId`), validated by the same
 * helpers: the #1322 rule-key grammar, references the SAVER can read (an
 * unreadable node answers NODE_NOT_FOUND like a missing one), NOT_A_TASK, the
 * validateBy invariant, and the fail-closed `*Required` markers (H5), re-checked
 * under a share lock inside the write. `update` REPLACES the rules wholesale
 * in one transaction, so a partial template is never visible; the template's
 * `revision` covers its rules (cli#716 Q1).
 */
import { GraphQLError } from 'graphql';
import { Prisma, type MemoryConfigTemplate, type MemoryConfigTemplateRule } from '../../../generated/prisma/index.js';
import {
  type Context,
  clampListTake,
  isPlatformAdmin,
  requireOrgRole,
  requireOwnerOrOrgRole,
  withoutRequestCaches,
} from './resolvers.helpers.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { EntityNotFoundError } from '../../../lib/entityRef/errors.js';
import { assertValidRuleRole } from '../../../lib/governedRole.js';
import { AiConfigValidationError, validateAiConfigName } from '../../../lib/aiConfig.js';
import { generateId } from '../../../lib/id.js';
import {
  type CreateNodeRoleRuleInput,
  type ResolvedRef,
  type Validator,
  assertValidateByHasTask,
  conflict,
  lockRuleRefs,
  refWrites,
  requireWriter,
  ruleRefFieldResolvers,
} from './resolvers.memoryConfig.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { forbiddenError } from '../../../lib/refusals.js';

export type TemplateOwnerType = 'HADRON_SERVER' | 'ORGANIZATION' | 'USER' | 'APP';

type OwnerColumns = Pick<MemoryConfigTemplate, 'hadronServerId' | 'organizationId' | 'ownerUserId' | 'appId'>;

/** A template rule as input: a node-role rule minus nothing — `role` is its identity within the template. */
export type TemplateRuleInput = CreateNodeRoleRuleInput;

export interface CreateMemoryConfigTemplateInput {
  name: string;
  description?: string | null;
  required?: boolean | null;
  rules?: TemplateRuleInput[] | null;
}

/** Omitted = unchanged. `rules`, when given, REPLACES the template's rules. `description: null` clears it. */
export type UpdateMemoryConfigTemplateInput = Partial<CreateMemoryConfigTemplateInput>;

/** A template that does not exist, is deleted, or that the caller may not manage — one answer for all. */
export class MemoryConfigTemplateNotFoundError extends EntityNotFoundError {
  constructor(ref: string) {
    super('MEMORY_CONFIG_TEMPLATE_NOT_FOUND', ref);
    this.name = 'MemoryConfigTemplateNotFoundError';
  }
}

function ownerTypeOf(t: OwnerColumns): TemplateOwnerType {
  if (t.hadronServerId) return 'HADRON_SERVER';
  if (t.organizationId) return 'ORGANIZATION';
  if (t.ownerUserId) return 'USER';
  return 'APP';
}

/** Refusal-only: an operational failure propagates rather than reading as "not yours". */
async function allowed(check: () => Promise<void>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') return false;
    throw e;
  }
}

/**
 * An owner that is gone owns nothing a manager can reach. An organization's
 * soft delete keeps its membership rows (`softDeleteOrganizationCore` stamps
 * the org only), so `requireOrgRole` alone would go on admitting its former
 * admins — to the org's own templates and to its Apps' (#1369 review).
 */
const LIVE_ORG_OR_NONE: Prisma.AppWhereInput = { OR: [{ organizationId: null }, { organization: { deletedAt: null } }] };

async function liveApp(ctx: Context, appId: string) {
  return ctx.db.app.findFirst({
    where: { id: appId, deletedAt: null, uninstalledAt: null, ...LIVE_ORG_OR_NONE },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
}

/** The MANAGE gate for a template's owner (H4). Boolean, so callers can conceal. */
async function canManageOwner(ctx: Context, owner: OwnerColumns): Promise<boolean> {
  if (owner.hadronServerId) {
    if (ctx.impersonation || !isPlatformAdmin(ctx)) return false;
    return !!(await ctx.db.hadronServer.findFirst({ where: { id: owner.hadronServerId, deletedAt: null }, select: { id: true } }));
  }
  if (owner.organizationId) {
    const org = await ctx.db.organization.findFirst({ where: { id: owner.organizationId, deletedAt: null }, select: { id: true } });
    return !!org && (await allowed(() => requireOrgRole(ctx, org.id, 'ADMIN')));
  }
  if (owner.ownerUserId) return !ctx.impersonation && !!ctx.userId && ctx.userId === owner.ownerUserId;
  const app = await liveApp(ctx, owner.appId!);
  return !!app && (await allowed(() => requireOwnerOrOrgRole(ctx, app, 'ADMIN')));
}

/**
 * The MANAGE gate asked AGAIN inside the write transaction, after its last lock
 * wait — the template twin of `reassertManage` in `resolvers.memoryConfig.ts`
 * (#1360 review, Codex P1). The pre-check authorizes the request; an admin
 * demoted or removed while the write waits on the owner, reference or template
 * locks must not still save. Asked fresh and on the transaction's own
 * connection, refused with the pre-check's own answer. The same residual as
 * there: a revocation committing after this read and before commit still saves.
 */
export async function reassertManageOwner(
  ctx: Context,
  tx: Prisma.TransactionClient,
  owner: OwnerColumns,
  refused: () => Error,
): Promise<void> {
  if (!(await canManageOwner(withoutRequestCaches(ctx, tx), owner))) throw refused();
}

/**
 * The server's own row. Server templates need a REAL `hadron_server` row (H6);
 * when none exists the create refuses with a typed error rather than guessing.
 * The oldest LIVE row.
 */
async function hadronServerId(ctx: Context): Promise<string> {
  const row = await ctx.db.hadronServer.findFirst({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!row) {
    throw new GraphQLError('This server has no hadron_server row, so it cannot own a template.', {
      extensions: { code: 'HADRON_SERVER_NOT_CONFIGURED' },
    });
  }
  return row.id;
}

function badInput(message: string, extensions: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT', ...extensions } });
}

/**
 * Turn `(ownerType, ownerRef)` into the owner columns, gated for WRITE. A
 * refused owner is `Forbidden`, as for a Scope's owner: naming an owner is a
 * statement about an entity the caller already addresses.
 */
async function resolveOwnerForWrite(ctx: Context, ownerType: TemplateOwnerType, ownerRef: string | null | undefined): Promise<OwnerColumns> {
  const ref = ownerRef?.trim() || null;
  const none = { hadronServerId: null, organizationId: null, ownerUserId: null, appId: null };
  switch (ownerType) {
    case 'HADRON_SERVER': {
      if (ctx.impersonation || !isPlatformAdmin(ctx)) throw forbiddenError();
      const id = await hadronServerId(ctx);
      if (ref && ref !== id) throw badInput('ownerRef does not name this server; omit it for a server-owned template.', { field: 'ownerRef' });
      return { ...none, hadronServerId: id };
    }
    case 'ORGANIZATION': {
      if (!ref) throw badInput('An organization-owned template needs ownerRef.', { field: 'ownerRef' });
      const { id } = await resolveOrgRef(ctx.db, ref);
      await requireOrgRole(ctx, id, 'ADMIN');
      return { ...none, organizationId: id };
    }
    case 'USER': {
      if (ctx.impersonation || !ctx.userId) throw forbiddenError();
      // A user owns templates for themselves only; the ref, when given, must be them.
      if (ref && (await resolveUserRef(ctx.db, ref)).id !== ctx.userId) throw forbiddenError();
      return { ...none, ownerUserId: ctx.userId };
    }
    case 'APP': {
      if (!ref) throw badInput('An App-owned template needs ownerRef.', { field: 'ownerRef' });
      const { id } = await resolveAppRef(ctx.db, ref);
      const app = await liveApp(ctx, id);
      if (!app) throw forbiddenError();
      await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
      return { ...none, appId: id };
    }
    default:
      throw badInput(`Unknown ownerType "${String(ownerType)}".`, { field: 'ownerType' });
  }
}

/** Resolve a template ref (its id) the caller may MANAGE, or throw the missing-template answer. */
export async function managedTemplate(ctx: Context, ref: string): Promise<MemoryConfigTemplate> {
  const t = await ctx.db.memoryConfigTemplate.findFirst({ where: { id: ref.trim(), deletedAt: null } });
  if (!t || !(await canManageOwner(ctx, t))) throw new MemoryConfigTemplateNotFoundError(ref);
  return t;
}

function assertTemplateName(name: string): string {
  try {
    return validateAiConfigName(name);
  } catch (e) {
    if (e instanceof AiConfigValidationError) {
      throw badInput('A template name is 1-64 lower-case letters, digits, "-" or "_", starting with a letter or digit.', {
        field: 'name',
      });
    }
    throw e;
  }
}

type PreparedRule = { data: Omit<Prisma.MemoryConfigTemplateRuleCreateManyInput, 'templateId'>; resolved: ResolvedRef[] };

/**
 * Validate and resolve a whole rule list BEFORE any write: the role grammar, a
 * role at most once, each reference, and the validateBy invariant per rule.
 */
async function prepareRules(ctx: Context, rules: TemplateRuleInput[]): Promise<PreparedRule[]> {
  const seen = new Set<string>();
  const out: PreparedRule[] = [];
  for (const rule of rules) {
    assertValidRuleRole(rule.role);
    if (seen.has(rule.role)) {
      throw new GraphQLError(`The template lists role "${rule.role}" more than once.`, {
        extensions: { code: 'NODE_ROLE_RULE_EXISTS', role: rule.role },
      });
    }
    seen.add(rule.role);
    const { cols, resolved } = await refWrites(ctx, rule);
    const validateBy = rule.validateBy ?? null;
    assertValidateByHasTask({
      validateBy: validateBy as Validator | null,
      validationTaskId: (cols.validationTaskId as string | null | undefined) ?? null,
      validationTaskRequired: (cols.validationTaskRequired as boolean | undefined) ?? false,
    });
    out.push({
      data: {
        id: generateId(),
        role: rule.role,
        ...(cols as Partial<Prisma.MemoryConfigTemplateRuleCreateManyInput>),
        ...(rule.strictSubRoles != null ? { strictSubRoles: rule.strictSubRoles } : {}),
        ...(rule.writers != null ? { writers: rule.writers } : {}),
        validateBy,
        ...(rule.enabled != null ? { enabled: rule.enabled } : {}),
      },
      resolved,
    });
  }
  return out;
}

/** A second live template of the same name under the same owner (the partial unique indexes). */
function translateNameTaken(e: unknown, name: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new GraphQLError(`This owner already has a template named "${name}".`, {
      extensions: { code: 'MEMORY_CONFIG_TEMPLATE_EXISTS', name },
    });
  }
  throw e;
}

type TemplateWithRules = MemoryConfigTemplate & { rules?: MemoryConfigTemplateRule[] };

/**
 * The rules read INSIDE the write's transaction, so a mutation's payload pairs
 * its own revision with its own rules. Resolved after commit, a concurrent
 * replacement could land in between and answer with another write's rules
 * (#1369 review).
 */
async function withRules(tx: Prisma.TransactionClient, t: MemoryConfigTemplate): Promise<TemplateWithRules> {
  return { ...t, rules: await tx.memoryConfigTemplateRule.findMany({ where: { templateId: t.id }, orderBy: { role: 'asc' } }) };
}

/**
 * Share-lock the owner's row and re-check it is live, inside the create's
 * transaction (#1369 review). The owner was resolved before the transaction,
 * so an owner soft-deleted in between would otherwise get a template — for a
 * user, one inserted AFTER `deleteUserAccount`'s template sweep, surviving the
 * erasure. `deleteUserAccount` takes the user row FOR UPDATE first, so with
 * this lock either the deletion commits first (the re-check sees it) or the
 * create does (the sweep sees the template). Taken BEFORE the node share
 * locks: account deletion goes user → nodes, and the same order cannot
 * deadlock against it.
 */
async function lockLiveOwner(tx: Prisma.TransactionClient, owner: OwnerColumns): Promise<void> {
  let live: unknown[];
  if (owner.ownerUserId) {
    live = await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${owner.ownerUserId} AND "deleted_at" IS NULL FOR SHARE`;
  } else if (owner.organizationId) {
    live = await tx.$queryRaw`SELECT 1 FROM "organizations" WHERE "id" = ${owner.organizationId} AND "deleted_at" IS NULL FOR SHARE`;
  } else if (owner.hadronServerId) {
    live = await tx.$queryRaw`SELECT 1 FROM "hadron_server" WHERE "id" = ${owner.hadronServerId} AND "deleted_at" IS NULL FOR SHARE`;
  } else {
    // The App row alone: its organization's liveness is re-read on the next
    // statement, since a join would be re-checked against a stale row
    // (findings:for-share-with-a-join-drops-concurrently-moved-rows).
    const rows = await tx.$queryRaw<{ organization_id: string | null }[]>`
      SELECT "organization_id" FROM "apps"
      WHERE "id" = ${owner.appId} AND "deleted_at" IS NULL AND "uninstalled_at" IS NULL FOR SHARE`;
    const orgId = rows[0]?.organization_id ?? null;
    live = rows.length && orgId
      ? await tx.$queryRaw`SELECT 1 FROM "organizations" WHERE "id" = ${orgId} AND "deleted_at" IS NULL FOR SHARE`
      : rows;
  }
  if (live.length === 0) throw forbiddenError();
}

/** Lock a template's row for the rest of the transaction and read it, or null when it is gone. */
export async function lockTemplate(tx: Prisma.TransactionClient, id: string): Promise<MemoryConfigTemplate | null> {
  await tx.$queryRaw`SELECT 1 FROM "memory_config_templates" WHERE "id" = ${id} FOR UPDATE`;
  return tx.memoryConfigTemplate.findFirst({ where: { id, deletedAt: null } });
}

/** Every owner the caller may manage, as a `where` over templates — the list's gate. */
async function manageableWhere(ctx: Context): Promise<Prisma.MemoryConfigTemplateWhereInput> {
  const or: Prisma.MemoryConfigTemplateWhereInput[] = [];
  const platform = !ctx.impersonation && isPlatformAdmin(ctx);
  if (platform) or.push({ hadronServer: { deletedAt: null } }, { organization: { deletedAt: null } });
  let adminOrgIds: string[] = [];
  if (!platform && ctx.userId) {
    // requireOrgRole's own predicate, as a set: a LIVE membership at ADMIN or
    // above, and under impersonation only the one shared org (#876).
    const rows = await ctx.db.orgMember.findMany({
      where: {
        userId: ctx.userId,
        ...LIVE_ORG_MEMBERSHIP,
        role: { in: ['ADMIN', 'OWNER'] },
        ...(ctx.impersonation ? { organizationId: ctx.impersonation.orgId } : {}),
      },
      select: { organizationId: true },
    });
    adminOrgIds = rows.map((r) => r.organizationId);
    if (adminOrgIds.length) or.push({ organizationId: { in: adminOrgIds } });
  }
  if (ctx.userId && !ctx.impersonation) or.push({ ownerUserId: ctx.userId });
  // App owners: a user-owned App's owner (never a platform admin, never
  // impersonation), or an admin of the App's org.
  const appOr: Prisma.AppWhereInput[] = [];
  if (ctx.userId && !ctx.impersonation) appOr.push({ ownerUserId: ctx.userId });
  if (platform) appOr.push({ organization: { deletedAt: null } });
  else if (adminOrgIds.length) appOr.push({ organizationId: { in: adminOrgIds } });
  if (appOr.length) or.push({ app: { deletedAt: null, uninstalledAt: null, AND: [LIVE_ORG_OR_NONE, { OR: appOr }] } });
  return or.length ? { OR: or } : { id: { in: [] } };
}

export interface MemoryConfigTemplateFilter {
  ownerType?: TemplateOwnerType | null;
  ownerRef?: string | null;
}

/** The filter's owner narrowing. An owner ref that does not resolve matches nothing, like an unmanaged one. */
async function filterWhere(ctx: Context, filter: MemoryConfigTemplateFilter | null | undefined): Promise<Prisma.MemoryConfigTemplateWhereInput> {
  const ownerType = filter?.ownerType ?? null;
  const ref = filter?.ownerRef?.trim() || null;
  if (!ownerType) {
    if (ref) throw badInput('filter.ownerRef needs filter.ownerType.', { field: 'ownerRef' });
    return {};
  }
  const resolve = async (fn: () => Promise<{ id: string }>): Promise<string | null> => {
    try {
      return (await fn()).id;
    } catch (e) {
      if (e instanceof EntityNotFoundError) return null;
      throw e;
    }
  };
  switch (ownerType) {
    case 'HADRON_SERVER':
      return ref ? { hadronServerId: ref } : { hadronServerId: { not: null } };
    case 'ORGANIZATION': {
      if (!ref) return { organizationId: { not: null } };
      return { organizationId: (await resolve(() => resolveOrgRef(ctx.db, ref))) ?? '' };
    }
    case 'USER': {
      if (!ref) return { ownerUserId: { not: null } };
      return { ownerUserId: (await resolve(() => resolveUserRef(ctx.db, ref))) ?? '' };
    }
    case 'APP': {
      if (!ref) return { appId: { not: null } };
      return { appId: (await resolve(() => resolveAppRef(ctx.db, ref))) ?? '' };
    }
    default:
      throw badInput(`Unknown ownerType "${String(ownerType)}".`, { field: 'ownerType' });
  }
}

export const memoryConfigTemplateQueries = {
  memoryConfigTemplate: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    try {
      return await managedTemplate(ctx, ref);
    } catch (e) {
      if (e instanceof MemoryConfigTemplateNotFoundError) return null;
      throw e;
    }
  },

  memoryConfigTemplates: async (
    _: unknown,
    { filter, limit, offset }: { filter?: MemoryConfigTemplateFilter | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const where: Prisma.MemoryConfigTemplateWhereInput = {
      AND: [{ deletedAt: null }, await manageableWhere(ctx), await filterWhere(ctx, filter)],
    };
    const take = clampListTake(limit);
    const skip = Math.max(0, offset ?? 0);
    const [total, page] = await Promise.all([
      ctx.db.memoryConfigTemplate.count({ where }),
      take === 0
        ? Promise.resolve([] as MemoryConfigTemplate[])
        : ctx.db.memoryConfigTemplate.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take, skip }),
    ]);
    // The page's rules in ONE query, not one per template (#1369 review): a
    // 200-item page would otherwise be 200 round trips for `rules`.
    const rules = page.length
      ? await ctx.db.memoryConfigTemplateRule.findMany({
          where: { templateId: { in: page.map((t) => t.id) } },
          orderBy: [{ templateId: 'asc' }, { role: 'asc' }],
        })
      : [];
    const byTemplate = new Map<string, MemoryConfigTemplateRule[]>(page.map((t) => [t.id, []]));
    for (const r of rules) byTemplate.get(r.templateId)!.push(r);
    const items: TemplateWithRules[] = page.map((t) => ({ ...t, rules: byTemplate.get(t.id)! }));
    return { items, total };
  },
};

export const memoryConfigTemplateMutations = {
  createMemoryConfigTemplate: async (
    _: unknown,
    { ownerType, ownerRef, input }: { ownerType: TemplateOwnerType; ownerRef?: string | null; input: CreateMemoryConfigTemplateInput },
    ctx: Context,
  ) => {
    const actor = requireWriter(ctx);
    const owner = await resolveOwnerForWrite(ctx, ownerType, ownerRef);
    const name = assertTemplateName(input.name);
    const rules = await prepareRules(ctx, input.rules ?? []);
    try {
      const template = await ctx.db.$transaction(async (tx) => {
        await lockLiveOwner(tx, owner);
        await lockRuleRefs(ctx, tx, rules.flatMap((r) => r.resolved));
        await reassertManageOwner(ctx, tx, owner, () => forbiddenError());
        const id = generateId();
        const created = await tx.memoryConfigTemplate.create({
          data: {
            id,
            name,
            description: input.description ?? null,
            ...(input.required != null ? { required: input.required } : {}),
            ...owner,
            createdBy: actor,
            updatedBy: actor,
          },
        });
        if (rules.length) await tx.memoryConfigTemplateRule.createMany({ data: rules.map((r) => ({ ...r.data, templateId: id })) });
        return withRules(tx, created);
      });
      return { template, warnings: [] };
    } catch (e) {
      translateNameTaken(e, name);
    }
  },

  updateMemoryConfigTemplate: async (
    _: unknown,
    { ref, input, expectedRevision }: { ref: string; input: UpdateMemoryConfigTemplateInput; expectedRevision?: number | null },
    ctx: Context,
  ) => {
    const actor = requireWriter(ctx);
    const { id } = await managedTemplate(ctx, ref);
    const name = input.name != null ? assertTemplateName(input.name) : undefined;
    const rules = input.rules != null ? await prepareRules(ctx, input.rules) : null;
    try {
      const template = await ctx.db.$transaction(async (tx) => {
        await lockRuleRefs(ctx, tx, (rules ?? []).flatMap((r) => r.resolved));
        const current = await lockTemplate(tx, id);
        if (!current) throw new MemoryConfigTemplateNotFoundError(ref);
        await reassertManageOwner(ctx, tx, current, () => new MemoryConfigTemplateNotFoundError(ref));
        if (expectedRevision != null && current.revision !== expectedRevision) throw conflict(current.revision, 'template');
        const updated = await tx.memoryConfigTemplate.update({
          where: { id },
          data: {
            ...(name !== undefined ? { name } : {}),
            ...('description' in input && input.description !== undefined ? { description: input.description } : {}),
            ...(input.required != null ? { required: input.required } : {}),
            updatedBy: actor,
            revision: { increment: 1 },
          },
        });
        if (rules) {
          // Wholesale, inside the same transaction: no reader sees a mix.
          await tx.memoryConfigTemplateRule.deleteMany({ where: { templateId: id } });
          if (rules.length) await tx.memoryConfigTemplateRule.createMany({ data: rules.map((r) => ({ ...r.data, templateId: id })) });
        }
        return withRules(tx, updated);
      });
      return { template, warnings: [] };
    } catch (e) {
      translateNameTaken(e, name ?? '');
    }
  },

  deleteMemoryConfigTemplate: async (
    _: unknown,
    { ref, expectedRevision }: { ref: string; expectedRevision?: number | null },
    ctx: Context,
  ) => {
    const actor = requireWriter(ctx);
    const { id } = await managedTemplate(ctx, ref);
    await ctx.db.$transaction(async (tx) => {
      const current = await lockTemplate(tx, id);
      if (!current) throw new MemoryConfigTemplateNotFoundError(ref);
      await reassertManageOwner(ctx, tx, current, () => new MemoryConfigTemplateNotFoundError(ref));
      if (expectedRevision != null && current.revision !== expectedRevision) throw conflict(current.revision, 'template');
      // Soft delete. Configs it was applied to keep their copies (copied, not live-linked).
      await tx.memoryConfigTemplate.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: actor, updatedBy: actor, revision: { increment: 1 } },
      });
    });
    return true;
  },
};

export const memoryConfigTemplateFieldResolvers = {
  MemoryConfigTemplate: {
    ownerType: (t: MemoryConfigTemplate) => ownerTypeOf(t),
    // The server's row id is not exposed anywhere else, so a server-owned template has none here either.
    ownerId: (t: MemoryConfigTemplate) => t.organizationId ?? t.ownerUserId ?? t.appId ?? null,
    // Reached only through the manage gate; the rows are that template's. A
    // mutation hands its in-transaction snapshot and the list its batched
    // page; a single read queries afresh (its revision still guards any write
    // made from it).
    rules: (t: TemplateWithRules, _: unknown, ctx: Context) =>
      t.rules ?? ctx.db.memoryConfigTemplateRule.findMany({ where: { templateId: t.id }, orderBy: { role: 'asc' } }),
  },
  MemoryConfigTemplateRule: ruleRefFieldResolvers,
};
