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
 * response body. A rate limit, a GitHub failure or a malformed response
 * mid-listing yields `complete: false` with the cursor to resume from, never
 * a partial result presented as whole.
 *
 * An issue's labels, sub-issues and close/reopen events are followed past
 * their first page by `node(id:)` follow-ups, within a per-call budget. A
 * page is returned whole or not at all: when a follow-up fails, or the
 * budget runs out on a page a fresh call could finish, the page is dropped
 * and the cursor stays at its start. Only a list longer than a whole call's
 * budget is cut, and that is `nested_truncated`, which retrying cannot fix.
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
/** Follow-up requests one call spends on issues' nested lists. */
export const GITHUB_SNAPSHOT_MAX_NESTED_PAGES = 10;
const ISSUES_PER_PAGE = 50;
const LABELS_PER_ISSUE = 30;
const SUB_ISSUES_PER_ISSUE = 50;
const TIMELINE_PER_ISSUE = 50;
const NESTED_PER_PAGE = 100;

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
const ALLOWED_ARGS = new Set(['repository', 'since', 'until', 'cursor']);
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
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
  const m = typeof v === 'string' ? ISO_UTC.exec(v) : null;
  if (!m) {
    throw new GithubReadError('GITHUB_INVALID_ARGUMENT', `"${field}" must be an ISO-8601 UTC time ending in Z.`);
  }
  const d = new Date(v as string);
  // Date rolls a nonexistent day over (February 30 becomes March 2, 24:00
  // the next day), so the date must read back as written. A larger hour,
  // minute or second is already NaN.
  const [, year, month, day] = m;
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== Number(year) ||
    d.getUTCMonth() + 1 !== Number(month) ||
    d.getUTCDate() !== Number(day)
  ) {
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
  /** A nested list was longer than one call can follow; retrying will not complete it. */
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
        id number title state stateReason createdAt updatedAt closedAt url
        labels(first:${LABELS_PER_ISSUE}){nodes{name} pageInfo{hasNextPage endCursor}}
        parent{number repository{nameWithOwner}}
        subIssues(first:${SUB_ISSUES_PER_ISSUE}){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}
        timelineItems(first:${TIMELINE_PER_ISSUE},since:$since,itemTypes:[CLOSED_EVENT,REOPENED_EVENT]){
          nodes{__typename ... on ClosedEvent{createdAt} ... on ReopenedEvent{createdAt}}
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }
}`;

/** The rest of one issue's nested lists; a list already read whole is skipped by its flag. */
const NESTED_QUERY = `query($id:ID!,$since:DateTime!,$labels:Boolean!,$labelsAfter:String,$subs:Boolean!,$subsAfter:String,$timeline:Boolean!,$timelineAfter:String){
  node(id:$id){
    ... on Issue{
      labels(first:${NESTED_PER_PAGE},after:$labelsAfter) @include(if:$labels){nodes{name} pageInfo{hasNextPage endCursor}}
      subIssues(first:${NESTED_PER_PAGE},after:$subsAfter) @include(if:$subs){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}
      timelineItems(first:${NESTED_PER_PAGE},after:$timelineAfter,since:$since,itemTypes:[CLOSED_EVENT,REOPENED_EVENT]) @include(if:$timeline){
        nodes{__typename ... on ClosedEvent{createdAt} ... on ReopenedEvent{createdAt}}
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

type Conn<T> = { nodes?: T[] | null; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null } | null | undefined;
type RepoRef = { number: number; repository: { nameWithOwner: string } };
type TimelineItem = { __typename: string; createdAt?: string | null };
interface RawIssue {
  id: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  url: string;
  labels: Conn<{ name: string }>;
  parent: RepoRef | null;
  subIssues: Conn<RepoRef>;
  timelineItems: Conn<TimelineItem>;
}

// GitHub's JSON is checked before it is used, so an unexpected shape is a
// github_error that keeps the pages already read, never a thrown TypeError.
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isOptStr = (v: unknown): boolean => v === null || v === undefined || typeof v === 'string';
const isLabel = (v: unknown): boolean => isObj(v) && typeof v.name === 'string';
const isRepoRef = (v: unknown): boolean =>
  isObj(v) && typeof v.number === 'number' && isObj(v.repository) && typeof v.repository.nameWithOwner === 'string';
const isTimelineItem = (v: unknown): boolean =>
  isObj(v) && typeof v.__typename === 'string' && isOptStr(v.createdAt);

/** A connection is absent, or has a node list and a pageInfo that can be followed. */
function isConn(v: unknown, node: (n: unknown) => boolean): boolean {
  if (v === null || v === undefined) return true;
  if (!isObj(v)) return false;
  if (v.nodes !== null && v.nodes !== undefined && !(Array.isArray(v.nodes) && v.nodes.every(node))) return false;
  if (v.pageInfo === null || v.pageInfo === undefined) return true;
  if (!isObj(v.pageInfo)) return false;
  return v.pageInfo.hasNextPage !== true || typeof v.pageInfo.endCursor === 'string';
}

function isRawIssue(v: unknown): v is RawIssue {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    typeof v.number === 'number' &&
    typeof v.title === 'string' &&
    typeof v.state === 'string' &&
    isOptStr(v.stateReason) &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string' &&
    isOptStr(v.closedAt) &&
    typeof v.url === 'string' &&
    (v.parent === null || v.parent === undefined || isRepoRef(v.parent)) &&
    isConn(v.labels, isLabel) &&
    isConn(v.subIssues, isRepoRef) &&
    isConn(v.timelineItems, isTimelineItem)
  );
}

type Failure = { ok: false; reason: 'rate_limited' | 'github_error' };

async function postGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | Failure> {
  let res: Response;
  try {
    res = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    return { ok: false, reason: 'github_error' };
  }
  if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    return { ok: false, reason: 'rate_limited' };
  }
  if (!res.ok) return { ok: false, reason: 'github_error' };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'github_error' };
  }
  if (!isObj(body)) return { ok: false, reason: 'github_error' };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const limited = body.errors.some((e) => isObj(e) && e.type === 'RATE_LIMITED');
    return { ok: false, reason: limited ? 'rate_limited' : 'github_error' };
  }
  if (!isObj(body.data)) return { ok: false, reason: 'github_error' };
  return { ok: true, data: body.data };
}

type PageResult =
  | { ok: true; repository: { id: string; nameWithOwner: string; url: string }; issues: RawIssue[]; hasNextPage: boolean; endCursor: string | null }
  | Failure;

async function fetchPage(token: string, args: GithubSnapshotArgs, after: string | null): Promise<PageResult> {
  const r = await postGraphql(token, QUERY, { owner: args.owner, name: args.name, since: args.since, after });
  if (!r.ok) return r;
  const repo = r.data.repository;
  if (
    !isObj(repo) ||
    typeof repo.id !== 'string' ||
    typeof repo.nameWithOwner !== 'string' ||
    typeof repo.url !== 'string' ||
    !isObj(repo.issues) ||
    !Array.isArray(repo.issues.nodes) ||
    !repo.issues.nodes.every(isRawIssue)
  ) {
    return { ok: false, reason: 'github_error' };
  }
  const pageInfo = isObj(repo.issues.pageInfo) ? repo.issues.pageInfo : {};
  const hasNextPage = pageInfo.hasNextPage === true;
  // A next page with no cursor to reach it would restart the listing.
  if (hasNextPage && typeof pageInfo.endCursor !== 'string') return { ok: false, reason: 'github_error' };
  return {
    ok: true,
    repository: { id: repo.id, nameWithOwner: repo.nameWithOwner, url: repo.url },
    issues: repo.issues.nodes,
    hasNextPage,
    endCursor: hasNextPage ? (pageInfo.endCursor as string) : null,
  };
}

const NESTED = [
  { key: 'labels', flag: 'labels', after: 'labelsAfter', node: isLabel },
  { key: 'subIssues', flag: 'subs', after: 'subsAfter', node: isRepoRef },
  { key: 'timelineItems', flag: 'timeline', after: 'timelineAfter', node: isTimelineItem },
] as const;

/** Where a nested list continues, or null when it was read whole. */
function openCursor(conn: Conn<unknown>): string | null {
  return conn?.pageInfo?.hasNextPage === true ? (conn.pageInfo.endCursor ?? null) : null;
}

/**
 * Read the rest of `raw`'s nested lists into it. `take` spends one request
 * from the call's budget; 'budget' means it ran out with a list still open.
 */
async function completeNested(
  token: string,
  args: GithubSnapshotArgs,
  raw: RawIssue,
  take: () => boolean,
): Promise<'done' | 'budget' | Failure['reason']> {
  for (;;) {
    const open = NESTED.filter((n) => openCursor(raw[n.key]) !== null);
    if (open.length === 0) return 'done';
    if (!take()) return 'budget';
    const variables: Record<string, unknown> = { id: raw.id, since: args.since };
    for (const n of NESTED) {
      const isOpen = open.includes(n);
      variables[n.flag] = isOpen;
      if (isOpen) variables[n.after] = openCursor(raw[n.key]);
    }
    const r = await postGraphql(token, NESTED_QUERY, variables);
    if (!r.ok) return r.reason;
    const node = r.data.node;
    if (!isObj(node)) return 'github_error';
    for (const n of open) {
      const more = node[n.key];
      // A list asked for must come back, or the loop would ask again forever.
      if (!isObj(more) || !isConn(more, n.node)) return 'github_error';
      const conn = raw[n.key] as Conn<unknown>;
      const merged = {
        nodes: [...(conn?.nodes ?? []), ...((more.nodes as unknown[] | null | undefined) ?? [])],
        pageInfo: (more.pageInfo ?? null) as NonNullable<Conn<unknown>>['pageInfo'],
      };
      (raw as unknown as Record<string, unknown>)[n.key] = merged;
    }
  }
}

function inWindow(at: string | null | undefined, args: GithubSnapshotArgs): at is string {
  if (!at) return false;
  const t = Date.parse(at);
  return t >= Date.parse(args.since) && t <= Date.parse(args.until);
}

function shapeIssue(raw: RawIssue): { issue: SnapshotIssue; events: SnapshotEvent[] } {
  const truncated = NESTED.some((n) => openCursor(raw[n.key]) !== null);
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
      repository: { owner: args.owner, name: args.name },
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
          'GitHub granted a token other than issues:read + metadata:read on this one repository; it was discarded unused.',
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
  let cut = false;
  let followUps = 0;
  const take = () => {
    if (followUps === GITHUB_SNAPSHOT_MAX_NESTED_PAGES) return false;
    followUps++;
    return true;
  };

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
    const pageIssues: SnapshotIssue[] = [];
    const pageEvents: SnapshotEvent[] = [];
    let pageCut = false;
    let dropped: IncompleteReason | undefined;
    for (const raw of page.issues) {
      const nested = await completeNested(token, args, raw, take);
      if (nested === 'rate_limited' || nested === 'github_error') {
        dropped = nested;
        break;
      }
      // A later page that ran out of budget is finished whole by the next
      // call. On a call's first page a retry has no more budget, so the
      // issue is cut instead.
      if (nested === 'budget' && pages > 0) {
        dropped = 'page_limit';
        break;
      }
      const shaped = shapeIssue(raw);
      if (shaped.issue.truncated) pageCut = true;
      pageIssues.push(shaped.issue);
      pageEvents.push(...shaped.events.filter((e) => inWindow(e.at, args)));
    }
    if (dropped) {
      // `cursor` still names this page's start.
      incompleteReason = dropped;
      break;
    }
    issues.push(...pageIssues);
    events.push(...pageEvents);
    cut ||= pageCut;
    if (!page.hasNextPage) {
      cursor = null;
      break;
    }
    cursor = page.endCursor;
  }
  // A resumable reason wins: the cursor is still worth following, and the
  // cut issues carry their own `truncated` flag.
  if (cut) incompleteReason ??= 'nested_truncated';

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
