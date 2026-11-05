/**
 * #1327 — the `TASK_LESS_VISIBLE` warning on a saved rule.
 *
 * A rule binds the people who read the memory it governs: when a node of that
 * memory is written, the rule's author and validation tasks are what they are
 * pointed at. The manager saving the rule can read the task, but some reader of
 * the memory may not. That is advisory: the save is never refused and nothing is
 * granted. It rides on create rule, update rule and apply (dry run and real);
 * template save has no target memory, so it carries none.
 *
 * ## What is compared
 *
 * Per task reference of the RESULTING rule (unchanged refs included), in the
 * caller's own reference projection (`refViewOnce`, the same call the rule's
 * `authorTask*` fields make, so the warning and the rule always agree):
 *
 *   | the caller's projection | warning                                              |
 *   | ----------------------- | ---------------------------------------------------- |
 *   | NONE                    | none                                                 |
 *   | UNREADABLE / BROKEN     | emitted, `taskUrn` null, that state; NO comparison   |
 *   | OK                      | emitted only when containment is not proven          |
 *
 * `taskUrn` is exactly `refView.urn` (null for an OK legacy address that does
 * not round-trip). Nothing the projection withholds is ever looked up or named,
 * so the warning cannot tell a manager whether a task they cannot read exists.
 *
 * ## Containment, by grant source ({@link taskMemoryCoversTargetReaders})
 *
 * The audience is the readers of the ONE target memory. It is compared source by
 * source and never by enumerating users. Containment is PROVEN only when:
 *
 *   - the task lives in the target memory itself; or
 *   - the task's memory is readable by everyone (PUBLIC knowledge, anonymous gate); or
 *   - the target is a personal/private memory: its strict owner and each explicit
 *     share grantee read the task's memory under the shared node-content gate; or
 *   - the target is a user-owned memory: its owner does; or
 *   - the target is a group memory: each MemoryMember does; or
 *   - the target is org-owned knowledge with no subscriber, App or Agent link, no
 *     unrevoked App write or automation read grant, and not PUBLIC, and the task's memory is org knowledge of that SAME org.
 *
 * A live App write grant or automation read grant on the target makes any non-public
 * task unproven for every class, because those runs reach the memory outside the read gate.
 * Every other shape (an App, team, session, worker or system memory, a PUBLIC
 * target, a target with subscribers or Agent links, more explicit principals than
 * {@link MAX_POINT_CHECKED_PRINCIPALS}) cannot be proven and WARNS. A false
 * warning costs a manager one line; a false silence is the defect, so there is no
 * capped scan and no "same org means access" shorthand.
 *
 * ## A fault in these advisory reads
 *
 * The rule is already saved by the time this runs. A failed read for one reference
 * therefore never errors the mutation and never reads as clean: it emits the same
 * `TASK_LESS_VISIBLE` (containment not established, which is not proof that an extra
 * reader exists). `taskUrn`/`taskState` come only from the caller's own projection when
 * that read worked; when the projection itself failed both are null. Nothing is retried.
 *
 * Explicit principals are point-checked with the shared gate
 * (`getAccessibleMemoryIds`), asked as that user with no platform role, which can
 * only understate their reach (a false warning, never a false silence).
 */
import type { PrismaClient } from '../../../generated/prisma/index.js';
import { getAccessibleMemoryIds, type Context } from './resolvers.helpers.js';
import { refViewOnce, type RuleRefRow } from './resolvers.memoryConfig.js';

export const TASK_LESS_VISIBLE = 'TASK_LESS_VISIBLE';

/** More explicit principals than this cannot be point-checked within a bounded read, so the target warns. */
export const MAX_POINT_CHECKED_PRINCIPALS = 50;

export interface MemoryConfigWarning {
  code: string;
  role: string;
  field: string | null;
  taskUrn: string | null;
  taskState: 'NONE' | 'OK' | 'BROKEN' | 'UNREADABLE' | null;
}

/** A rule as it will read after the write: its role and reference columns. */
export type WarnableRule = RuleRefRow & { role: string };

type CoverageMemo = Map<string, Promise<boolean>>;

const TASK_KINDS = ['authorTask', 'validationTask'] as const;

/**
 * The warnings for `rules`, all governing `targetMemoryId`. Reads only; every
 * lookup is bounded by the rules passed in and the target's explicit principals.
 */
export async function taskVisibilityWarnings(
  ctx: Context,
  targetMemoryId: string,
  rules: readonly WarnableRule[],
): Promise<MemoryConfigWarning[]> {
  const memo: CoverageMemo = new Map();
  const out: MemoryConfigWarning[] = [];
  for (const rule of rules) {
    for (const field of TASK_KINDS) {
      // Only the advisory reads are caught, per reference, and never retried: this function runs after
      // the deciding gates and the commit, so a fault here must not turn a saved rule into an error.
      // A fault fails toward the warning (containment not established), never toward `warnings: []`.
      let view: Awaited<ReturnType<typeof refViewOnce>>;
      try {
        view = await refViewOnce(ctx, rule, field);
      } catch (error) {
        // The projection itself is unavailable, so no state or URN is invented. A reference that is
        // absent never reads anything, so a fault here means one exists.
        logAdvisoryFault(rule.role, field, error);
        out.push({ code: TASK_LESS_VISIBLE, role: rule.role, field, taskUrn: null, taskState: null });
        continue;
      }
      if (view.state === 'NONE') continue;
      if (view.state === 'OK') {
        try {
          const node = await ctx.db.node.findUnique({ where: { id: view.id! }, select: { memoryId: true } });
          if (node && (await coverageOnce(ctx.db, memo, targetMemoryId, node.memoryId))) continue;
        } catch (error) {
          logAdvisoryFault(rule.role, field, error);
        }
      }
      out.push({ code: TASK_LESS_VISIBLE, role: rule.role, field, taskUrn: view.urn, taskState: view.state });
    }
  }
  return out;
}

/** Names the rule's role and field and the error's class only: never the error text, a URL or any task content. */
function logAdvisoryFault(role: string, field: string, error: unknown): void {
  console.warn(`[#1327] task visibility check failed (${error instanceof Error ? error.name : 'unknown'}); warning conservatively`, { role, field });
}

function coverageOnce(db: PrismaClient, memo: CoverageMemo, targetId: string, taskMemoryId: string): Promise<boolean> {
  const key = `${targetId}:${taskMemoryId}`;
  let pending = memo.get(key);
  if (!pending) memo.set(key, (pending = taskMemoryCoversTargetReaders(db, memo, targetId, taskMemoryId)));
  return pending;
}

/** Can `userId` read `memoryId` under the shared node-content gate? Asked as that user, with no platform role. */
async function userReadsMemory(db: PrismaClient, memo: CoverageMemo, userId: string, memoryId: string): Promise<boolean> {
  const key = `u:${userId}:${memoryId}`;
  let pending = memo.get(key);
  if (!pending) {
    pending = getAccessibleMemoryIds({ db, userId, roles: [] } as Context, memoryId).then(
      (ids) => ids === null || ids.includes(memoryId),
    );
    memo.set(key, pending);
  }
  return pending;
}

async function everyUserReads(db: PrismaClient, memo: CoverageMemo, userIds: readonly string[], memoryId: string): Promise<boolean> {
  for (const id of userIds) if (!(await userReadsMemory(db, memo, id, memoryId))) return false;
  return true;
}

const MEMORY_SHAPE = {
  id: true, class: true, userId: true, ownerUserId: true, organizationId: true, appId: true,
  userMemoryOfAgentId: true, visibility: true, isInstallMemory: true,
} as const;

/**
 * True only when every reader of the target is proven to read the task's memory.
 * Fails toward `false` (a warning): see the module header for the proven shapes.
 */
export async function taskMemoryCoversTargetReaders(
  db: PrismaClient,
  memo: CoverageMemo,
  targetId: string,
  taskMemoryId: string,
): Promise<boolean> {
  if (targetId === taskMemoryId) return true;
  const [target, task] = await Promise.all([
    db.memory.findFirst({ where: { id: targetId, deletedAt: null }, select: MEMORY_SHAPE }),
    db.memory.findFirst({ where: { id: taskMemoryId, deletedAt: null }, select: MEMORY_SHAPE }),
  ]);
  if (!target || !task) return false;

  // Everyone reads it: PUBLIC knowledge, by the same predicate and the anonymous gate.
  if (
    task.visibility === 'PUBLIC' && task.appId === null && task.userMemoryOfAgentId === null && task.ownerUserId === null &&
    task.class !== 'personal' && task.class !== 'private' && task.class !== 'system' &&
    (await getAccessibleMemoryIds({ db, roles: [] } as Context, task.id))?.includes(task.id)
  ) return true;

  // App, team, session, worker and install audiences are not enumerable here.
  if (target.appId !== null || target.userMemoryOfAgentId !== null || target.isInstallMemory ||
      target.class === 'app' || target.class === 'system') return false;

  // An App's runs reach a memory through a live write or automation read grant on it, a reach that does not
  // pass through the shared read gate and is not enumerable here. Any unrevoked grant makes containment unproven.
  const [writeGrants, automationGrants] = await Promise.all([
    db.appMemoryWriteGrant.count({ where: { memoryId: target.id, revokedAt: null } }),
    db.appAutomationReadGrant.count({ where: { memoryId: target.id, revokedAt: null } }),
  ]);
  if (writeGrants > 0 || automationGrants > 0) return false;

  if (target.class === 'personal' || target.class === 'private') {
    if (!target.userId) return false;
    const grantees = target.class === 'personal'
      ? await db.memoryShare.findMany({ where: { memoryId: target.id }, select: { granteeId: true }, take: MAX_POINT_CHECKED_PRINCIPALS + 1 })
      : [];
    if (grantees.length > MAX_POINT_CHECKED_PRINCIPALS) return false;
    return everyUserReads(db, memo, [target.userId, ...grantees.map((g) => g.granteeId)], task.id);
  }

  // Other classes can be reached through an Agent's memory item (an App participant's audience).
  if (await db.agentMemoryItem.count({ where: { memoryId: target.id, deletedAt: null } }) > 0) return false;

  if (target.ownerUserId !== null) return userReadsMemory(db, memo, target.ownerUserId, task.id);

  if (target.class === 'group') {
    const members = await db.memoryMember.findMany({ where: { memoryId: target.id }, select: { userId: true }, take: MAX_POINT_CHECKED_PRINCIPALS + 1 });
    if (members.length > MAX_POINT_CHECKED_PRINCIPALS) return false;
    return everyUserReads(db, memo, members.map((m) => m.userId), task.id);
  }

  if (target.class === 'knowledge' && target.organizationId !== null && target.visibility !== 'PUBLIC') {
    if (await db.memorySubscription.count({ where: { memoryId: target.id, deletedAt: null } }) > 0) return false;
    // Every org member reads org knowledge of the same org (the org-readable clause); nothing wider is assumed.
    return task.class === 'knowledge' && task.organizationId === target.organizationId &&
      task.appId === null && task.userMemoryOfAgentId === null && task.ownerUserId === null;
  }
  return false;
}
