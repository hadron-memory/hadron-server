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

import { searchContains } from '../../integrations/db/provider.js';
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';
import {
  bestMatch,
  canonicalUrn,
  composeNodeUrn,
  urnMatchTier,
  urnSearchVariants,
  type FieldCandidate,
} from './match.js';
import type { GlobalSearchHit, SearchEntityType, SearchField, SearchPrincipal } from './types.js';

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

const PERSONAL_CLASSES = ['personal', 'private'] as unknown as Prisma.Enumerable<never>;

/** Memory scope as a Memory `where` (used by the Memory slice + encrypted count). */
function memoryScopeWhere(p: SearchPrincipal): AnyWhere {
  if (p.accessibleMemoryIds !== null) return { id: { in: p.accessibleMemoryIds } };
  // Admin: everything except OTHER users' personal/private (034 carve-out).
  return {
    NOT: { class: { in: PERSONAL_CLASSES }, userId: { not: p.viewerUserId ?? '__none__' } },
  };
}

/** Memory scope projected onto a Node `where`. */
function nodeScopeWhere(p: SearchPrincipal): AnyWhere {
  if (p.accessibleMemoryIds !== null) return { memoryId: { in: p.accessibleMemoryIds } };
  return {
    memory: { NOT: { class: { in: PERSONAL_CLASSES }, userId: { not: p.viewerUserId ?? '__none__' } } },
  };
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

/** Last colon-separated atom of a URN term — the node-loc tail. */
function urnTail(urnTerm: string): string {
  const parts = urnTerm.split(/::|:/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : urnTerm;
}

/**
 * Compute a node's full + bare canonical URN. `full` (hrn:node:…) is for
 * display; `bare` (org::mem::loc) is what we tier-match the urnTerm against, so
 * a node-URN query is anchored on the WHOLE URN — not just the loc, which would
 * false-match the same loc tail in unrelated memories. Returns null on a
 * malformed memory URN rather than crashing the whole search.
 */
function nodeUrnPair(memUrn: string | null | undefined, loc: string): { full: string; bare: string } | null {
  if (!memUrn) return null;
  try {
    const full = composeNodeUrn(memUrn, loc);
    const prefix = 'hrn:node:';
    return { full, bare: full.startsWith(prefix) ? full.slice(prefix.length) : full };
  } catch {
    return null;
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
  if (principal.orgIds !== null && principal.orgIds.length === 0) return [];

  const rows = await ctx.db.organization.findMany({
    where: {
      AND: [
        principal.orgIds !== null ? { id: { in: principal.orgIds } } : {},
        { deletedAt: null },
        { OR: preds },
      ],
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
      urn: canonicalUrn('org', r.urn),
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
      urn: canonicalUrn('memory', r.urn),
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
    // Node URN is computed (memory.urn + loc) — match the loc, plus the URN's
    // trailing atom so a full node-URN query still hits.
    const tail = urnTail(urnTerm);
    preds.push(textPred('loc', urnTerm));
    if (tail !== urnTerm) preds.push(textPred('loc', tail));
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
        `Content search skipped ${encCount} encrypted ${encCount === 1 ? 'memory' : 'memories'} — substring search cannot read encrypted content. Use semantic search (nodeSearch / h-find-nodes).`,
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
  if (principal.viewerUserId) {
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
      urn: canonicalUrn('agent', r.urn),
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
      urn: canonicalUrn('app', r.urn),
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
  const { fields, q, principal } = ctx;
  // Parity with the searchUsers query: authenticated viewer only.
  if (!principal.viewerUserId) return [];
  const wantName = fields.has('name');
  const wantPk = fields.has('pk');
  if (!wantName && !wantPk) return [];

  const preds: AnyWhere[] = [];
  if (wantPk) preds.push(pkPred(q));
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

  const hits: GlobalSearchHit[] = [];
  for (const r of rows) {
    const candidates: FieldCandidate[] = [
      { field: 'name', value: r.name },
      { field: 'name', value: r.handle },
      { field: 'name', value: r.githubUsername },
      { field: 'name', value: r.email },
      { field: 'pk', value: r.id, tier: r.id === q ? 3 : 0 },
    ];
    const m = bestMatch(candidates, q, fields);
    if (!m) continue;
    hits.push({
      entityType: 'user',
      id: r.id,
      urn: null,
      name: r.name ?? r.handle ?? r.githubUsername ?? r.email ?? null,
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
