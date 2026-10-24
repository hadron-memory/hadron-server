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

/** Decide for one memory. Pass the transaction context to decide under the approval's own transaction. */
export async function bootPromptApprovalGate(
  ctx: BootPromptApprovalCaller,
  memoryId: string,
): Promise<BootPromptApprovalGate> {
  const memory = await ctx.db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, isInstallMemory: true, appId: true },
  });
  if (!memory) return { placed: false };
  let manages: () => Promise<boolean>;
  if (isInstallMemoryRow(memory)) {
    if (!memory.appId) return { placed: false };
    const app = await ctx.db.app.findUnique({
      where: { id: memory.appId },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    if (!app) return { placed: false };
    manages = () => managesApp(ctx, app);
  } else {
    const agent = await ctx.db.agent.findFirst({
      where: { systemMemoryId: memoryId },
      select: { organizationId: true, ownerUserId: true },
    });
    if (!agent) return { placed: false };
    manages = () => managesAgent(ctx, agent);
  }
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
