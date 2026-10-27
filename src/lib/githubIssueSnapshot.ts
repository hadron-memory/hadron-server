/**
 * GitHub issue snapshot for headless runs (#2485, epic #2435 slice C).
 *
 * Register row 2 (`hadron-dev-team-shared:coordination:authorizations`) lets
 * the report run read GitHub issues "through the existing GitHub integration
 * the platform uses to sync memory with GitHub, read-only". The sync's own
 * credential (`getInstallationToken`) is org-wide and carries contents-write,
 * so it never reaches a run. Instead every call mints a token from the SAME
 * App and installation, narrowed to one repository and `issues:read` +
 * `metadata:read` (`mintScopedInstallationToken`). Holger ruled that this
 * narrowing is the existing integration, not a new credential (#2485,
 * comment 6432580535).
 *
 * Reach is an intersection, judged before any token is minted:
 *   (a) the repositories the connector already reaches: the `source` of the
 *       run org's live memories (`parseSourceSlug`, the #561 allowlist shape);
 *   (b) the flow node's `data.github.repositories` allowlist.
 *
 * The token lives for this call only: it is not cached, logged, returned, or
 * put in a URL. Refusals carry a code and a fixed message, never GitHub's
 * response body. A rate limit or a GitHub failure mid-listing yields
 * `complete: false` with the cursor to resume from, never a partial result
 * presented as whole.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { decryptToken } from './tokenCrypto.js';
import { parseSourceSlug } from './gitSource.js';
import {
  mintScopedInstallationToken,
  ScopedMintError,
  type GithubAppCredentials,
} from '../integrations/github/githubApp.js';

export type GithubReadErrorCode =
  | 'GITHUB_INVALID_ARGUMENT'
  | 'GITHUB_REPOSITORY_NOT_ALLOWED'
  | 'GITHUB_NOT_INSTALLED'
  | 'GITHUB_PERMISSION_MISSING'
  | 'GITHUB_TOKEN_SCOPE_MISMATCH'
  | 'GITHUB_UNAVAILABLE';

/** A typed refusal. The message is fixed text plus caller-supplied names, never GitHub output. */
export class GithubReadError extends Error {
  constructor(
    readonly code: GithubReadErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'GithubReadError';
  }
}

/** The only permissions a run's GitHub token is ever minted with. */
export const RUN_GITHUB_PERMISSIONS = { issues: 'read', metadata: 'read' } as const;

/** Widest window one snapshot may cover. */
export const GITHUB_SNAPSHOT_MAX_WINDOW_DAYS = 93;
/** Issue pages one call reads before handing back a cursor. */
export const GITHUB_SNAPSHOT_MAX_PAGES = 5;
const ISSUES_PER_PAGE = 50;
const LABELS_PER_ISSUE = 30;
const SUB_ISSUES_PER_ISSUE = 50;
const TIMELINE_PER_ISSUE = 50;

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
const ALLOWED_ARGS = new Set(['repository', 'since', 'until', 'cursor']);
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,200}$/;

export interface GithubSnapshotArgs {
  owner: string;
  name: string;
  /** Lower-cased `owner/name`, the form reach is compared in. */
  slug: string;
  since: string;
  until: string;
  cursor: string | null;
}

/**
 * Validate the tool arguments. Rejects any argument outside the declared
 * four, so nothing a model sends can carry a token, a URL or a command.
 */
export function parseSnapshotArgs(args: Record<string, unknown>, now: Date): GithubSnapshotArgs {
  const extra = Object.keys(args).filter((k) => !ALLOWED_ARGS.has(k));
  if (extra.length > 0) {
    throw new GithubReadError('GITHUB_INVALID_ARGUMENT', `unsupported argument(s): ${extra.join(', ')}.`);
  }
  const repository = typeof args.repository === 'string' ? args.repository.trim() : '';
  const parts = repository.split('/');
  if (
    parts.length !== 2 ||
    !parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')
  ) {
    throw new GithubReadError('GITHUB_INVALID_ARGUMENT', '"repository" must be "owner/name".');
  }
  const [owner, name] = parts as [string, string];

  const since = parseInstant(args.since, 'since');
  const until = args.until === undefined ? now : parseInstant(args.until, 'until');
  if (since.getTime() >= until.getTime()) {
    throw new GithubReadError('GITHUB_INVALID_ARGUMENT', '"since" must be before "until".');
  }
  if (until.getTime() - since.getTime() > GITHUB_SNAPSHOT_MAX_WINDOW_DAYS * 86_400_000) {
    throw new GithubReadError(
      'GITHUB_INVALID_ARGUMENT',
      `the window may span at most ${GITHUB_SNAPSHOT_MAX_WINDOW_DAYS} days.`,
    );
  }
  let cursor: string | null = null;
  if (args.cursor !== undefined && args.cursor !== null) {
    if (typeof args.cursor !== 'string' || !CURSOR.test(args.cursor)) {
      throw new GithubReadError('GITHUB_INVALID_ARGUMENT', '"cursor" must be a cursor this tool returned.');
    }
    cursor = args.cursor;
  }
  return {
    owner,
    name,
    slug: `${owner.toLowerCase()}/${name.toLowerCase()}`,
    since: toIso(args.since as string, since),
    until: args.until === undefined ? now.toISOString() : toIso(args.until as string, until),
    cursor,
  };
}

function parseInstant(v: unknown, field: string): Date {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) {
    throw new GithubReadError('GITHUB_INVALID_ARGUMENT', `"${field}" must be an ISO-8601 UTC time ending in Z.`);
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new GithubReadError('GITHUB_INVALID_ARGUMENT', `"${field}" is not a valid time.`);
  }
  return d;
}

/** Echo the caller's spelling when it is already canonical, so the window reads back as given. */
function toIso(raw: string, d: Date): string {
  return raw.endsWith('Z') && new Date(raw).getTime() === d.getTime() ? raw : d.toISOString();
}

/**
 * The repositories this run may read: the org's memory sources intersected
 * with the flow node's allowlist, both as lower-cased `owner/name`.
 */
export async function runGithubReach(
  db: PrismaClient,
  organizationId: string,
  nodeData: unknown,
): Promise<Set<string>> {
  const allow = nodeAllowlist(nodeData);
  if (allow.size === 0) return allow;
  const memories = await db.memory.findMany({
    where: { organizationId, deletedAt: null, source: { not: null } },
    select: { source: true },
  });
  const connector = new Set(
    memories.map((m) => parseSourceSlug(m.source)).filter((s): s is string => s !== null),
  );
  return new Set([...allow].filter((s) => connector.has(s)));
}

function nodeAllowlist(nodeData: unknown): Set<string> {
  const out = new Set<string>();
  if (!nodeData || typeof nodeData !== 'object' || Array.isArray(nodeData)) return out;
  const github = (nodeData as Record<string, unknown>).github;
  if (!github || typeof github !== 'object' || Array.isArray(github)) return out;
  const repos = (github as Record<string, unknown>).repositories;
  if (!Array.isArray(repos)) return out;
  for (const r of repos) {
    if (typeof r !== 'string') continue;
    const parts = r.trim().split('/');
    if (parts.length === 2 && parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')) {
      out.add(r.trim().toLowerCase());
    }
  }
  return out;
}

/** The App credentials the sync uses for this org (per-org key, else env). */
function orgAppCredentials(org: {
  githubAppId: string | null;
  githubAppPrivateKeyEncrypted: string | null;
}): GithubAppCredentials | undefined {
  return org.githubAppId && org.githubAppPrivateKeyEncrypted
    ? { appId: org.githubAppId, privateKeyPem: decryptToken(org.githubAppPrivateKeyEncrypted) }
    : undefined;
}

export interface SnapshotIssue {
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  parent: { repository: string; number: number } | null;
  subIssues: Array<{ repository: string; number: number }>;
  truncated?: true;
}

export interface SnapshotEvent {
  issue: number;
  type: 'opened' | 'closed' | 'reopened';
  at: string;
}

export type IncompleteReason = 'rate_limited' | 'github_error' | 'page_limit' | 'nested_truncated';

export interface GithubIssueSnapshot {
  /** Issue titles and labels are UNTRUSTED external text. */
  source: 'external';
  repository: { nameWithOwner: string; id: string; url: string } | null;
  window: { since: string; until: string };
  acquiredAt: string;
  issues: SnapshotIssue[];
  events: SnapshotEvent[];
  /** Pass back as `cursor` to continue; null when the listing finished. */
  cursor: string | null;
  complete: boolean;
  incompleteReason?: IncompleteReason;
}

const QUERY = `query($owner:String!,$name:String!,$since:DateTime!,$after:String){
  repository(owner:$owner,name:$name){
    id nameWithOwner url
    issues(first:${ISSUES_PER_PAGE},after:$after,filterBy:{since:$since},orderBy:{field:UPDATED_AT,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title state stateReason createdAt updatedAt closedAt url
        labels(first:${LABELS_PER_ISSUE}){nodes{name} pageInfo{hasNextPage}}
        parent{number repository{nameWithOwner}}
        subIssues(first:${SUB_ISSUES_PER_ISSUE}){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}
        timelineItems(first:${TIMELINE_PER_ISSUE},since:$since,itemTypes:[CLOSED_EVENT,REOPENED_EVENT]){
          nodes{__typename ... on ClosedEvent{createdAt} ... on ReopenedEvent{createdAt}}
          pageInfo{hasNextPage}
        }
      }
    }
  }
}`;

type Conn<T> = { nodes?: T[] | null; pageInfo?: { hasNextPage?: boolean } | null } | null | undefined;
interface RawIssue {
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  labels: Conn<{ name: string }>;
  parent: { number: number; repository: { nameWithOwner: string } } | null;
  subIssues: Conn<{ number: number; repository: { nameWithOwner: string } }>;
  timelineItems: Conn<{ __typename: string; createdAt?: string }>;
}

type PageResult =
  | { ok: true; repository: { id: string; nameWithOwner: string; url: string }; issues: RawIssue[]; hasNextPage: boolean; endCursor: string | null }
  | { ok: false; reason: 'rate_limited' | 'github_error' };

async function fetchPage(token: string, args: GithubSnapshotArgs, after: string | null): Promise<PageResult> {
  let res: Response;
  try {
    res = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { owner: args.owner, name: args.name, since: args.since, after },
      }),
    });
  } catch {
    return { ok: false, reason: 'github_error' };
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    return { ok: false, reason: 'rate_limited' };
  }
  if (!res.ok) return { ok: false, reason: 'github_error' };
  let body: { data?: { repository?: unknown }; errors?: Array<{ type?: string }> };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: 'github_error' };
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    return { ok: false, reason: body.errors.some((e) => e?.type === 'RATE_LIMITED') ? 'rate_limited' : 'github_error' };
  }
  const repo = body.data?.repository as
    | { id: string; nameWithOwner: string; url: string; issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: RawIssue[] } }
    | null
    | undefined;
  if (!repo || !repo.issues || !Array.isArray(repo.issues.nodes)) return { ok: false, reason: 'github_error' };
  return {
    ok: true,
    repository: { id: repo.id, nameWithOwner: repo.nameWithOwner, url: repo.url },
    issues: repo.issues.nodes,
    hasNextPage: repo.issues.pageInfo?.hasNextPage === true,
    endCursor: repo.issues.pageInfo?.endCursor ?? null,
  };
}

function inWindow(at: string | null | undefined, args: GithubSnapshotArgs): at is string {
  if (!at) return false;
  const t = Date.parse(at);
  return t >= Date.parse(args.since) && t <= Date.parse(args.until);
}

function shapeIssue(raw: RawIssue): { issue: SnapshotIssue; events: SnapshotEvent[] } {
  const truncated =
    raw.labels?.pageInfo?.hasNextPage === true ||
    raw.subIssues?.pageInfo?.hasNextPage === true ||
    raw.timelineItems?.pageInfo?.hasNextPage === true;
  const issue: SnapshotIssue = {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    stateReason: raw.stateReason ?? null,
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    closedAt: raw.closedAt ?? null,
    url: raw.url,
    parent: raw.parent ? { repository: raw.parent.repository.nameWithOwner, number: raw.parent.number } : null,
    subIssues: (raw.subIssues?.nodes ?? []).map((s) => ({ repository: s.repository.nameWithOwner, number: s.number })),
    ...(truncated ? { truncated: true as const } : {}),
  };
  const events: SnapshotEvent[] = [];
  if (raw.createdAt) events.push({ issue: raw.number, type: 'opened', at: raw.createdAt });
  for (const t of raw.timelineItems?.nodes ?? []) {
    if (t.__typename === 'ClosedEvent' && t.createdAt) events.push({ issue: raw.number, type: 'closed', at: t.createdAt });
    if (t.__typename === 'ReopenedEvent' && t.createdAt) events.push({ issue: raw.number, type: 'reopened', at: t.createdAt });
  }
  return { issue, events };
}

/**
 * Take one snapshot. `nodeData` is the executing flow node's `data`, read by
 * the caller under the run principal. Refusals throw `GithubReadError`;
 * GitHub trouble after the mint returns `complete: false`.
 */
export async function takeGithubIssueSnapshot(
  db: PrismaClient,
  input: { organizationId: string; nodeData: unknown; args: Record<string, unknown>; now?: Date },
): Promise<GithubIssueSnapshot> {
  const now = input.now ?? new Date();
  const args = parseSnapshotArgs(input.args, now);

  const reach = await runGithubReach(db, input.organizationId, input.nodeData);
  if (!reach.has(args.slug)) {
    throw new GithubReadError(
      'GITHUB_REPOSITORY_NOT_ALLOWED',
      `"${args.owner}/${args.name}" is not readable by this run: it must be the source of one of ` +
        `the organization's memories AND be listed in the flow node's data.github.repositories.`,
    );
  }

  const org = await db.organization.findUnique({
    where: { id: input.organizationId },
    select: { githubInstallationId: true, githubAppId: true, githubAppPrivateKeyEncrypted: true },
  });
  if (!org?.githubInstallationId) {
    throw new GithubReadError('GITHUB_NOT_INSTALLED', 'the organization has no GitHub App installation.');
  }

  let credentials: GithubAppCredentials | undefined;
  try {
    credentials = orgAppCredentials(org);
  } catch {
    // The per-org key did not decrypt; its error says nothing a run needs.
    throw new GithubReadError('GITHUB_NOT_INSTALLED', 'the GitHub App credentials could not be read.');
  }

  let token: string;
  try {
    token = await mintScopedInstallationToken(org.githubInstallationId, credentials, {
      repositories: [args.name],
      permissions: { ...RUN_GITHUB_PERMISSIONS },
    });
  } catch (err) {
    if (!(err instanceof ScopedMintError)) throw err;
    switch (err.reason) {
      case 'NOT_CONFIGURED':
        throw new GithubReadError('GITHUB_NOT_INSTALLED', 'the GitHub App credentials are not configured.');
      case 'REFUSED':
        throw new GithubReadError(
          'GITHUB_PERMISSION_MISSING',
          `the GitHub installation cannot grant issues:read on "${args.owner}/${args.name}" ` +
            `(HTTP ${err.status}); an organization owner may need to accept the App's Issues permission.`,
        );
      case 'SCOPE_MISMATCH':
        throw new GithubReadError(
          'GITHUB_TOKEN_SCOPE_MISMATCH',
          'GitHub granted a token wider than issues:read + metadata:read; it was discarded unused.',
        );
      default:
        throw new GithubReadError('GITHUB_UNAVAILABLE', 'GitHub did not issue a token.');
    }
  }

  const acquiredAt = now.toISOString();
  const issues: SnapshotIssue[] = [];
  const events: SnapshotEvent[] = [];
  let repository: GithubIssueSnapshot['repository'] = null;
  let cursor = args.cursor;
  let incompleteReason: IncompleteReason | undefined;

  for (let pages = 0; ; pages++) {
    if (pages === GITHUB_SNAPSHOT_MAX_PAGES) {
      incompleteReason = 'page_limit';
      break;
    }
    const page = await fetchPage(token, args, cursor);
    if (!page.ok) {
      incompleteReason = page.reason;
      break;
    }
    repository = page.repository;
    for (const raw of page.issues) {
      const shaped = shapeIssue(raw);
      issues.push(shaped.issue);
      events.push(...shaped.events.filter((e) => inWindow(e.at, args)));
      if (shaped.issue.truncated) incompleteReason ??= 'nested_truncated';
    }
    if (!page.hasNextPage) {
      cursor = null;
      break;
    }
    cursor = page.endCursor;
  }

  return {
    source: 'external',
    repository,
    window: { since: args.since, until: args.until },
    acquiredAt,
    issues,
    events,
    // null once the listing finished; else where a follow-up call resumes.
    cursor,
    complete: incompleteReason === undefined,
    ...(incompleteReason ? { incompleteReason } : {}),
  };
}
