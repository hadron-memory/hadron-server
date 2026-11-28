/**
 * #5077 (Billing F3a; cor:dmo:050:10, ruled 2026-11-24): the AI configuration a headless run resolves, in ONE place for the
 * mint, the runner's model hop and the automation consent (`executionIdentities`), so a preview never shows the identity of
 * a configuration the run would be refused.
 *
 * It is the shared walk (`resolveAiConfigWithFallback`) with the run's tenant, plus one rule for a run of an App a person
 * owns: only the App's own configuration or the Agent's own (`APP`, `AGENT`, whoever owns the Agent) may answer. An
 * `ORGANIZATION` or `HADRON_SERVER` answer is refused as no configuration at all (`NoAiConfigAvailableError`, which the run
 * records as NO_AI_CONFIG). The walk already closes both levels for a person's App (#5075, `aiConfigTenantFor`); this is the
 * second check, with a test of its own. A8 (#5025) changes the `HADRON_SERVER` line.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { NoAiConfigAvailableError, resolveAiConfigWithFallback, type ResolvedAiConfig } from '../aiConfig.js';
import { type OwnerRef, orgIdOf } from '../owner.js';

export async function resolveRunAiConfig(
  db: PrismaClient,
  name: string | null | undefined,
  ctx: { appId: string; agentId?: string | null; tenant: OwnerRef },
): Promise<ResolvedAiConfig> {
  const organizationId = orgIdOf(ctx.tenant);
  const resolved = await resolveAiConfigWithFallback(db, name, {
    appId: ctx.appId,
    agentId: ctx.agentId ?? undefined,
    organizationId: organizationId ?? undefined,
  });
  if (organizationId === null && (resolved.ownerType === 'ORGANIZATION' || resolved.ownerType === 'HADRON_SERVER')) {
    throw new NoAiConfigAvailableError(name ?? 'default', `context (app ${ctx.appId}, an App a person owns)`);
  }
  return resolved;
}
