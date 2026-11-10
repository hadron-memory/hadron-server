/**
 * #2043 (S6 PR 2, cor:agt:040:18, R30) — who may approve a boot prompt.
 *
 * The role alone selects nothing: a node in the boot-prompt family is
 * manager-approved only where it is PLACED, in an Agent's system memory or an
 * App's install memory. There the approver is whoever manages that Agent or
 * App (the shared {@link managesAgent} / {@link managesApp}, so this cannot
 * drift from S8's pointers or S9's compile), acting as themselves. Elsewhere
 * the role is plain and approval stays the ordinary writer's: no Agent or App
 * manager is resolved for an arbitrary memory.
 *
 * "As themselves" excludes a bound worker session (R30: a session never
 * approves a boot prompt, whatever its holder may do), a run (whose context
 * carries its user's id), and, through the shared predicates, an App key with
 * no user and an impersonation.
 *
 * The decision depends on the memory and the caller, not the node, so it is
 * taken once per call and applied to each LOCKED row by role
 * (`approveNodeInTransaction`), so a role changed after the check is still
 * judged.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { isInstallMemoryRow } from './auth/installMemory.js';
import { managesAgent, managesApp } from './auth/appManagement.js';
import { isRunPrincipal } from './auth/runPrincipal.js';
import { boundWorkerId } from './bootPrompt.js';

export type BootPromptApprovalRefusalCode = 'BOOT_PROMPT_WORKER_SESSION_REFUSED' | 'BOOT_PROMPT_APPROVAL_FORBIDDEN';

/** `placed` false: the role is plain in this memory, and nothing is refused for it. */
export type BootPromptApprovalGate =
  | { placed: false }
  | { placed: true; refusal: BootPromptApprovalRefusalCode | null };

export type BootPromptApprovalCaller = {
  db: Pick<PrismaClient, 'memory' | 'agent' | 'app' | 'orgMember' | 'appMember'>;
  userId?: string;
  impersonation?: unknown;
  roles?: readonly string[];
  clientId?: string | null;
};

/**
 * #2973 C1 (cor:agt:040:18, shared with S6's approval gate) — WHO a memory's boot
 * prompt is managed by: the App for an install memory, the Agent for its own system
 * memory, null anywhere else (no Agent or App manager is resolved for an arbitrary
 * memory). Carries the ownership columns the shared manager gates branch on, so the
 * approval gate below, the signature stamp's manager grade and the counting fence
 * all resolve the owner ONE way — the stamp's judged owner can never drift from the
 * placement rule the approval leg and the serve already apply. Read-only; pass a
 * transaction client to decide under the caller's own locks.
 */
export type BootPromptOwnerRef =
  | { kind: 'AGENT'; id: string; organizationId: string | null; ownerUserId: string | null }
  | { kind: 'APP'; id: string; organizationId: string | null; ownerUserId: string | null };

export async function bootPromptOwnerOfMemory(
  db: Pick<PrismaClient, 'memory' | 'agent' | 'app'>,
  memoryId: string,
): Promise<BootPromptOwnerRef | null> {
  const memory = await db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, isInstallMemory: true, appId: true },
  });
  if (!memory) return null;
  if (isInstallMemoryRow(memory)) {
    if (!memory.appId) return null;
    const app = await db.app.findUnique({
      where: { id: memory.appId },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    return app ? { kind: 'APP', ...app } : null;
  }
  // `agents.system_memory_id` is not UNIQUE in the schema: provisioning holds one Agent per system
  // memory, but nothing in the DB forbids two rows naming it. The stamp (at signing) and the counting
  // fence each resolve the owner independently, so an unordered findFirst could resolve DIFFERENT
  // Agents for one memory across those two reads and silently stop a signature counting (Bob P3-3,
  // delta review of deef730133). Deterministic lowest-id wins in both reads instead.
  const agent = await db.agent.findFirst({
    where: { systemMemoryId: memoryId },
    orderBy: { id: 'asc' },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  return agent ? { kind: 'AGENT', ...agent } : null;
}

/** Decide for one memory. Pass the transaction context to decide under the approval's own transaction. */
export async function bootPromptApprovalGate(
  ctx: BootPromptApprovalCaller,
  memoryId: string,
): Promise<BootPromptApprovalGate> {
  const owner = await bootPromptOwnerOfMemory(ctx.db, memoryId);
  if (!owner) return { placed: false };
  const manages = owner.kind === 'APP' ? () => managesApp(ctx, owner) : () => managesAgent(ctx, owner);
  if (boundWorkerId()) return { placed: true, refusal: 'BOOT_PROMPT_WORKER_SESSION_REFUSED' };
  if (isRunPrincipal(ctx)) return { placed: true, refusal: 'BOOT_PROMPT_APPROVAL_FORBIDDEN' };
  return { placed: true, refusal: (await manages()) ? null : 'BOOT_PROMPT_APPROVAL_FORBIDDEN' };
}

export const BOOT_PROMPT_APPROVAL_MESSAGES: Record<BootPromptApprovalRefusalCode, string> = {
  BOOT_PROMPT_WORKER_SESSION_REFUSED:
    'BOOT_PROMPT_WORKER_SESSION_REFUSED: a worker session never approves a boot prompt; its manager does it as themselves.',
  BOOT_PROMPT_APPROVAL_FORBIDDEN:
    'BOOT_PROMPT_APPROVAL_FORBIDDEN: a boot prompt here is approved only by whoever manages its Agent or App, as themselves.',
};
