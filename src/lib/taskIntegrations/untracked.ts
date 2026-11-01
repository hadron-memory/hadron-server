/**
 * #3125 S3 — which outside items of an App's task integration are untracked (cor:agt:120:03).
 *
 * Reads every OPEN issue of each connected repository through the organization's GitHub App installation, with a
 * token minted per repository per call and narrowed to that repository and `issues:read` + `pull_requests:read` +
 * `metadata:read` (`mintRepositoryReadToken`, the #2485 posture: never cached, logged or returned). Pull-request read
 * is what V31's merged flag needs; an installation that cannot grant it refuses the whole call
 * (GITHUB_PERMISSION_MISSING, V45 / V-3) rather than returning items with a guessed flag.
 *
 * The read is bounded per repository; a rate limit, a GitHub error or the bound yields `complete: false` with the
 * reason, never a partial list presented as whole. An issue whose labels or closing pull requests run past one page
 * is left out and the list is marked incomplete (`item_truncated`): its labels decide the exclude, team and ready
 * filters, and a guess could list an excluded item or hide a merged flag.
 *
 * Titles and labels are the tracker's text: returned as data, never interpreted, never logged (V48).
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { isObj, mintRepositoryReadToken, postGraphql } from '../githubIssueSnapshot.js';
import type { StoredTaskIntegration } from '../appProperties.js';

/** The permissions a task-integration read is minted with (V31 needs the pull-request read). */
export const TASK_INTEGRATION_GITHUB_PERMISSIONS = { issues: 'read', pull_requests: 'read', metadata: 'read' } as const;
/** R9 / V44: the tracker read per repository per call is bounded. */
export const UNTRACKED_MAX_PAGES_PER_REPOSITORY = 20;
const ISSUES_PER_PAGE = 100;
const LABELS_PER_ISSUE = 100;
const CLOSING_PRS_PER_ISSUE = 25;

export type UntrackedIncompleteReason = 'rate_limited' | 'github_error' | 'page_limit' | 'item_truncated';

export interface UntrackedItem {
  /** The issue's canonical URL as GitHub gives it: the claim's external id. */
  externalId: string;
  /** The connected repository, lower-cased as stored in the integration. */
  repository: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  /** V31: a pull request that closes this issue has merged; the item is listed for a close check. */
  linkedPullRequestMerged: boolean;
}

export type ReadyFilter = 'ONLY' | 'EXCLUDE' | 'ANY';

export interface UntrackedFilters {
  /** One connected repository (lower-cased), or every one when null. */
  repository: string | null;
  /** The team's label (from the team map), or null for no team filter. */
  teamLabel: string | null;
  ready: ReadyFilter;
}

export interface UntrackedList {
  /** Every untracked item, filtered and ordered (D7); the caller pages it. */
  items: UntrackedItem[];
  complete: boolean;
  incompleteReason: UntrackedIncompleteReason | null;
}

const QUERY = `query($owner:String!,$name:String!,$after:String){
  repository(owner:$owner,name:$name){
    issues(states:OPEN,first:${ISSUES_PER_PAGE},after:$after,orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title url createdAt updatedAt
        labels(first:${LABELS_PER_ISSUE}){nodes{name} pageInfo{hasNextPage}}
        closedByPullRequestsReferences(first:${CLOSING_PRS_PER_ISSUE},includeClosedPrs:true){nodes{merged} pageInfo{hasNextPage}}
      }
    }
  }
}`;

type RawIssue = {
  number: number; title: string; url: string; createdAt: string; updatedAt: string;
  labels: { nodes: Array<{ name: string }>; pageInfo: { hasNextPage: boolean } };
  closedByPullRequestsReferences: { nodes: Array<{ merged: boolean }>; pageInfo: { hasNextPage: boolean } };
};

const isStr = (v: unknown): v is string => typeof v === 'string';
function isConn(v: unknown, node: (n: unknown) => boolean): boolean {
  return isObj(v) && Array.isArray(v.nodes) && v.nodes.every(node) && isObj(v.pageInfo) && typeof v.pageInfo.hasNextPage === 'boolean';
}
function isRawIssue(v: unknown): v is RawIssue {
  return isObj(v) && Number.isSafeInteger(v.number) && isStr(v.title) && isStr(v.url) && isStr(v.createdAt) && isStr(v.updatedAt)
    && isConn(v.labels, (n) => isObj(n) && isStr(n.name))
    && isConn(v.closedByPullRequestsReferences, (n) => isObj(n) && typeof n.merged === 'boolean');
}

type RepoRead = { issues: RawIssue[]; incompleteReason: UntrackedIncompleteReason | null };

/** All open issues of one repository, within the page bound. Throws only a typed `GithubReadError` (from the mint). */
async function readRepository(db: Pick<PrismaClient, 'organization'>, organizationId: string, repository: string): Promise<RepoRead> {
  const [owner, name] = repository.split('/') as [string, string];
  const token = await mintRepositoryReadToken(db, organizationId, { owner, name }, TASK_INTEGRATION_GITHUB_PERMISSIONS);
  const issues: RawIssue[] = [];
  let after: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages === UNTRACKED_MAX_PAGES_PER_REPOSITORY) return { issues, incompleteReason: 'page_limit' };
    const r = await postGraphql(token, QUERY, { owner, name, after });
    if (!r.ok) return { issues, incompleteReason: r.reason };
    const repo = r.data.repository;
    const conn = isObj(repo) ? repo.issues : null;
    // A page that does not say whether another follows is an unexpected response, never read as the last page.
    if (!isConn(conn, isRawIssue)) return { issues, incompleteReason: 'github_error' };
    const page = conn as { nodes: RawIssue[]; pageInfo: Record<string, unknown> };
    issues.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    const cursor = page.pageInfo.endCursor;
    if (!isStr(cursor)) return { issues, incompleteReason: 'github_error' };
    after = cursor;
  }
  return { issues, incompleteReason: null };
}

/** D7: oldest first, then repository, then number. */
export function compareUntracked(a: UntrackedItem, b: UntrackedItem): number {
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.createdAt < b.createdAt ? -1 : 1);
  if (a.repository !== b.repository) return a.repository < b.repository ? -1 : 1;
  return a.number - b.number;
}

/** The label filters (exclude, team, ready), compared without regard to case (cor:agt:120:01). */
export function passesLabelFilters(labels: readonly string[], integration: StoredTaskIntegration, filters: UntrackedFilters): boolean {
  const has = new Set(labels.map((l) => l.toLowerCase()));
  if ((integration.excludeLabels ?? []).some((l) => has.has(l.toLowerCase()))) return false;
  if (filters.teamLabel !== null && !has.has(filters.teamLabel.toLowerCase())) return false;
  const ready = integration.readyLabel ? has.has(integration.readyLabel.toLowerCase()) : false;
  // V-1 (V45): ONLY against an integration with no ready label lists nothing; EXCLUDE and ANY leave the list as it is.
  if (filters.ready === 'ONLY' && !ready) return false;
  if (filters.ready === 'EXCLUDE' && ready) return false;
  return true;
}

/**
 * Every untracked item of `integration` in App `appId`, filtered and ordered. A repository the installation cannot
 * grant refuses the whole call (typed `GithubReadError`, cor:agt:120:03 Edge Cases), never an empty answer.
 * `claimedIn` answers which of a batch of URLs some task of THIS App holds as external id, in any status. It is called
 * at least once after every GitHub read, even when nothing was read or everything was filtered out, because the
 * caller's re-run of the read gate lives there.
 */
export async function listUntrackedItems(
  db: Pick<PrismaClient, 'organization'>,
  input: {
    organizationId: string;
    integration: StoredTaskIntegration;
    filters: UntrackedFilters;
    claimedIn: (urls: string[]) => Promise<Set<string>>;
  },
): Promise<UntrackedList> {
  const repositories = input.filters.repository ? [input.filters.repository] : input.integration.repositories;
  const read: UntrackedItem[] = [];
  let incompleteReason: UntrackedIncompleteReason | null = null;
  for (const repository of repositories) {
    const r = await readRepository(db, input.organizationId, repository);
    incompleteReason ??= r.incompleteReason;
    for (const raw of r.issues) {
      if (raw.labels.pageInfo.hasNextPage || raw.closedByPullRequestsReferences.pageInfo.hasNextPage) {
        incompleteReason ??= 'item_truncated';
        continue;
      }
      const labels = raw.labels.nodes.map((l) => l.name);
      if (!passesLabelFilters(labels, input.integration, input.filters)) continue;
      read.push({
        externalId: raw.url, repository, number: raw.number, title: raw.title, url: raw.url, labels,
        createdAt: raw.createdAt, updatedAt: raw.updatedAt,
        linkedPullRequestMerged: raw.closedByPullRequestsReferences.nodes.some((p) => p.merged),
      });
    }
  }
  const claimed = new Set<string>();
  const batches: string[][] = [];
  for (let i = 0; i < read.length; i += 500) batches.push(read.slice(i, i + 500).map((it) => it.url));
  for (const batch of batches.length ? batches : [[]]) {
    for (const url of await input.claimedIn(batch)) claimed.add(url);
  }
  const items = read.filter((it) => !claimed.has(it.url)).sort(compareUntracked);
  return { items, complete: incompleteReason === null, incompleteReason };
}
