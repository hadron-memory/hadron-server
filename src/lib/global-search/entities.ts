/**
 * Per-entity search adapters. Each applies (a) its access scope and (b) the
 * field predicates the caller searched, fetches a capped candidate set, scores
 * each row in JS, and emits unified `GlobalSearchHit`s.
 *
 * Access scope per entity (non-admin):
 *   - Organization:    id ∈ orgIds
 *   - Memory / Node:   memoryId ∈ accessibleMemoryIds (admin: owner-only carve-out)
 *   - Agent / App:     organizationId ∈ orgIds  (App also: uninstalledAt = null)
 *   - AiServiceConfig: owner org ∈ orgIds  (org-, app-, or agent-owned)
 *   - User:            authenticated viewer only (parity with `searchUsers`)
 *
 * Encryption: only Node `content` is ciphertext on encrypted memories
 * (`name`/`loc`/`description` stay plaintext — see `nodeCrypto.ts`), so the
 * `content` predicate is guarded to non-encrypted memories and emits a degraded
 * note; every other field is searchable everywhere.
 *
 * Spec: cor:api:050:02
 */

import { searchContains, searchStartsWith } from '../../integrations/db/provider.js';
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import {
  bestMatch,
  urnMatchTier,
  urnSearchVariants,
  type FieldCandidate,
} from './match.js';
import { emitEntityUrnV2, emitNodeUrnV2 } from '../urnEmit.js';
import type { GlobalSearchHit, SearchEntityType, SearchField, SearchPrincipal } from './types.js';
import { userUrn } from '../userHandle.js';
import { canSeeUserPersonalFields, type UserVisibilityCtx } from '../auth/userVisibility.js';
import { foreignIdentityScopedMemoryFilter } from '../auth/memoryOwnership.js';
import { discoverableOrgWhere } from '../orgDiscoverability.js';

type AnyWhere = Record<string, unknown>;

export interface AdapterCtx {
  db: PrismaClient;
  principal: SearchPrincipal;
  /** Raw, trimmed query. */
  q: string;
  /** URN term with any `hrn:<type>:` prefix stripped. */
  urnTerm: string;
  /** The fields actually being searched (post-sniff or explicit). */
  fields: Set<SearchField>;
  /** Max candidate rows to fetch per entity before scoring. */
  cap: number;
  /** Sink for reduced-fidelity notes. */
  degraded: string[];
}

// ── Scope helpers ──────────────────────────────────────────────────────────

// org-scope narrowing (issue #463): when `orgScopeId` is set, AND it onto the
// access scope so it can only ever *narrow*, never widen (the Memory + Node
// slices; the org-rooted slices are confined via `orgIds` instead). When unset,
// the base `where` is returned untouched — no empty-`AND` wrapper.

/** Memory scope as a Memory `where` (used by the Memory slice + encrypted count). */
function memoryScopeWhere(p: SearchPrincipal): AnyWhere {
  const base: AnyWhere =
    p.accessibleMemoryIds !== null
      ? { id: { in: p.accessibleMemoryIds } }
      // Admin: everything except OTHER users' personal/private (034 carve-out)
      // AND other users' user-owned memories (spec 047 strict ownership).
      : {
          NOT: foreignIdentityScopedMemoryFilter(p.viewerUserId),
        };
  return p.orgScopeId ? { AND: [base, { organizationId: p.orgScopeId }] } : base;
}

/** Memory scope projected onto a Node `where`. */
function nodeScopeWhere(p: SearchPrincipal): AnyWhere {
  const base: AnyWhere =
    p.accessibleMemoryIds !== null
      ? { memoryId: { in: p.accessibleMemoryIds } }
      : {
          memory: {
            NOT: foreignIdentityScopedMemoryFilter(p.viewerUserId),
          },
        };
  return p.orgScopeId ? { AND: [base, { memory: { organizationId: p.orgScopeId } }] } : base;
}

// ── Predicate builders ──────────────────────────────────────────────────────

function pkPred(q: string): AnyWhere {
  return { id: q };
}

function urnPreds(column: string, urnTerm: string): AnyWhere[] {
  return urnSearchVariants(urnTerm).map((v) => searchContains(column, v) as AnyWhere);
}

function textPred(column: string, q: string): AnyWhere {
  return searchContains(column, q) as AnyWhere;
}

function startsPred(column: string, q: string): AnyWhere {
  return searchStartsWith(column, q) as AnyWhere;
}

/**
 * The loc portion of a node-URN query — everything after the leading org +
 * memory hierarchy atoms. A full node URN is `root:memory:loc` (v1: `org::memory::loc`), but the Node
 * row stores only `loc`, so matching the whole query against `loc` never hits;
 * we recover the loc here to build a PRECISE loc predicate.
 *
 * Earlier this returned just the LAST colon-atom (e.g. `cor:brd:010:01` → `01`),
 * which was so broad it flooded the candidate cap and crowded the real row out
 * before scoring — a bare-loc search returned nothing (#301). Stripping exactly
 * the org + memory atoms keeps the fallback precise.
 *
 * Separator-agnostic: collapse `::`/`:` runs to single-colon atoms (like
 * match.ts `singleColon`) before stripping, so v1 (`org::memory::loc`),
 * canonical v2 (`org:memory:loc`), and mixed (`org::memory:loc`) forms all yield the
 * loc. The Node row stores its loc single-colon, so rejoining with `:` matches.
 * Returns '' when there is no loc portion (≤ 2 atoms — an org/memory URN, not a
 * node URN).
 *
 * This is a heuristic: it can't know whether the first two atoms are really an
 * org + memory (full node URN) or just the start of a longer loc (a partial-loc
 * search like `brd:010:01`, where it wrongly yields `01`). The suffix is matched
 * with `startsWith`, NOT `contains` (see searchNodes), so a wrong guess like
 * `01` matches ~nothing and can't re-flood the cap — the precise whole-query
 * predicate carries partial-loc searches.
 */
function locSuffix(urnTerm: string): string {
  const atoms = urnTerm.replace(/:+/g, ':').split(':');
  return atoms.length > 2 ? atoms.slice(2).join(':') : '';
}

/**
 * Compute a node's full + bare canonical URN. `full` (hrn:node:…) is for
 * display; `bare` (root:mem:loc) is what we tier-match the urnTerm against, so
 * a node-URN query is anchored on the WHOLE URN — not just the loc, which would
 * false-match the same loc tail in unrelated memories. Returns null on a
 * malformed memory URN rather than crashing the whole search.
 */
function nodeUrnPair(memUrn: string | null | undefined, loc: string): { full: string; bare: string } | null {
  if (!memUrn) return null;
  try {
    const full = emitNodeUrnV2(memUrn, loc);
    const prefix = 'hrn:node:';
    return { full, bare: full.startsWith(prefix) ? full.slice(prefix.length) : full };
  } catch {
    return null;
  }
}

/**
 * v2 entity URN with the serve-on-failure fallback the search must not crash on:
 * an un-v2-able stored bare urn falls back to the raw stored value (mirrors the
 * old `canonicalUrn` try/catch posture).
 */
function safeEntityUrn(type: 'org' | 'memory' | 'agent' | 'app', bareUrn: string): string {
  try {
    return emitEntityUrnV2(type, bareUrn);
  } catch {
    return bareUrn;
  }
}

// ── Adapters ────────────────────────────────────────────────────────────────

async function searchOrganizations(ctx: AdapterCtx): Promise<GlobalSearchHit[]> {
  const { fields, q, urnTerm, principal } = ctx;
  const preds: AnyWhere[] = [];
  if (fields.has('pk')) preds.push(pkPred(q));
  if (fields.has('urn')) preds.push(...urnPreds('urn', urnTerm));
  if (fields.has('name')) preds.push(textPred('name', q));
  if (preds.length === 0) return [];

  // Spec 048: `isVisible` was dropped with the auto-personal org — every org is
  // now a real (listable) org. #610 (cor:acl:080:02): a NON-admin discovers own
  // member orgs OR any org with a public footprint (`discoverableOrgWhere`), so a
  // non-member can find a public org — hence NO early-return on empty orgIds.
  //   - non-admin (`orgIds !== null`): own member orgs OR any discoverable org.
  //   - admin (`orgIds === null`): every org (a superset of the above).
  const orgScope: Prisma.OrganizationWhereInput =
    principal.orgIds !== null
      ? { OR: [{ id: { in: principal.orgIds } }, discoverableOrgWhere()] }
      : {};

  const rows = await ctx.db.organization.findMany({
    where: {
      AND: [orgScope, { deletedAt: null }, { OR: preds }],
    } as Prisma.OrganizationWhereInput,
    select: { id: true, urn: true, name: true },
    take: ctx.cap,
  });

  const hits: GlobalSearchHit[] = [];
  for (const r of rows) {
    const candidates: FieldCandidate[] = [
      { field: 'urn', value: r.urn, tier: urnMatchTier(r.urn, urnTerm) },
      { field: 'name', value: r.name },
      { field: 'pk', value: r.id, tier: r.id === q ? 3 : 0 },
    ];
    const m = bestMatch(candidates, q, fields);
    if (!m) continue;
    hits.push({
      entityType: 'organization',
      id: r.id,
      urn: safeEntityUrn('org', r.urn),
      name: r.name,
      description: null,
      matchedField: m.field,
      score: m.score,
      memoryId: null,
      organizationId: r.id,
    });
  }
  return hits;
}

async function searchMemories(ctx: AdapterCtx): Promise<GlobalSearchHit[]> {
  const { fields, q, urnTerm, principal } = ctx;
  const preds: AnyWhere[] = [];
  if (fields.has('pk')) preds.push(pkPred(q));
  if (fields.has('urn')) preds.push(...urnPreds('urn', urnTerm));
  if (fields.has('name')) preds.push(textPred('name', q));
  if (fields.has('description')) preds.push(textPred('description', q));
  if (preds.length === 0) return [];

  const rows = await ctx.db.memory.findMany({
    where: {
      AND: [memoryScopeWhere(principal), { deletedAt: null }, { OR: preds }],
    } as Prisma.MemoryWhereInput,
    select: { id: true, urn: true, name: true, description: true, organizationId: true },
    take: ctx.cap,
  });

  const hits: GlobalSearchHit[] = [];
  for (const r of rows) {
    const candidates: FieldCandidate[] = [
      { field: 'urn', value: r.urn, tier: urnMatchTier(r.urn, urnTerm) },
      { field: 'name', value: r.name },
      { field: 'description', value: r.description },
      { field: 'pk', value: r.id, tier: r.id === q ? 3 : 0 },
    ];
    const m = bestMatch(candidates, q, fields);
    if (!m) continue;
    hits.push({
      entityType: 'memory',
      id: r.id,
      urn: safeEntityUrn('memory', r.urn),
      name: r.name,
      description: r.description,
      matchedField: m.field,
      score: m.score,
      memoryId: r.id,
      organizationId: r.organizationId,
    });
  }
  return hits;
}

async function searchNodes(ctx: AdapterCtx): Promise<GlobalSearchHit[]> {
  const { fields, q, urnTerm, principal } = ctx;
  const preds: AnyWhere[] = [];
  if (fields.has('pk')) preds.push(pkPred(q));
  if (fields.has('urn')) {
    // Node URN is computed (memory.urn + loc), so match the stored `loc`:
    //   1. CONTAINS the whole query — covers bare- and partial-loc searches
    //      (`cor:brd:010:01`, `brd:010:01`), the common case.
    //   2. STARTS WITH the loc portion of a full node-URN query —
    //      covers pasting a complete node URN, whose loc the row stores without
    //      the org/memory prefix.
    // The suffix uses startsWith, not contains: locSuffix is a heuristic strip
    // that mis-fires on partial locs (yielding e.g. `01`), and a broad
    // `contains '01'` would flood the candidate cap and drop the real row
    // (#301). An anchored startsWith for a bad guess matches ~nothing, so the
    // precise predicate (1) still carries the search. Scoring re-anchors on the
    // full node URN regardless.
    preds.push(textPred('loc', urnTerm));
    const suffix = locSuffix(urnTerm);
    if (suffix && suffix !== urnTerm) preds.push(startsPred('loc', suffix));
  }
  if (fields.has('name')) preds.push(textPred('name', q));
  if (fields.has('description')) preds.push(textPred('description', q));
  if (fields.has('content')) {
    // content is ciphertext on encrypted memories → restrict to plaintext rows.
    preds.push({ AND: [textPred('content', q), { memory: { isEncrypted: false } }] });
  }
  if (preds.length === 0) return [];

  if (fields.has('content')) {
    const encCount = await ctx.db.memory.count({
      where: { AND: [memoryScopeWhere(principal), { deletedAt: null }, { isEncrypted: true }] } as Prisma.MemoryWhereInput,
    });
    if (encCount > 0) {
      ctx.degraded.push(
        `Content search skipped ${encCount} encrypted ${encCount === 1 ? 'memory' : 'memories'} — substring search cannot read encrypted content. Use semantic search (nodeSearch / hadron_find_nodes).`,
      );
    }
  }

  // Build select conditionally — `content: false` inside a Prisma select is
  // non-idiomatic; only add `content` when it's actually searched.
  const nodeSelect: Prisma.NodeSelect = {
    id: true,
    name: true,
    description: true,
    loc: true,
    memoryId: true,
    memory: { select: { urn: true, organizationId: true, isEncrypted: true } },
  };
  if (fields.has('content')) nodeSelect.content = true;

  const rows = await ctx.db.node.findMany({
    where: {
      AND: [nodeScopeWhere(principal), { deletedAt: null }, { OR: preds }],
    } as Prisma.NodeWhereInput,
    select: nodeSelect,
    take: ctx.cap,
  });

  const hits: GlobalSearchHit[] = [];
  for (const r of rows) {
    const np = nodeUrnPair(r.memory?.urn, r.loc);
    // Tier the urn match against the WHOLE node URN, not the loc — so a broad
    // loc-tail SQL prefilter hit in an unrelated memory scores 0 and is dropped.
    const urnTier = np ? urnMatchTier(np.bare, urnTerm) : 0;
    // Only score content when the memory is non-encrypted (matches the predicate).
    const contentVal =
      fields.has('content') && r.memory && !r.memory.isEncrypted
        ? ((r as { content?: string | null }).content ?? null)
        : null;
    const candidates: FieldCandidate[] = [
      { field: 'urn', value: np?.bare ?? r.loc, tier: urnTier },
      { field: 'name', value: r.name },
      { field: 'description', value: r.description },
      { field: 'content', value: contentVal },
      { field: 'pk', value: r.id, tier: r.id === q ? 3 : 0 },
    ];
    const m = bestMatch(candidates, q, fields);
    if (!m) continue;
    hits.push({
      entityType: 'node',
      id: r.id,
      urn: np?.full ?? null,
      name: r.name,
      description: r.description,
      matchedField: m.field,
      score: m.score,
      memoryId: r.memoryId,
      organizationId: r.memory?.organizationId ?? null,
    });
  }
  return hits;
}

async function searchAgents(ctx: AdapterCtx): Promise<GlobalSearchHit[]> {
  const { fields, q, urnTerm, principal } = ctx;
  const preds: AnyWhere[] = [];
  if (fields.has('pk')) preds.push(pkPred(q));
  if (fields.has('urn')) preds.push(...urnPreds('urn', urnTerm));
  if (fields.has('name')) preds.push(textPred('name', q));
  if (fields.has('description')) preds.push(textPred('description', q));
  if (preds.length === 0) return [];
  if (principal.orgIds !== null && principal.orgIds.length === 0) return [];

  const scope: AnyWhere[] = [{ deletedAt: null }, { OR: preds }];
  if (principal.orgIds !== null) {
    scope.push({ organizationId: { in: principal.orgIds } });
  }
  // Exclude other users' PERSONAL (creator-only draft) agents — mirrors the
  // Organization.agents resolver, which applies this carve-out by viewer
  // identity REGARDLESS of admin, so admin global search doesn't leak drafts.
  // #876 class sweep: same creator-keyed clause as Organization.agents — an
  // impersonated principal must not match the target's PERSONAL drafts.
  if (principal.viewerUserId && !principal.impersonationOrgId) {
    scope.push({ OR: [{ visibility: { not: 'PERSONAL' } }, { createdBy: principal.viewerUserId }] });
  } else {
    scope.push({ visibility: { not: 'PERSONAL' } });
  }

  const rows = await ctx.db.agent.findMany({
    where: { AND: scope } as Prisma.AgentWhereInput,
    select: { id: true, urn: true, name: true, description: true, organizationId: true },
    take: ctx.cap,
  });

  const hits: GlobalSearchHit[] = [];
  for (const r of rows) {
    const candidates: FieldCandidate[] = [
      { field: 'urn', value: r.urn, tier: urnMatchTier(r.urn, urnTerm) },
      { field: 'name', value: r.name },
      { field: 'description', value: r.description },
      { field: 'pk', value: r.id, tier: r.id === q ? 3 : 0 },
    ];
    const m = bestMatch(candidates, q, fields);
    if (!m) continue;
    hits.push({
      entityType: 'agent',
      id: r.id,
      urn: safeEntityUrn('agent', r.urn),
      name: r.name,
      description: r.description,
      matchedField: m.field,
      score: m.score,
      memoryId: null,
      organizationId: r.organizationId,
    });
  }
  return hits;
}

async function searchApps(ctx: AdapterCtx): Promise<GlobalSearchHit[]> {
  const { fields, q, urnTerm, principal } = ctx;
  const preds: AnyWhere[] = [];
  if (fields.has('pk')) preds.push(pkPred(q));
  if (fields.has('urn')) preds.push(...urnPreds('urn', urnTerm));
  if (fields.has('name')) preds.push(textPred('name', q));
  if (fields.has('description')) preds.push(textPred('description', q));
  if (preds.length === 0) return [];
  if (principal.orgIds !== null && principal.orgIds.length === 0) return [];

  const rows = await ctx.db.app.findMany({
    where: {
      AND: [
        principal.orgIds !== null ? { organizationId: { in: principal.orgIds } } : {},
        { deletedAt: null },
        { uninstalledAt: null }, // active rows only (021 FR-028 partial-unique URN)
        { OR: preds },
      ],
    } as Prisma.AppWhereInput,
    select: { id: true, urn: true, name: true, description: true, organizationId: true },
    take: ctx.cap,
  });

  const hits: GlobalSearchHit[] = [];
  for (const r of rows) {
    const candidates: FieldCandidate[] = [
      { field: 'urn', value: r.urn, tier: urnMatchTier(r.urn, urnTerm) },
      { field: 'name', value: r.name },
      { field: 'description', value: r.description },
      { field: 'pk', value: r.id, tier: r.id === q ? 3 : 0 },
    ];
    const m = bestMatch(candidates, q, fields);
    if (!m) continue;
    hits.push({
      entityType: 'app',
      id: r.id,
      urn: safeEntityUrn('app', r.urn),
      name: r.name,
      description: r.description,
      matchedField: m.field,
      score: m.score,
      memoryId: null,
      organizationId: r.organizationId,
    });
  }
  return hits;
}

async function searchAiServiceConfigs(ctx: AdapterCtx): Promise<GlobalSearchHit[]> {
  const { fields, q, principal } = ctx;
  const preds: AnyWhere[] = [];
  if (fields.has('pk')) preds.push(pkPred(q));
  if (fields.has('name')) preds.push(textPred('name', q));
  if (preds.length === 0) return [];
  if (principal.orgIds !== null && principal.orgIds.length === 0) return [];

  // Owner-org scope: directly org-owned, or owned by an app/agent in the org.
  // AiServiceConfig has NO deletedAt (hard-deleted) — no soft-delete filter.
  const ownerScope: AnyWhere =
    principal.orgIds !== null
      ? {
          OR: [
            { organizationId: { in: principal.orgIds } },
            { app: { organizationId: { in: principal.orgIds } } },
            { agent: { organizationId: { in: principal.orgIds } } },
          ],
        }
      : {};

  const rows = await ctx.db.aiServiceConfig.findMany({
    where: { AND: [ownerScope, { OR: preds }] } as Prisma.AiServiceConfigWhereInput,
    select: {
      id: true,
      name: true,
      organizationId: true,
      app: { select: { organizationId: true } },
      agent: { select: { organizationId: true } },
    },
    take: ctx.cap,
  });

  const hits: GlobalSearchHit[] = [];
  for (const r of rows) {
    const candidates: FieldCandidate[] = [
      { field: 'name', value: r.name },
      { field: 'pk', value: r.id, tier: r.id === q ? 3 : 0 },
    ];
    const m = bestMatch(candidates, q, fields);
    if (!m) continue;
    hits.push({
      entityType: 'aiServiceConfig',
      id: r.id,
      urn: null,
      name: r.name,
      description: null,
      matchedField: m.field,
      score: m.score,
      memoryId: null,
      organizationId: r.organizationId ?? r.app?.organizationId ?? r.agent?.organizationId ?? null,
    });
  }
  return hits;
}

async function searchUsers(ctx: AdapterCtx): Promise<GlobalSearchHit[]> {
  const { fields, q, urnTerm, principal } = ctx;
  // Parity with the searchUsers query: authenticated viewer only.
  if (!principal.viewerUserId) return [];
  const wantName = fields.has('name');
  const wantPk = fields.has('pk');
  // A user's URN is hrn:user:<handle>, so URN matching is a match on the handle
  // column against the prefix-stripped urnTerm (#325).
  const wantUrn = fields.has('urn');
  if (!wantName && !wantPk && !wantUrn) return [];

  const preds: AnyWhere[] = [];
  if (wantPk) preds.push(pkPred(q));
  if (wantUrn) preds.push(...urnPreds('handle', urnTerm));
  if (wantName) {
    preds.push(textPred('name', q));
    preds.push(textPred('handle', q));
    preds.push(textPred('githubUsername', q));
    preds.push(textPred('email', q));
  }

  const rows = await ctx.db.user.findMany({
    where: { AND: [{ deletedAt: null }, { OR: preds }] } as Prisma.UserWhereInput,
    select: { id: true, name: true, handle: true, githubUsername: true, email: true },
    take: Math.min(ctx.cap, 20),
  });

  // #384: name/email are PII. For rows the viewer can't fully see (not a
  // co-member), drop name/email from BOTH the match candidates and the display
  // fallback — so a stranger can locate a user by handle/urn/githubUsername but
  // can't discover them by, or read back, their real name or email. handle and
  // githubUsername are public-ish identifiers and stay visible.
  const visCtx: UserVisibilityCtx = {
    db: ctx.db,
    userId: principal.viewerUserId ?? undefined,
    roles: principal.isPlatformAdmin ? ['ADMIN'] : undefined,
    // Impersonation: judge name/email co-membership within the shared org only.
    impersonation: principal.impersonationOrgId
      ? { orgId: principal.impersonationOrgId }
      : undefined,
  };

  // Resolve visibility for all candidate rows concurrently (each may hit the DB
  // for a co-membership check); the helper memoizes the viewer's orgs per visCtx.
  const visById = new Map<string, boolean>();
  await Promise.all(rows.map(async (r) => visById.set(r.id, await canSeeUserPersonalFields(visCtx, r.id))));

  const hits: GlobalSearchHit[] = [];
  for (const r of rows) {
    const canSee = visById.get(r.id) ?? false;
    const name = canSee ? r.name : null;
    const email = canSee ? r.email : null;
    const candidates: FieldCandidate[] = [
      // URN match tiers the handle against the urnTerm (the handle IS the slug).
      { field: 'urn', value: r.handle ?? '', tier: urnMatchTier(r.handle, urnTerm) },
      { field: 'name', value: name },
      { field: 'name', value: r.handle },
      { field: 'name', value: r.githubUsername },
      { field: 'name', value: email },
      { field: 'pk', value: r.id, tier: r.id === q ? 3 : 0 },
    ];
    const m = bestMatch(candidates, q, fields);
    if (!m) continue;
    hits.push({
      entityType: 'user',
      id: r.id,
      urn: userUrn(r.handle),
      // `email` is already null for non-visible rows, so this fallback can't leak.
      name: name ?? r.handle ?? r.githubUsername ?? email ?? null,
      description: null,
      matchedField: m.field,
      score: m.score,
      memoryId: null,
      organizationId: null,
    });
  }
  return hits;
}

export const ADAPTERS: Record<SearchEntityType, (ctx: AdapterCtx) => Promise<GlobalSearchHit[]>> = {
  organization: searchOrganizations,
  memory: searchMemories,
  node: searchNodes,
  agent: searchAgents,
  app: searchApps,
  aiServiceConfig: searchAiServiceConfigs,
  user: searchUsers,
};
