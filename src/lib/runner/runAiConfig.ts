/**
 * #5077 (Billing F3a; cor:dmo:050:10, ruled 2026-11-24): the AI configuration a headless run resolves, in ONE place for the
 * mint, the runner's model hop and the automation consent (`executionIdentities`), so a preview never shows the identity of
 * a configuration the run would be refused.
 *
 * It is the shared walk (`resolveAiConfigWithFallback`) with the run's tenant, plus one rule for a run of an App a person
 * owns: only the App's own configuration or the Agent's own (`APP`, `AGENT`, whoever owns the Agent) may answer. An
 * `ORGANIZATION` or `HADRON_SERVER` answer is refused as no configuration at all (`NoAiConfigAvailableError`, which the run
 * records as NO_AI_CONFIG). The walk already closes both levels for a person's App (#5075, `aiConfigTenantFor`); this is the
 * second check, with a test of its own. #5025 (Billing A8): a `HADRON_SERVER` answer is admitted for a person's run only
 * while `creditGateActive()` holds (charging and the credit gate both on), the walk's own predicate.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { NoAiConfigAvailableError, resolveAiConfigWithFallback, type ResolvedAiConfig } from '../aiConfig.js';
import { type OwnerRef, orgIdOf } from '../owner.js';
import { creditGateActive } from '../metering/switches.js';

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
  if (personRunRefuses(ctx.tenant, resolved)) {
    throw new NoAiConfigAvailableError(name ?? 'default', personContext(ctx.appId));
  }
  return resolved;
}

/**
 * A person's run never takes an organization's configuration, and takes the platform's only while charging and the credit
 * gate are both on (#5025, the same predicate as the walk's platform level). An organization's run is never refused here.
 */
function personRunRefuses(tenant: OwnerRef, resolved: ResolvedAiConfig): boolean {
  if (orgIdOf(tenant) !== null) return false;
  return resolved.ownerType === 'ORGANIZATION' || (resolved.ownerType === 'HADRON_SERVER' && !creditGateActive());
}

const personContext = (appId: string): string => `context (app ${appId}, an App a person owns)`;

/**
 * #5025 (Billing A8, Holger's ruling 3, 2026-11-28): a run resolves its configuration once, at its first model hop, and keeps
 * it. For a person's run the platform's configuration was admitted only because charging and the credit gate were on, so at
 * EVERY model hop the runner asks again: once either switch is off, the run fails at that hop with the refusal a fresh run
 * would get (NoAiConfigAvailableError, recorded as NO_AI_CONFIG), and a billable path never becomes free on a toggle. Own-key
 * configurations and organizations' runs are never refused here.
 */
export function assertRunAiConfigStillOpen(
  tenant: OwnerRef,
  appId: string,
  resolved: ResolvedAiConfig,
  requested: string | null | undefined,
): void {
  // Named as the launch-time refusal names it (the REQUESTED name, else `default`), so the same condition reads the same.
  if (personRunRefuses(tenant, resolved)) throw new NoAiConfigAvailableError(requested ?? 'default', personContext(appId));
}

/**
 * The configuration name a run asks for: the trigger's override (`eventData.__aiConfigName`), else null (the walk's
 * `default`). The ONE reader of that key, shared by the mint (`mintAppRun`), the run's resolver (`appRunDeps`
 * `resolveConfig`), the automation consent (`configSelection`) and the mid-run refusal, so the four cannot read it apart.
 * Only a string counts; anything else is no override. An empty string is kept, as every reader kept it before: the walk
 * misses it and falls back to `default`.
 */
export function requestedAiConfigName(eventData: unknown): string | null {
  if (!eventData || typeof eventData !== 'object') return null;
  const name = (eventData as Record<string, unknown>).__aiConfigName;
  return typeof name === 'string' ? name : null;
}
