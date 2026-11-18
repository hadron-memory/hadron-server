/**
 * Page-monitor watches (`web_poll_*`, #667) addressed by org: the one place
 * the core routing binding is read to list a watch and written to cancel it,
 * shared by the run tools and the interactive GraphQL / MCP surface (#1562).
 * hadrontool-webfetch owns job state; core owns which org a job belongs to.
 */
import { evaluatePolicyChain, parsePolicyLink } from '@hadron-memory/access-control';
import type { PrismaClient } from '../generated/prisma/index.js';
import { cancelPoll, listPolls, type WebPollStatus } from './webfetchClient.js';

/** The policy action every `web_poll_*` surface walks (cost differs by tool, the action does not). */
export const WEB_POLL_POLICY_ACTION = 'tool.web_poll';

/** A watch as listed: the sidecar's status and counters, plus the binding's redacted URL and App. */
export type OrgWebPoll = Omit<WebPollStatus, 'url' | 'orgId'> & {
  url: string;
  appId: string;
  sourceRunId: string;
  createdAt: Date;
};

/**
 * The org's active watches. The sidecar is asked by org, then every job is
 * matched to a core binding IN THIS ORG: a job with no binding here (another
 * org's, or one that could never deliver) is dropped rather than trusted. The
 * URL shown is the binding's query- and fragment-free ledger URL, never the
 * sidecar's, which can carry credentials in its query string.
 */
export async function listOrgWebPolls(db: PrismaClient, organizationId: string): Promise<OrgWebPoll[]> {
  const { jobs } = await listPolls(organizationId);
  if (jobs.length === 0) return [];
  const bindings = await db.webFetchPollBinding.findMany({
    where: { organizationId, jobId: { in: jobs.map((j) => j.jobId) } },
    select: { jobId: true, url: true, appId: true, sourceRunId: true, createdAt: true },
  });
  const byJob = new Map(bindings.map((b) => [b.jobId, b]));
  const out: OrgWebPoll[] = [];
  for (const job of jobs) {
    const b = byJob.get(job.jobId);
    if (!b) continue;
    const { url: _sidecarUrl, orgId: _orgId, appId: _appId, ...status } = job;
    out.push({ ...status, url: b.url, appId: b.appId, sourceRunId: b.sourceRunId, createdAt: b.createdAt });
  }
  return out;
}

/**
 * Cancel one of the org's watches. `null` means the job is not in this org
 * (missing and another org's read the same). Sidecar first, binding second:
 * if the sidecar call fails the binding stays uncancelled, so a retry still
 * reaches the sidecar.
 */
export async function cancelOrgWebPoll(
  db: PrismaClient,
  organizationId: string,
  jobId: string,
): Promise<{ jobId: string; cancelled: true; alreadyCancelled: boolean } | null> {
  const binding = await db.webFetchPollBinding.findFirst({
    where: { jobId, organizationId },
    select: { cancelledAt: true },
  });
  if (!binding) return null;
  if (binding.cancelledAt) return { jobId, cancelled: true, alreadyCancelled: true };
  await cancelPoll(jobId);
  await db.webFetchPollBinding.update({ where: { jobId }, data: { cancelledAt: new Date() } });
  return { jobId, cancelled: true, alreadyCancelled: false };
}

/**
 * Whether the org → user → app policy chain allows `tool.web_poll` for an
 * interactive caller (the layers a run snapshots at mint, read live here
 * because no run exists). An absent layer adds no restriction; a present one
 * is default-deny over its allow-list (cor:acl:040).
 */
export async function webPollPolicyAllows(
  db: PrismaClient,
  scope: { organizationId: string; userId?: string | null; appId?: string | null },
): Promise<boolean> {
  const [org, user, app] = await Promise.all([
    db.organization.findUnique({ where: { id: scope.organizationId }, select: { policy: true } }),
    scope.userId ? db.user.findUnique({ where: { id: scope.userId }, select: { policy: true } }) : null,
    scope.appId ? db.app.findUnique({ where: { id: scope.appId }, select: { policy: true } }) : null,
  ]);
  return evaluatePolicyChain(WEB_POLL_POLICY_ACTION, [
    parsePolicyLink(org?.policy),
    parsePolicyLink(user?.policy),
    parsePolicyLink(app?.policy),
  ]);
}
