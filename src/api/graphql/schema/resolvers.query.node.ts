// nodeQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import {
  renderNodeExport,
  type NodeExportFormat,
  type NodeExportSection,
} from '../../../lib/nodeExport.js';
import { renderMarkdownToPdf } from '../../../lib/pdfClient.js';
import { type EdgeForGit } from '../../../integrations/github/nodeFrontmatter.js';
import {
  BATCH_READ_MAX_NODES,
  BATCH_READ_MAX_BYTES,
} from '../../../lib/batchRead.js';
import {
  getEmbeddingClient,
  isEmbeddingConfigured,
} from '../../../lib/embedding/index.js';
import { reciprocalRankFusionScored } from '../../../lib/rrf.js';
import { emitNodeUrnV2, bestEffortFlatNodeUrn } from '../../../lib/urnEmit.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { BooleanQueryError, literalQuery, relaxConjunctionToOr } from '../../../lib/retrieval/tsquery.js';
import {
  compileNodeWhere,
  compileNodePropertySort,
  makePropertySortComparator,
  NodeWhereError,
  type NodeWhere,
  type NodePropertySort,
} from '../../../lib/retrieval/nodeWhere.js';
import type { LexicalField, BrowseSort, NodeSqlFilter } from '../../../lib/retrieval/provider.js';
import { expandWithNeighbors } from '../../../lib/search.js';
import { decryptNodesBatch } from '../../../lib/nodeCrypto.js';
import {
  parseUrnInput,
  validateUrnType,
} from '../../../lib/urn.js';
import { compileTemplate } from '../../../lib/template.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAppRunRef } from '../../../lib/entityRef/appRunRef.js';
import { resolveNodeRevRef } from '../../../lib/entityRef/nodeRevRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { GraphQLError } from 'graphql';
import {
  deserializeTags,
  tagsFilter,
} from '../../../integrations/db/provider.js';
import {
  type Context,
  ROLE_ORDER,
  requireRole,
  requireOrgRole,
  requireOwnerOrOrgRole,
  isOwnerOrOrgMember,
  getAccessibleMemoryIds,
  memoryAccessFilter,
} from './resolvers.helpers.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';

export const nodeQueries = {
    // Spec: cor:api:180 — cross-entity URN resolution
    // (:00 surface & result shape, :01 resolution semantics).
    resolveUrn: async (_: unknown, { urn }: { urn: string }, ctx: Context) => {
      const isGlobalAdmin =
        !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      // Membership check mirroring the per-kind queries' "member of the org"
      // gate, but returning a boolean instead of throwing so we can collapse
      // no-access to null.
      const isOrgMember = async (orgId: string): Promise<boolean> => {
        if (isGlobalAdmin) return true;
        if (!ctx.userId) return false;
        const member = await ctx.db.orgMember.findFirst({
          where: { organizationId: orgId, userId: ctx.userId, deletedAt: null },
        });
        return !!member;
      };

      // #696: a `#data` fragment addresses its parent (node / apprun). Strip
      // it, resolve the parent, and tag the result so a caller knows it named
      // the data view. Only `#data` is defined.
      let fragment: string | undefined;
      let baseUrn = urn;
      const hashIdx = urn.indexOf('#');
      if (hashIdx !== -1) {
        fragment = urn.slice(hashIdx + 1);
        baseUrn = urn.slice(0, hashIdx);
        if (fragment !== 'data') return null;
      }
      // Extract the type word generically from the scheme prefix — parseUrnInput
      // only recognizes the fixed v1 type list, so the v2-only apprun/noderev
      // types (#696) would fall through to 'unknown'. Fall back to parseUrnInput
      // for unprefixed / loc: inputs.
      const schemeType = baseUrn.match(/^(?:hrn|urn):([a-z][a-z0-9-]*):/i)?.[1]?.toLowerCase();
      const type = schemeType ?? (parseUrnInput(baseUrn).type as string);
      if (fragment && type !== 'node' && type !== 'apprun') return null;
      switch (type) {
        // `mem` is the grammar-v2 type word for a memory (#697 emission flip);
        // it dispatches identically to the v1 `memory` word so a v2-emitted
        // `hrn:mem:root:slug` resolves (resolveMemoryRef accepts both via the
        // urn-lib `mem`→`memory` input alias).
        case 'mem':
        case 'memory': {
          let id: string;
          try {
            ({ id } = await resolveMemoryRef(ctx.db, urn));
          } catch {
            return null;
          }
          const memory = await ctx.db.memory.findUnique({
            where: { id },
            select: { organizationId: true, ownerUserId: true },
          });
          if (!memory) return null;
          if (!(await isOwnerOrOrgMember(ctx, memory))) return null;
          return { kind: 'memory', id };
        }
        case 'node': {
          let id: string;
          try {
            ({ id } = await resolveNodeRef(ctx.db, baseUrn));
          } catch {
            return null;
          }
          const node = await ctx.db.node.findUnique({
            where: { id },
            select: { memoryId: true },
          });
          if (!node) return null;
          // Same access gate as nodeById. memoryAccessFilter returns either an
          // explicit allow-list filter (`{ memoryId: { in: [...] } }`) — which
          // for platform ADMIN/OWNER still carves out other users' personal/
          // private memories (034) — or `{}` (no `memoryId` key) when the
          // caller's access is genuinely unrestricted. We only apply the
          // allow-list when the `memoryId` key is present; an empty filter
          // falls through and admits the node, exactly as nodeById does.
          const access = await memoryAccessFilter(ctx);
          if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
            if (!(access.memoryId.in as string[]).includes(node.memoryId)) return null;
          }
          return { kind: 'node', id, memoryId: node.memoryId, ...(fragment ? { fragment } : {}) };
        }
        case 'org': {
          let id: string;
          try {
            ({ id } = await resolveOrgRef(ctx.db, urn));
          } catch {
            return null;
          }
          if (!(await isOrgMember(id))) return null;
          return { kind: 'org', id };
        }
        case 'agent': {
          let id: string;
          try {
            ({ id } = await resolveAgentRef(ctx.db, urn));
          } catch {
            return null;
          }
          const agent = await ctx.db.agent.findUnique({
            where: { id },
            select: { organizationId: true, visibility: true, ownerUserId: true },
          });
          if (!agent) return null;
          // #551: a PUBLIC agent resolves for any caller (marketplace share
          // links), mirroring the agent(ref:) gate; otherwise fall back to the
          // owner-or-org-membership check.
          if (agent.visibility !== 'PUBLIC' && !(await isOwnerOrOrgMember(ctx, agent))) {
            return null;
          }
          return { kind: 'agent', id };
        }
        case 'app': {
          let id: string;
          try {
            ({ id } = await resolveAppRef(ctx.db, urn));
          } catch {
            return null;
          }
          const app = await ctx.db.app.findUnique({
            where: { id },
            select: { organizationId: true, ownerUserId: true },
          });
          if (!app) return null;
          // The dedicated app(ref:) query admits any member of the App's org
          // (#473 relaxed it from org ADMIN); mirror that so a member's
          // /app/u/<app-urn> share link resolves to the same page they can
          // already open directly. isOwnerOrOrgMember covers the
          // global-admin bypass, the App's owner-user, and the
          // revoked-membership (deletedAt) rule.
          if (!(await isOwnerOrOrgMember(ctx, app))) return null;
          return { kind: 'app', id, organizationId: app.organizationId };
        }
        case 'user': {
          let id: string;
          try {
            ({ id } = await resolveUserRef(ctx.db, urn));
          } catch {
            return null;
          }
          // A user reference resolves for the user themselves, a platform admin,
          // or a caller who shares at least one organization with the target —
          // mirroring the org-membership gate the other kinds use. (Returns only
          // a {kind,id} ref, no PII; the user's own pages enforce data access.)
          if (!isGlobalAdmin && ctx.userId !== id) {
            if (!ctx.userId) return null;
            // Caller shares ≥1 org with the target — a single query via the
            // org-membership relation (no extra round-trip / in-memory mapping).
            const shared = await ctx.db.orgMember.findFirst({
              where: {
                userId: ctx.userId,
                deletedAt: null,
                organization: { members: { some: { userId: id, deletedAt: null } } },
              },
              select: { organizationId: true },
            });
            if (!shared) return null;
          }
          return { kind: 'user', id };
        }
        case 'apprun': {
          // #696: hrn:apprun:<root>:<app>:<run-id> (+ optional #data fragment).
          let id: string;
          try {
            ({ id } = await resolveAppRunRef(ctx.db, baseUrn));
          } catch {
            return null;
          }
          const run = await ctx.db.appRun.findUnique({
            where: { id },
            select: { organizationId: true },
          });
          if (!run) return null;
          // Same READER-of-the-org gate the appRun(ref:) query enforces.
          if (!(await isOrgMember(run.organizationId))) return null;
          return {
            kind: 'apprun',
            id,
            organizationId: run.organizationId,
            ...(fragment ? { fragment } : {}),
          };
        }
        case 'noderev': {
          // #696: hrn:noderev:<root>:<mem>:<loc...>:<rev> (end-anchored).
          let id: string;
          try {
            ({ id } = await resolveNodeRevRef(ctx.db, baseUrn));
          } catch {
            return null;
          }
          // Gate on the revision's captured memory (#602/#618) — legacy rows
          // (null memoryId) fall back to the node's current memory.
          const rev = await ctx.db.nodeRevision.findUnique({
            where: { id },
            select: { memoryId: true, nodeId: true },
          });
          if (!rev) return null;
          let memoryId = rev.memoryId;
          if (!memoryId) {
            const node = await ctx.db.node.findUnique({
              where: { id: rev.nodeId },
              select: { memoryId: true },
            });
            memoryId = node?.memoryId ?? null;
          }
          if (!memoryId) return null;
          const access = await memoryAccessFilter(ctx);
          if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
            if (!(access.memoryId.in as string[]).includes(memoryId)) return null;
          }
          return { kind: 'noderev', id, memoryId };
        }
        default:
          return null;
      }
    },

    // #473 — the uniform single-node read: node(ref:) subsumes the former
    // nodeById(id:) + node(loc:, memory:) split. `ref` dispatch order:
    //   1. PK (the old nodeById path),
    //   2. explicit `hrn:node:` URN → strict resolveNodeRef,
    //   3. bare loc — pinned by `memory:` when given (#335 scoped path);
    //      unscoped, an unprefixed 3+-segment ref whose 2-segment prefix
    //      names a live memory reads as a full URN, anything else resolves
    //      across every readable memory with the #335 ambiguity guard.
    node: async (
      _: unknown,
      { ref, memoryRef, raw }: { ref: string; memoryRef?: string | null; raw?: boolean | null },
      ctx: Context,
    ) => {
      const access = await memoryAccessFilter(ctx);
      const include = {
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      };
      // Denied ≡ not-found (null) — same non-disclosure the old queries had.
      const allowed = (memoryId: string): boolean => {
        if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
          return (access.memoryId.in as string[]).includes(memoryId);
        }
        return true;
      };
      // Decrypt + (unless raw) compile Mustache templates — shared tail of
      // every dispatch form. Generic so the full node row type flows through.
      const finish = async <T extends { content: string | null; data: unknown; memoryId: string }>(
        node: T,
      ) => {
        await decryptNodesBatch(ctx.db, [node]);
        if (!raw && node.content?.includes('{{')) {
          const compiled = await compileTemplate(
            node.content, node.data as Record<string, unknown> | null, node.memoryId, ctx.db, access,
          );
          return { ...node, content: compiled };
        }
        return node;
      };

      // Form 1: primary key. #391: a soft-deleted node must not resolve by PK
      // (findUnique can't carry deletedAt in its where, so guard post-fetch).
      if (isId(ref)) {
        const node = await ctx.db.node.findUnique({ where: { id: ref }, include });
        if (!node || node.deletedAt || !allowed(node.memoryId)) return null;
        return finish(node);
      }

      const parsed = parseUrnInput(ref);
      const typeErr = validateUrnType(parsed, 'node');
      if (typeErr) throw new Error(typeErr);
      const value = parsed.value;

      // Form 2: explicit `hrn:node:` URN — strict resolution, no loc
      // fallback (resolveNodeRef enforces the fully-qualified shape; a
      // malformed input propagates as UrnNotQualifiedError rather than
      // masking as not-found).
      if (parsed.type === 'node') {
        let id: string;
        try {
          ({ id } = await resolveNodeRef(ctx.db, ref));
        } catch (e) {
          if (e instanceof NodeNotFoundError) return null;
          throw e;
        }
        const node = await ctx.db.node.findUnique({ where: { id }, include });
        if (!node || node.deletedAt || !allowed(node.memoryId)) return null;
        return finish(node);
      }

      // Form 3a: bare loc pinned by `memory:` (ID or URN per
      // 007-entity-id-or-urn). #335: scoping pins the lookup; the access
      // filter is still intersected so `memory` can never widen visibility.
      if (memoryRef != null && memoryRef !== '') {
        const { id: scopedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
        if (!allowed(scopedMemoryId)) return null;
        const node = await ctx.db.node.findFirst({
          where: { loc: value, memoryId: scopedMemoryId, deletedAt: null },
          include,
        });
        return node ? finish(node) : null;
      }

      // Form 3b: unprefixed + unscoped. A 3+-segment ref whose memory prefix
      // names a live memory is a full URN (mirrors resolveNodeRef's
      // fallthrough); pass `memory:` to force loc interpretation of such a
      // ref. Canonical `::` input: loc is the FINAL leaf and the memory URN
      // is everything before it (memory URNs may span >2 hierarchy levels,
      // e.g. per-user `<org>::<agent>::app-user:<id>` — PR-475 review);
      // legacy single-`:` input keeps the two-segment heuristic.
      const isCanonical = value.includes('::');
      const parts = isCanonical ? value.split('::') : value.split(':');
      if (parts.length >= 3) {
        const urnLoc = isCanonical ? parts[parts.length - 1] : parts.slice(2).join(':');
        const memoryUrnCandidates = isCanonical
          ? [parts.slice(0, -1).join('::'), parts.slice(0, -1).join(':')]
          : [`${parts[0]}:${parts[1]}`, `${parts[0]}::${parts[1]}`];
        const memory = await ctx.db.memory.findFirst({
          where: { urn: { in: memoryUrnCandidates }, deletedAt: null },
          select: { id: true },
        });
        if (memory) {
          if (!allowed(memory.id)) return null;
          const node = await ctx.db.node.findFirst({
            where: { loc: urnLoc, memoryId: memory.id, deletedAt: null },
            include,
          });
          return node ? finish(node) : null;
        }
      }

      // Form 3c: bare loc across EVERY readable memory. #391: exclude
      // soft-deleted rows so node(ref:) matches resolveUrn.
      const candidates = await ctx.db.node.findMany({
        where: { loc: value, ...access, deletedAt: null },
        include,
      });
      if (candidates.length === 0) return null;

      // #335: fail loud on a cross-memory loc collision instead of silently
      // picking one. The (loc, memoryId) unique guarantees >1 candidate ⇒
      // distinct memories, so this only fires for a genuinely ambiguous
      // unscoped read.
      if (candidates.length > 1) {
        const memoryIds = candidates.map((n) => n.memoryId);
        throw new GraphQLError(
          `loc "${value}" matches ${candidates.length} readable memories ` +
            `(${memoryIds.join(', ')}). Pass \`memory:\` to scope the lookup, ` +
            `or pass the node's PK or full URN as \`ref\` for an unambiguous read.`,
          { extensions: { code: 'AMBIGUOUS_NODE_LOC', loc: value, memoryIds } },
        );
      }
      return finish(candidates[0]);
    },

    // #386: render one node to its portable single-node file. Same node-read
    // gate as nodeById; uses RAW content (the export must round-trip, so it
    // never template-compiles) and the same unordered edge include the CLI's
    // nodeBatch uses, so edge order agrees.
    nodeExport: async (
      _: unknown,
      { id, format, full, sections }: { id: string; format?: NodeExportFormat | null; full?: boolean | null; sections?: NodeExportSection[] | null },
      ctx: Context,
    ) => {
      const access = await memoryAccessFilter(ctx);
      const node = await ctx.db.node.findUnique({
        where: { id },
        include: { outgoingEdges: { include: { target: true } } },
      });
      // #391: don't export a soft-deleted node (denied ≡ not-found).
      if (!node || node.deletedAt) throw new GraphQLError('Node not found', { extensions: { code: 'NOT_FOUND' } });
      if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
        // Denied and not-found are indistinguishable on purpose (same as nodeById).
        if (!(access.memoryId.in as string[]).includes(node.memoryId)) {
          throw new GraphQLError('Node not found', { extensions: { code: 'NOT_FOUND' } });
        }
      }
      await decryptNodesBatch(ctx.db, [node]);
      const memory = await ctx.db.memory.findUnique({
        where: { id: node.memoryId },
        select: { urn: true },
      });

      const fmt: NodeExportFormat = format ?? 'MD';

      // PDF is a presentation render produced by the external hadrontool-pdf
      // service from the node's (already-decrypted) Markdown content. Unlike
      // MD/JSON it is not the canonical round-trippable file, so `full` /
      // `sections` do not apply. Delivered BASE64.
      if (fmt === 'PDF') {
        const markdown =
          node.content && node.content.trim().length > 0 ? node.content : `# ${node.name}`;
        const { base64, bytes } = await renderMarkdownToPdf(markdown, { title: node.name });
        const leaf = node.loc ? node.loc.split(':').pop() || node.loc : node.name || 'node';
        return {
          format: 'PDF',
          mimeType: 'application/pdf',
          filename: `${leaf}.pdf`,
          encoding: 'BASE64',
          data: base64,
          bytes,
        };
      }

      const { mimeType, data } = renderNodeExport(
        {
          id: node.id,
          memoryUrn: memory?.urn ?? '',
          loc: node.loc,
          name: node.name,
          nodeType: node.nodeType,
          alias: node.alias,
          description: node.description,
          abstract: node.abstract,
          abstractOriginHash: node.abstractOriginHash,
          content: node.content,
          tags: deserializeTags(node.tags) as string[],
          seq: node.seq,
          data: node.data,
          properties: node.properties,
          edges: node.outgoingEdges as unknown as EdgeForGit[],
        },
        { format: fmt, full: full !== false, sections: sections ?? null },
      );

      const leaf = node.loc ? node.loc.split(':').pop() || node.loc : node.name || 'node';
      return {
        format: fmt,
        mimeType,
        filename: `${leaf}.${fmt === 'JSON' ? 'json' : 'md'}`,
        encoding: 'TEXT',
        data,
        bytes: Buffer.byteLength(data, 'utf8'),
      };
    },

    // cor:api:090 — unified node search. Supersedes `nodes` (filter/list) +
    // `nodeSearch` (rank): omit `query` for a filtered list; pass it to rank by
    // `mode` (keyword | vector | hybrid | regex). Lexical modes go through the
    // Postgres FTS engine behind the retrieval seam (field-weighted ranking +
    // boolean operators). Access-scoped exactly like the per-kind node queries.
    findNodes: async (
      _: unknown,
      {
        query, mode, filter, fields, sort, sortProperty, expand, granularity, orgId, limit, offset, minScore,
      }: {
        query?: string | null;
        mode?: 'keyword' | 'vector' | 'hybrid' | 'regex' | null;
        minScore?: number | null;
        filter?: {
          memoryIds?: string[] | null;
          memoryClasses?: string[] | null;
          nodeType?: string | null;
          objectType?: string | null;
          tags?: string[] | null;
          isRunnable?: boolean | null;
          locPrefix?: string | null;
          createdBy?: string | null;
          updatedAfter?: string | null;
          updatedBefore?: string | null;
          includeDeleted?: boolean | null;
          where?: NodeWhere | null;
        } | null;
        fields?: string[] | null;
        sort?: 'relevance' | 'loc' | 'seq' | 'updatedAt' | null;
        sortProperty?: NodePropertySort | null;
        expand?: number | null;
        granularity?: 'node' | 'chunk' | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const f = filter ?? {};
      const finalLimit = limit ?? 50;
      const off = offset ?? 0;
      // #497 — optional absolute relevance floor. Applied to the ranked scores
      // before paging (a NaN guard so a bad arg is simply ignored, never throws).
      // Scores are NOT commensurable across modes, so the meaningful floor scale
      // differs per mode (keyword ts_rank ≈ 0..a-few; vector cosine ≈ 0..1;
      // hybrid RRF ≈ small fractions) — documented on the arg. Never applies to
      // the no-query browse list (those hits are unscored) or expand-neighbours.
      const scoreFloor = typeof minScore === 'number' && Number.isFinite(minScore) ? minScore : null;
      const applyFloor = (ranked: { nodeId: string; score: number }[]) =>
        scoreFloor == null ? ranked : ranked.filter((r) => r.score >= scoreFloor);
      const provider = getRetrievalProvider();
      const badInput = (msg: string) =>
        new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });

      if (expand != null && (expand < 0 || expand > 3 || !Number.isInteger(expand))) {
        throw badInput('findNodes `expand` must be an integer in [0, 3].');
      }
      const expandDepth = expand ?? 0;
      if (f.updatedAfter && Number.isNaN(Date.parse(f.updatedAfter))) {
        throw badInput('findNodes filter.updatedAfter must be a valid date string.');
      }
      if (f.updatedBefore && Number.isNaN(Date.parse(f.updatedBefore))) {
        throw badInput('findNodes filter.updatedBefore must be a valid date string.');
      }
      // #719 — validate the `where` predicate up front (a throwaway compile) so a
      // malformed/oversized tree surfaces as BAD_USER_INPUT before dispatch; the
      // downstream compiles (filterClause / filterSearch) then can't throw.
      if (f.where != null) {
        try {
          compileNodeWhere(f.where, () => '$0');
        } catch (e) {
          if (e instanceof NodeWhereError) throw badInput(`findNodes filter.where: ${e.message}`);
          throw e;
        }
      }
      // #719 — validate the property-path sort up front (throwaway compile) so a
      // malformed path/direction is BAD_USER_INPUT before dispatch. Reuses the
      // where-leaf addressing; missing/unparseable values sort last, loc breaks ties.
      if (sortProperty != null) {
        try {
          compileNodePropertySort(sortProperty);
        } catch (e) {
          if (e instanceof NodeWhereError) throw badInput(`findNodes sortProperty: ${e.message}`);
          throw e;
        }
      }

      // #463: optional single-org narrowing. Resolve + membership-gate up front
      // (member → scope; non-member → empty envelope, no existence disclosure),
      // then push the org filter into the scope queries below. Uniform
      // member-only — NO platform-admin bypass; an App-key caller may scope to
      // its own App's org. AND-narrowing only: it can never widen the caller's
      // accessible set. Combined with filter.isRunnable: true this is the
      // "runnable task nodes in one org" query (there is no separate myTasks).
      const emptyResult = { hits: [], passages: [], total: 0, reason: null, degraded: null };
      let orgScopeId: string | null = null;
      if (orgId != null) {
        let resolvedOrgId: string;
        try {
          ({ id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId));
        } catch {
          return emptyResult;
        }
        let authorized = false;
        if (ctx.userId) {
          const memberOrgIds = await getMemberOrgIds(ctx.db, ctx.userId);
          authorized = memberOrgIds.includes(resolvedOrgId);
        } else if (ctx.appId) {
          // App-key: its access is already confined to its App's org via the
          // session, so authorize scoping to that org (any other → empty).
          const app = await ctx.db.app.findUnique({
            where: { id: ctx.appId },
            select: { organizationId: true },
          });
          authorized = app?.organizationId === resolvedOrgId;
        }
        if (!authorized) return emptyResult;
        orgScopeId = resolvedOrgId;
      }

      // ── Resolve scope: accessible ∩ requested memories (ID/URN mix) ──
      const accessible = await getAccessibleMemoryIds(ctx);
      const explicitIds = !!(f.memoryIds && f.memoryIds.length > 0);
      const memClassClause: unknown =
        f.memoryClasses && f.memoryClasses.length > 0
          ? { in: f.memoryClasses }
          : (!explicitIds ? { not: 'system' } : undefined); // broad search hides system-class; explicit ids win

      // #463: push the org narrowing straight into the scope queries (rather
      // than selecting all ids then intersecting) so the admin/broad path never
      // materializes every memory id just to filter it down.
      const orgWhere = orgScopeId ? { organizationId: orgScopeId } : {};

      let scopeIds: string[];
      if (explicitIds) {
        const resolved = await Promise.all(
          f.memoryIds!.map((ref) =>
            isId(ref)
              ? Promise.resolve(ref)
              : resolveMemoryRef(ctx.db, ref).then((r) => r.id).catch(() => null)),
        );
        const requested = resolved.filter((id): id is string => id !== null);
        const allowed = accessible === null ? null : new Set(accessible);
        scopeIds = allowed === null ? requested : requested.filter((id) => allowed.has(id));
        // Query only when a class or org filter must be applied to the requested
        // set; otherwise the requested ∩ accessible ids stand as-is.
        if ((memClassClause || orgScopeId) && scopeIds.length > 0) {
          const rows = await ctx.db.memory.findMany({
            where: { id: { in: scopeIds }, ...(memClassClause ? { class: memClassClause as never } : {}), ...orgWhere },
            select: { id: true },
          });
          scopeIds = rows.map((m) => m.id);
        }
      } else if (accessible === null) {
        // Admin/broad — resolve scope + class + org filter in one query.
        const rows = await ctx.db.memory.findMany({
          where: { deletedAt: null, ...(memClassClause ? { class: memClassClause as never } : {}), ...orgWhere },
          select: { id: true },
        });
        scopeIds = rows.map((m) => m.id);
      } else {
        const rows = await ctx.db.memory.findMany({
          where: { id: { in: accessible }, ...(memClassClause ? { class: memClassClause as never } : {}), ...orgWhere },
          select: { id: true },
        });
        scopeIds = rows.map((m) => m.id);
      }
      if (scopeIds.length === 0) {
        return { hits: [], passages: [], total: 0, reason: null, degraded: null };
      }

      // Structured node-attribute filters (cor:api:090:02), AND-combined. Applied
      // to BOTH the no-query list path and the ranked-query path (via re-fetch),
      // so query results respect them exactly like the list does.
      const structuredWhere: Record<string, unknown> = {
        ...(f.includeDeleted ? {} : { deletedAt: null }),
        // Explicit nodeType wins; otherwise exclude system-type nodes (orthogonal
        // to the memory-class exclusion above).
        ...(f.nodeType ? { nodeType: f.nodeType } : { nodeType: { not: 'system' } }),
        ...(f.objectType ? { objectType: f.objectType } : {}),
        ...(f.isRunnable != null ? { isRunnable: f.isRunnable } : {}),
        ...(f.tags?.length ? tagsFilter(f.tags) : {}),
        ...(f.locPrefix ? { loc: { startsWith: f.locPrefix } } : {}),
        ...(f.createdBy ? { createdBy: f.createdBy } : {}),
        ...((f.updatedAfter || f.updatedBefore)
          ? { updatedAt: {
              ...(f.updatedAfter ? { gte: new Date(f.updatedAfter) } : {}),
              ...(f.updatedBefore ? { lte: new Date(f.updatedBefore) } : {}),
            } }
          : {}),
      };
      const nodeInclude = {
        memory: true,
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      } as const;

      const hasQuery = typeof query === 'string' && query.trim() !== '';

      // Structured filters for the SQL paths (the lexical modes, and the no-query
      // browse when a `where` predicate is present). Mirrors `structuredWhere`
      // (the Prisma form) but adds the JSONB `where`, which Prisma can't express.
      const sqlFilter: NodeSqlFilter = {
        nodeType: f.nodeType ?? null,
        objectType: f.objectType ?? null,
        isRunnable: f.isRunnable ?? null,
        tags: f.tags ?? null,
        locPrefix: f.locPrefix ?? null,
        createdBy: f.createdBy ?? null,
        updatedAfter: f.updatedAfter ?? null,
        updatedBefore: f.updatedBefore ?? null,
        where: f.where ?? null,
      };

      // ── No query → filtered list (subsumes `nodes`) ──
      if (!hasQuery) {
        // A `where` predicate (JSONB the Prisma query can't express) OR a
        // property-path sort (an ORDER BY over a JSON path Prisma can't express)
        // → run the filtered browse in SQL (ordered ids), then hydrate. The plain
        // browse (no where, no property sort) keeps the Prisma path below.
        if (f.where != null || sortProperty != null) {
          const browseSort: BrowseSort | undefined =
            sort === 'seq' ? 'seq' : sort === 'updatedAt' ? 'updatedAt' : undefined;
          const ids = await provider.filterSearch({
            db: ctx.db, memoryIds: scopeIds, filter: sqlFilter,
            includeDeleted: !!f.includeDeleted, sort: browseSort,
            propertySort: sortProperty ?? undefined, offset: off, limit: finalLimit,
          });
          // Re-assert the memory scope on hydration (defense-in-depth): the ids
          // are already scoped by filterSearch's `memory_id IN (scopeIds)`, but
          // re-scoping here means a concurrent cross-memory move (cf. #409) can
          // never surface an out-of-scope node — cross-tenant reads are the
          // first-class invariant, not a cosmetic one.
          const rows = await ctx.db.node.findMany({
            where: { id: { in: ids }, memoryId: { in: scopeIds } },
            include: nodeInclude,
          });
          await decryptNodesBatch(ctx.db, rows);
          const byId = new Map(rows.map((n) => [n.id, n]));
          const ordered = ids.map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
          return {
            hits: ordered.map((n) => ({ node: n, score: null, vector: null })),
            passages: [], total: null, reason: null, degraded: null,
          };
        }
        const orderBy =
          sort === 'seq' ? { seq: 'asc' as const }
          : sort === 'updatedAt' ? { updatedAt: 'desc' as const }
          : { loc: 'asc' as const }; // relevance is meaningless without a query → deterministic browse order
        const rows = await ctx.db.node.findMany({
          where: { memoryId: { in: scopeIds }, ...structuredWhere },
          orderBy,
          skip: off,
          take: finalLimit,
          include: nodeInclude,
        });
        await decryptNodesBatch(ctx.db, rows);
        return {
          hits: rows.map((n) => ({ node: n, score: null, vector: null })),
          passages: [],
          total: null,
          reason: null,
          degraded: null,
        };
      }

      const q = query!.trim();
      const effectiveMode = mode ?? 'hybrid';
      const lexFields = (fields ?? undefined) as LexicalField[] | undefined;
      const model = isEmbeddingConfigured() ? getEmbeddingClient().model : null;
      // A selective structured filter can drop many ranked candidates, so over-fetch
      // from the retrieval layer to keep the page full after post-filtering + offset.
      const hasStructuredFilters = !!(
        f.nodeType || f.objectType || f.isRunnable != null || f.tags?.length || f.locPrefix ||
        f.createdBy || f.updatedAfter || f.updatedBefore || f.includeDeleted || f.where
      );
      const page = off + finalLimit;
      const fetchN = hasStructuredFilters ? Math.min(page * 5, 2000) : page;

      // Hydrate a ranked (nodeId, score) list into hits: enforce the structured
      // filters via a Prisma re-fetch, order (by rank, or by an explicit sort),
      // page with offset/limit, then optionally append expand-neighbours.
      const buildResult = async (
        ranked: { nodeId: string; score: number }[],
        simById: Map<string, number> | null,
        reason: string | null,
        degraded: string | null,
      ) => {
        ranked = applyFloor(ranked);
        const scoreById = new Map(ranked.map((r) => [r.nodeId, r.score]));
        const rankOrder = new Map(ranked.map((r, i) => [r.nodeId, i]));
        // #719 — compose `where` with vector/hybrid ranking: the JSONB predicate
        // can't ride the ranking query (that runs against node_embeddings, not
        // the nodes' JSONB), so intersect the bounded ranked candidate set with
        // the where-satisfying subset (which also re-asserts the memory scope).
        // Only when there ARE vector-ranked candidates (`simById` set): the
        // keyword-only hybrid fallbacks (no_vector_index / embedding_unavailable)
        // already applied `where` in the lexical SQL via sqlFilter, so a
        // filterWhere there would be a redundant query.
        let candidateIds = ranked.map((r) => r.nodeId);
        if (f.where != null && simById != null) {
          const allowed = new Set(
            await provider.filterWhere({
              db: ctx.db, ids: candidateIds, memoryIds: scopeIds,
              where: f.where, includeDeleted: !!f.includeDeleted,
            }),
          );
          candidateIds = candidateIds.filter((id) => allowed.has(id));
        }
        const rows = await ctx.db.node.findMany({
          where: { id: { in: candidateIds }, ...structuredWhere },
          include: nodeInclude,
        });
        await decryptNodesBatch(ctx.db, rows);
        // #719 — a property-path sort re-orders the ranked candidate WINDOW in
        // memory (the vector/hybrid query ranks against node_embeddings, not the
        // JSONB), mirroring the SQL ORDER BY the browse/lexical paths use; missing
        // values sort last, loc breaks ties. Like the enum sort here, it orders
        // only the retrieved candidates — not the whole corpus.
        const propComparator = sortProperty ? makePropertySortComparator(sortProperty) : null;
        const ordered = rows.slice().sort((a, b) => {
          if (propComparator) return propComparator(a, b);
          if (sort === 'loc') return a.loc.localeCompare(b.loc);
          if (sort === 'seq') return (a.seq ?? 0) - (b.seq ?? 0);
          if (sort === 'updatedAt') return b.updatedAt.getTime() - a.updatedAt.getTime();
          return (rankOrder.get(a.id) ?? 0) - (rankOrder.get(b.id) ?? 0); // relevance (default)
        });
        const pageRows = ordered.slice(off, off + finalLimit);
        const hits = pageRows.map((n) => ({
          node: n,
          score: scoreById.get(n.id) ?? null,
          vector: simById?.has(n.id)
            ? { similarity: simById.get(n.id)!, model, chunkIndex: null, offsets: null, abstractStale: null, source: null }
            : null,
        }));
        // Graph-neighbour expansion (context; not re-filtered). Appended after the page.
        if (expandDepth > 0 && pageRows.length > 0) {
          const shown = new Set(pageRows.map((n) => n.id));
          const neighbourIds = (await expandWithNeighbors(
            ctx.db, pageRows.map((n) => n.id), expandDepth, { memoryIds: scopeIds },
          )).filter((id) => !shown.has(id));
          if (neighbourIds.length > 0) {
            const nRows = await ctx.db.node.findMany({
              where: { id: { in: neighbourIds }, deletedAt: null },
              include: nodeInclude,
            });
            await decryptNodesBatch(ctx.db, nRows);
            const nById = new Map(nRows.map((n) => [n.id, n]));
            for (const id of neighbourIds) {
              const n = nById.get(id);
              if (n) hits.push({ node: n, score: null, vector: null });
            }
          }
        }
        return { hits, passages: [], total: null, reason, degraded };
      };

      // `sqlFilter` (built above, incl. the JSONB `where`) is passed to the lexical
      // SQL so keyword/regex results are filtered + sorted + paged exactly
      // (no relevance-truncate-then-filter).
      const lexSort = (sort ?? 'relevance') as 'relevance' | 'loc' | 'seq' | 'updatedAt';

      // Hydrate a ranked list the provider has ALREADY filtered/sorted/paged:
      // fetch by id (order preserved), decrypt, attach scores, append neighbours.
      const hydrateInOrder = async (
        ranked: { nodeId: string; score: number }[],
        simById: Map<string, number> | null,
        reason: string | null,
        degraded: string | null,
      ) => {
        // The lexical provider already applied offset/limit in SQL, so the floor
        // trims sub-threshold hits from the returned page (it does not backfill
        // from deeper ranks — a floor returns fewer, never weaker, results).
        ranked = applyFloor(ranked);
        const scoreById = new Map(ranked.map((r) => [r.nodeId, r.score]));
        const rows = await ctx.db.node.findMany({
          where: { id: { in: ranked.map((r) => r.nodeId) } },
          include: nodeInclude,
        });
        await decryptNodesBatch(ctx.db, rows);
        const byId = new Map(rows.map((n) => [n.id, n]));
        const pageRows = ranked
          .map((r) => byId.get(r.nodeId))
          .filter((n): n is NonNullable<typeof n> => !!n);
        const hits = pageRows.map((n) => ({
          node: n,
          score: scoreById.get(n.id) ?? null,
          vector: simById?.has(n.id)
            ? { similarity: simById.get(n.id)!, model, chunkIndex: null, offsets: null, abstractStale: null, source: null }
            : null,
        }));
        if (expandDepth > 0 && pageRows.length > 0) {
          const shown = new Set(pageRows.map((n) => n.id));
          const neighbourIds = (await expandWithNeighbors(
            ctx.db, pageRows.map((n) => n.id), expandDepth, { memoryIds: scopeIds },
          )).filter((id) => !shown.has(id));
          if (neighbourIds.length > 0) {
            const nRows = await ctx.db.node.findMany({ where: { id: { in: neighbourIds }, deletedAt: null }, include: nodeInclude });
            await decryptNodesBatch(ctx.db, nRows);
            const nById = new Map(nRows.map((n) => [n.id, n]));
            for (const id of neighbourIds) { const n = nById.get(id); if (n) hits.push({ node: n, score: null, vector: null }); }
          }
        }
        return { hits, passages: [], total: null, reason, degraded };
      };

      // Literal fallback for malformed boolean syntax: run the literalized
      // query; a quote-only/empty input still compiles to 'Empty query.'
      // even after literalQuery, which is genuinely zero searchable text —
      // return zero hits, never an error (PR-482 review).
      const safeLiteralSearch = async (
        searchArgs: Omit<Parameters<typeof provider.lexicalSearch>[0], 'query'>,
      ) => {
        try {
          return await provider.lexicalSearch({ ...searchArgs, query: literalQuery(q) });
        } catch (e) {
          if (e instanceof BooleanQueryError) return [];
          throw e;
        }
      };

      // ── LEXICAL modes: keyword (FTS) / regex — filter + sort + page in SQL ──
      if (effectiveMode === 'keyword' || effectiveMode === 'regex') {
        const common = {
          db: ctx.db, memoryIds: scopeIds, fields: lexFields, filter: sqlFilter,
          includeDeleted: !!f.includeDeleted, sort: lexSort,
          propertySort: sortProperty ?? undefined, offset: off, limit: finalLimit,
        };
        try {
          if (effectiveMode === 'regex') {
            return await hydrateInOrder(await provider.regexSearch({ ...common, pattern: q }), null, null, null);
          }
          const ranked = await provider.lexicalSearch({ ...common, query: q });
          // #496 — a natural-language query implicitly ANDs its terms, so one
          // word absent from the corpus zeroes the whole result set. When a bare
          // multi-term conjunction ANDs to zero, retry with the terms OR'd and
          // flag it — the agent gets partial recall (hits matching ANY term)
          // instead of a dead end plus a manual boolean rewrite. Only when the
          // relaxed query actually finds something; otherwise the terms genuinely
          // aren't present, so we keep the honest empty result.
          if (ranked.length === 0) {
            const orQuery = relaxConjunctionToOr(q);
            if (orQuery) {
              // Relax only when the STRICT query is GLOBALLY empty, not when the
              // caller has merely paged past the end of a matching set (PR-571
              // review, Gemini). On page 1 an empty `ranked` already proves that;
              // a deeper page needs a cheap offset-0 probe to distinguish the two
              // (else page 2+ of a relaxed set would come back empty, unpaginable).
              const strictGloballyEmpty =
                off === 0 ||
                (await provider.lexicalSearch({ ...common, query: q, offset: 0, limit: 1 })).length === 0;
              if (strictGloballyEmpty) {
                const relaxed = await provider.lexicalSearch({ ...common, query: orQuery });
                if (relaxed.length > 0) {
                  return await hydrateInOrder(relaxed, null, null, 'and_relaxed_to_or');
                }
              }
            }
          }
          return await hydrateInOrder(ranked, null, null, null);
        } catch (e) {
          // keyword only, explicitly: regexSearch never parses the boolean
          // grammar, but regex must stay hard-error by contract, so the
          // guard is self-documenting rather than incidental.
          if (e instanceof BooleanQueryError && effectiveMode === 'keyword') {
            // Literal fallback: malformed boolean syntax (unmatched paren,
            // unterminated quote, dangling operator) runs as a literal
            // phrase, flagged in the envelope — a search box never turns a
            // typo into BAD_USER_INPUT.
            return await hydrateInOrder(await safeLiteralSearch(common), null, null, 'literal_fallback');
          }
          if (e instanceof Error && (/invalid regular expression/i.test(e.message) || (e as { code?: string }).code === '2201B')) {
            throw badInput(`Invalid regex: ${e.message}`);
          }
          throw e;
        }
      }

      // ── VECTOR / HYBRID: narrow to vector-indexed memories ──
      const indexed = await ctx.db.memory.findMany({
        where: { id: { in: scopeIds }, vectorIndexEnabled: true, deletedAt: null },
        select: { id: true },
      });
      const indexedIds = indexed.map((m) => m.id);

      // Keyword candidate source for hybrid RRF: relevance-ranked, filter applied
      // (buildResult re-filters the fused set too, so this is just less waste).
      // Malformed boolean syntax degrades to a literal phrase here too;
      // lexicalDegraded carries the flag into whichever degrade string the
      // hybrid path ends up emitting.
      let lexicalDegraded: string | null = null;
      const mergeDegraded = (d: string | null): string | null =>
        [d, lexicalDegraded].filter(Boolean).join(',') || null;
      // `relax` (#496, PR-571 review): only the keyword-ONLY hybrid FALLBACK
      // (no vector index / embeddings unavailable) opts in, so that path reaches
      // the same AND→OR relaxation mode:keyword does — otherwise `mode:hybrid`
      // on a non-indexed memory is strictly weaker than `mode:keyword` for the
      // same bare query. TRUE hybrid (vector present) does NOT relax: the vector
      // half already supplies recall, and relaxing would pollute the RRF inputs
      // and mislabel a vector-found result as `and_relaxed_to_or`.
      const runKeywordRanked = async (opts: { relax?: boolean } = {}) => {
        const args = {
          db: ctx.db, memoryIds: scopeIds, fields: lexFields, filter: sqlFilter,
          includeDeleted: !!f.includeDeleted, sort: 'relevance' as const, offset: 0, limit: fetchN,
        };
        try {
          const strict = await provider.lexicalSearch({ ...args, query: q });
          if (!opts.relax || strict.length > 0) return strict;
          const orQuery = relaxConjunctionToOr(q);
          if (orQuery) {
            const relaxed = await provider.lexicalSearch({ ...args, query: orQuery });
            if (relaxed.length > 0) {
              lexicalDegraded = [lexicalDegraded, 'and_relaxed_to_or'].filter(Boolean).join(',');
              return relaxed;
            }
          }
          return strict;
        } catch (e) {
          if (e instanceof BooleanQueryError) {
            lexicalDegraded = 'literal_fallback';
            return safeLiteralSearch(args);
          }
          throw e;
        }
      };

      if (indexedIds.length === 0) {
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked({ relax: true }), null, null, mergeDegraded('no_vector_index'));
        }
        return { hits: [], passages: [], total: 0, reason: 'no_vector_index', degraded: null };
      }
      if (!isEmbeddingConfigured()) {
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked({ relax: true }), null, null, mergeDegraded('embedding_unavailable'));
        }
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }

      let qvec: number[] | undefined;
      try {
        [qvec] = await getEmbeddingClient().embed([q], 'query');
      } catch (err) {
        console.warn(`[findNodes] embed() failed in mode:${effectiveMode}; degrading.`, err);
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked({ relax: true }), null, null, mergeDegraded('embedding_unavailable'));
        }
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }
      if (!qvec) {
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }

      // Chunk granularity (vector only) → passages, mirroring nodeSearch. The
      // coarse structured node filters (nodeType/tags/…) are not applied to
      // passage results in v1 (chunk-level, not node-level) — but a `where`
      // predicate IS honored (#719): a passage from a parent that fails the
      // predicate must not surface, so we drop it below.
      if (granularity === 'chunk') {
        if (effectiveMode !== 'vector') {
          throw badInput(`findNodes granularity:chunk is only supported in mode:vector (got mode:${effectiveMode}).`);
        }
        // Fetch through the offset so paging works (vectorSearchChunks has no offset).
        // #497 — apply the minScore floor to the scored passages too (PR-569
        // review, Codex): filter before paging so a floor drops sub-threshold
        // chunks rather than silently returning them.
        const rawChunks = await provider.vectorSearchChunks({ db: ctx.db, queryEmbedding: qvec, memoryIds: indexedIds, limit: off + finalLimit });
        const chunkHits = (scoreFloor == null ? rawChunks : rawChunks.filter((c) => c.score >= scoreFloor))
          .slice(off, off + finalLimit);
        // #719 — honor `where` on chunk passages: keep only passages whose PARENT
        // node satisfies the predicate (also re-asserts the memory scope).
        let allowedParents: Set<string> | null = null;
        if (f.where != null) {
          allowedParents = new Set(
            await provider.filterWhere({
              db: ctx.db, ids: [...new Set(chunkHits.map((c) => c.nodeId))],
              memoryIds: scopeIds, where: f.where, includeDeleted: !!f.includeDeleted,
            }),
          );
        }
        const parents = await ctx.db.node.findMany({
          where: { id: { in: [...new Set(chunkHits.map((c) => c.nodeId))] }, deletedAt: null },
          include: { memory: { select: { urn: true } } },
        });
        const parentById = new Map(parents.map((p) => [p.id, p]));
        const passages = chunkHits
          .filter((c) => parentById.has(c.nodeId) && (allowedParents == null || allowedParents.has(c.nodeId)))
          .map((c) => {
            const p = parentById.get(c.nodeId)! as { loc: string; memory: { urn: string } };
            // #697 Stage 2: emit the flat v2 node URN (matches Node.urn); fall
            // back to a best-effort flat-v2 join (still `hrn:node:`-prefixed and
            // single-colon, so parentNodeUrn stays uniform with the strict hits)
            // only if the stored memory urn can't compose.
            let parentNodeUrn: string;
            try {
              parentNodeUrn = emitNodeUrnV2(p.memory.urn, p.loc);
            } catch {
              parentNodeUrn = bestEffortFlatNodeUrn('node', p.memory.urn, p.loc);
            }
            return {
              parentNodeId: c.nodeId,
              parentNodeUrn,
              chunkIndex: c.chunkIndex,
              charStart: c.charStart,
              charEnd: c.charEnd,
              text: c.chunkText,
              score: c.score,
            };
          });
        return { hits: [], passages, total: null, reason: null, degraded: null };
      }

      const vecHits = await provider.vectorSearch({ db: ctx.db, queryEmbedding: qvec, memoryIds: indexedIds, limit: fetchN });

      if (effectiveMode === 'vector') {
        const simById = new Map(vecHits.map((h) => [h.nodeId, h.score]));
        return await buildResult(vecHits.map((h) => ({ nodeId: h.nodeId, score: h.score })), simById, null, null);
      }

      // hybrid — fuse keyword + vector by RRF (keyword already relevance-ranked by FTS).
      // The hit score is the FUSED RRF score (the value the hit was actually ranked
      // by), not the raw vector-sim / keyword-rank the pre-#497 code attached — those
      // aren't commensurable, so mixing them gave a misleading number and no sound
      // within-result-set relevance signal. The cosine similarity is still carried
      // separately on `vector.similarity` (simById below).
      const kwRanked = await runKeywordRanked();
      const fused = reciprocalRankFusionScored(
        [kwRanked.map((r) => r.nodeId), vecHits.map((h) => h.nodeId)],
        (id) => id,
      ).slice(0, fetchN);
      const simById = new Map(vecHits.map((h) => [h.nodeId, h.score]));
      return await buildResult(
        fused.map((r) => ({ nodeId: r.item, score: r.score })),
        simById,
        null,
        mergeDegraded(null),
      );
    },

    /**
     * Spec cor:api:040 — batch node read. Returns the full per-node projection
     * for MANY nodes in one round-trip (the durable server-side primitive that
     * lets `spec lint --all` stop doing one nodeById per node). Two mutually-
     * exclusive forms: an explicit `refs` set (input order) or a `memory` +
     * `locPrefix` subtree (loc order).
     *
     * cor:api:140 / conventions:ref-param-naming (#813): each entry of `refs`
     * is a PK **or** a fully-qualified node URN, resolved through the shared
     * `resolveNodeRef`. It was PK-only until #813, which made the batch not
     * actually batch for URN callers — every URN needed its own resolveUrn
     * round trip first, so `nodeBatch` only halved the N+1 it exists to
     * remove. A malformed / unqualified ref still throws
     * (`UrnNotQualifiedError`): a caller bug must stay loud rather than hide
     * in `unavailable`, which is exactly the failure mode that let the missing
     * URN capability go unnoticed.
     *
     * Authorization is per-node and identical to the single-node read.
     * `resolveNodeRef` is a pure lookup — it does NOT gate — so the
     * memoryAccessFilter still scopes the fetch to readable memories AFTER
     * resolution (#554: widening an arg to accept a URN must not broaden the
     * reachable set). A denied OR missing ref simply isn't in the result and
     * lands in `unavailable` — indistinguishable, never failing the call
     * (cor:api:040:03, BOLA). `unavailable` / `omitted` echo the caller's own
     * ref strings, so a URN caller gets back something actionable rather than
     * a PK it never sent. Hard caps (cor:api:040:02): over the node-count cap
     * throws; over the response-size cap returns a partial result flagged
     * `truncated` — never a silent short read. No UsageEvent is recorded,
     * matching the single-node GraphQL reads (nodeById / node), which don't
     * either — per-surface parity.
     */
    nodeBatch: async (
      _: unknown,
      { refs, memory, locPrefix }: { refs?: string[]; memory?: string; locPrefix?: string },
      ctx: Context,
    ) => {
      const hasSet = Array.isArray(refs) && refs.length > 0;
      const hasPrefix = memory != null && locPrefix != null;
      if (hasSet === hasPrefix) {
        throw new GraphQLError(
          'nodeBatch: provide EITHER `refs` (an explicit set) OR `memory` + `locPrefix` (a subtree) — not both, not neither.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }

      const access = await memoryAccessFilter(ctx);
      const include = {
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      };

      let ordered: Array<{
        id: string;
        content: string | null;
        abstract: string | null;
        data?: unknown;
        properties?: unknown;
      }> = [];
      const unavailable: string[] = [];
      // Explicit-set form only: resolved node id -> the caller's ref string, so
      // `unavailable` / `omitted` report back what the caller actually sent.
      // Null for the prefix form, where there are no caller refs (ids there).
      let refByNodeId: Map<string, string> | null = null;

      if (hasSet) {
        // Count cap (cor:api:040:02) — caller knows the count; fail loud up front.
        if (refs!.length > BATCH_READ_MAX_NODES) {
          throw new GraphQLError(
            `nodeBatch: ${refs!.length} refs exceeds the ${BATCH_READ_MAX_NODES}-node cap. Split into smaller batches; the batch read does not silently truncate.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        // Dedup the raw input first (a repeated ref costs nothing to resolve
        // twice), then again on the RESOLVED id below — a PK and that node's
        // URN are different strings naming one node, and the single nodeById
        // can't duplicate, so neither should the batch.
        const uniqueRefs = [...new Set(refs!)];
        // Resolve every ref concurrently. A ref that names no live node
        // (NodeNotFoundError) is reported in `unavailable` exactly like a
        // denied one — one bad ref never fails the batch. A malformed /
        // unqualified ref propagates (UrnNotQualifiedError).
        //
        // A PK-shaped ref IS its own id, so it skips the lookup entirely: the
        // findMany below already filters `deletedAt` + access, which is where a
        // missing PK became `unavailable` before this surface took URNs at all.
        // That keeps the heavy PK callers (`spec lint --all`, `memory export` —
        // 200 ids straight off a findNodes page) at exactly one query, and
        // makes the added round trips proportional to the URNs actually passed.
        const resolved = await Promise.all(
          uniqueRefs.map(async (ref) => {
            if (isId(ref)) return { ref, id: ref as string | null };
            // A WRONG-TYPE URN (`hrn:mem:…`, `hrn:app:…`) is a coercion bug,
            // not a miss — but resolveNodeRef reports it with the SAME
            // NodeNotFoundError a genuinely absent node raises, so letting it
            // reach the catch below would file a caller's type error under
            // `unavailable`: the exact silence this surface just removed.
            // Screen it here with the shared parser, matching what the
            // single-node node(ref:) read does (PR #815 review, Codex P2).
            const typeErr = validateUrnType(parseUrnInput(ref), 'node');
            if (typeErr) {
              throw new GraphQLError(`nodeBatch: ${typeErr} (ref "${ref}")`, {
                extensions: { code: 'BAD_USER_INPUT' },
              });
            }
            try {
              const { id } = await resolveNodeRef(ctx.db, ref);
              return { ref, id: id as string | null };
            } catch (e) {
              if (e instanceof NodeNotFoundError) return { ref, id: null };
              throw e;
            }
          }),
        );
        refByNodeId = new Map();
        for (const { ref, id } of resolved) {
          if (id === null) {
            unavailable.push(ref);
            continue;
          }
          // First occurrence wins — its ref is the one echoed back and its
          // position sets the input order.
          if (!refByNodeId.has(id)) refByNodeId.set(id, ref);
        }
        // The access filter scopes to readable memories, so a denied node is
        // simply absent from the result — reported indistinguishably from a
        // ref that never resolved.
        const rows = await ctx.db.node.findMany({
          where: { id: { in: [...refByNodeId.keys()] }, deletedAt: null, ...access },
          include,
        });
        await decryptNodesBatch(ctx.db, rows);
        const byId = new Map(rows.map((n) => [n.id, n]));
        for (const [id, ref] of refByNodeId) {
          const n = byId.get(id);
          if (n) ordered.push(n);
          else unavailable.push(ref);
        }
      } else {
        const { id: memId } = await resolveMemoryRef(ctx.db, memory!);
        const accessible = await getAccessibleMemoryIds(ctx);
        if (accessible !== null && !accessible.includes(memId)) {
          throw new GraphQLError('Memory not accessible.', { extensions: { code: 'FORBIDDEN' } });
        }
        // Count cap: take MAX+1 to detect overflow, then fail loud rather than
        // silently returning a truncated subtree.
        const rows = await ctx.db.node.findMany({
          where: { memoryId: memId, loc: { startsWith: locPrefix! }, deletedAt: null },
          orderBy: { loc: 'asc' },
          take: BATCH_READ_MAX_NODES + 1,
          include,
        });
        if (rows.length > BATCH_READ_MAX_NODES) {
          throw new GraphQLError(
            `nodeBatch: prefix "${locPrefix}" matches more than the ${BATCH_READ_MAX_NODES}-node cap. Narrow the prefix; the batch read does not silently truncate.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        await decryptNodesBatch(ctx.db, rows);
        ordered = rows;
      }

      // Response-size cap (cor:api:040:02) — pack until the byte ceiling, then
      // stop and flag `truncated` with the omitted nodes. At least one node
      // always returns (a single oversize node still comes back). Size is
      // measured on the decrypted content + abstract; the client selects the
      // rest. Dropped entries are reported as the caller's own ref (explicit-set
      // form) so they can be re-requested verbatim; the prefix form has no
      // caller refs, so it reports ids.
      const nodes: unknown[] = [];
      const omitted: string[] = [];
      const echo = (id: string) => refByNodeId?.get(id) ?? id;
      let bytes = 0;
      let truncated = false;
      for (const n of ordered) {
        if (truncated) {
          omitted.push(echo(n.id));
          continue;
        }
        // Approximate the serialized payload from the heavy scalar fields a
        // client is likely to select — content + abstract + the JSON columns.
        // Edges are relational + client-selected, so they aren't measured here.
        const size = Buffer.byteLength(
          (n.content ?? '') +
            (n.abstract ?? '') +
            (n.data != null ? JSON.stringify(n.data) : '') +
            (n.properties != null ? JSON.stringify(n.properties) : ''),
          'utf8',
        );
        if (nodes.length > 0 && bytes + size > BATCH_READ_MAX_BYTES) {
          truncated = true;
          omitted.push(echo(n.id));
          continue;
        }
        nodes.push(n);
        bytes += size;
      }

      return { nodes, unavailable, truncated, omitted };
    },

    nodeUsage: async (_: unknown, { loc, limit }: { loc: string; limit?: number }, ctx: Context) => {
      return ctx.db.usageEvent.findMany({
        where: { nodeLoc: loc },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
    },

    nodeRevisions: async (_: unknown, { nodeRef, limit }: { nodeRef: string; limit?: number }, ctx: Context) => {
      requireRole(ctx, 'READER');
      // cor:api:140 / 007-entity-id-or-urn: nodeRef may be an ID or a fully-
      // qualified node URN. A genuine miss collapses to [] (no existence
      // disclosure); a malformed / unqualified URN propagates — mirrors
      // memoryUsageSummary / resolveReadableMemoryId.
      let nodeId: string;
      try {
        ({ id: nodeId } = await resolveNodeRef(ctx.db, nodeRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError) return [];
        throw e;
      }
      // Access control (#602): this resolver previously had NO gate — any
      // authenticated caller could read any tenant's node revision history.
      const node = await ctx.db.node.findUnique({
        where: { id: nodeId },
        select: { memoryId: true },
      });
      if (!node) return [];
      // Full accessible-memory set for the principal (null = unrestricted).
      // getAccessibleMemoryIds encodes the principal + memory-class rules
      // (spec 034). We gate the node's CURRENT memory AND each snapshot's
      // memory: a node MOVED across memories keeps its stable id (moveNode),
      // so its history can hold snapshots captured while it lived in a memory
      // the caller can't read (#602 / Codex P1) — gating the current memory
      // alone would leak those.
      const accessible = await getAccessibleMemoryIds(ctx);
      const canRead = (memId: string) => accessible === null || accessible.includes(memId);
      // No read on the current memory ⇒ [] (no existence disclosure, matching
      // memoryUsageSummary).
      if (!canRead(node.memoryId)) return [];

      const revisions = await ctx.db.nodeRevision.findMany({
        where: { nodeId },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
      // Drop snapshots captured while the node lived in a memory the caller
      // can't read. Legacy rows (memoryId NULL) fall back to the node's current
      // memory, already authorized above. (Filter after take: a >limit-revision
      // node spanning inaccessible memories may under-return near the limit —
      // safe, never over-returns.)
      return revisions.filter((v) => canRead(v.memoryId ?? node.memoryId));
    },

    // #617 (Display) — a single snapshot by id, so the portal doesn't filter
    // the list client-side. Access-gated like nodeRevisions: read on the node's
    // current memory AND on the snapshot's own memory (per-snapshot gating —
    // a moved node keeps its id, so a snapshot may live in a memory the caller
    // can't read). Any miss collapses to null (no existence disclosure).
    nodeRevision: async (_: unknown, { revisionId }: { revisionId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const revision = await ctx.db.nodeRevision.findUnique({ where: { id: revisionId } });
      if (!revision) return null;
      const node = await ctx.db.node.findUnique({
        where: { id: revision.nodeId },
        select: { memoryId: true, deletedAt: true },
      });
      // A soft-deleted node drops out of every read surface: nodeRevisions
      // resolves through resolveNodeRef (excludes tombstones) → []. This by-id
      // read must match, or a retained revisionId keeps leaking a deleted node's
      // history to any reader of its memory (PR #618 review).
      if (!node || node.deletedAt) return null;
      const accessible = await getAccessibleMemoryIds(ctx);
      const canRead = (memId: string) => accessible === null || accessible.includes(memId);
      if (!canRead(node.memoryId)) return null;
      if (!canRead(revision.memoryId ?? node.memoryId)) return null;
      return revision;
    },

    appNodes: async (
      _: unknown,
      { appRef, filter, limit }: {
        appRef: string;
        filter?: {
          // Memory-scope fields — NOT supported by appNodes (the App's scope is
          // authoritative). Present only so we can reject them explicitly.
          memoryIds?: string[] | null;
          memoryClasses?: string[] | null;
          nodeType?: string | null;
          objectType?: string | null;
          tags?: string[] | null;
          isRunnable?: boolean | null;
          locPrefix?: string | null;
          createdBy?: string | null;
          updatedAfter?: string | null;
          updatedBefore?: string | null;
          includeDeleted?: boolean | null;
        } | null;
        limit?: number;
      },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: appRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appRef);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      // Org-scoped auth: anyone with org membership at READER+ on the App's
      // org may read its accessible nodes; platform ADMIN/OWNER bypasses.
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        await requireOwnerOrOrgRole(ctx, app, 'READER');
      }
      // 023-app-shape Phase 2b: App↔Agent is N:M via AppAgent. Gather
      // memoryItems for every installed Agent. Apps with no installed
      // Agents have no accessible nodes.
      const appWithAgents = await ctx.db.app.findUnique({
        where: { id: resolvedAppId },
        select: {
          appAgents: {
            select: { agent: { select: { systemMemoryId: true, memoryItems: true } } },
          },
        },
      });
      const memoryIds = [
        ...new Set(
          (appWithAgents?.appAgents ?? []).flatMap((aa) => [
            // #524 — the installed agent's system memory is universally
            // read-only from an App context (schema Agent.systemMemoryId;
            // folded as READ_ONLY by mcp/access-control.ts). Task nodes are
            // commonly authored there, so appNodes must include it — matching
            // the MCP access-map fold (systemMemoryId + memoryItems).
            ...(aa.agent.systemMemoryId ? [aa.agent.systemMemoryId] : []),
            ...aa.agent.memoryItems.map((m) => m.memoryId),
          ]),
        ),
      ];
      if (memoryIds.length === 0) return [];

      // #525 — optional node-level NodeFilter, pushed server-side so callers
      // (e.g. an App's runnable-task picker) can request `{ isRunnable: true }`
      // without fetching everything and filtering client-side. The App's memory
      // scope stays authoritative, and unlike findNodes we do NOT impose the
      // default `nodeType != 'system'` exclusion — appNodes deliberately
      // surfaces the system memory (#524).
      const f = filter ?? {};
      const badInput = (msg: string) =>
        new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      // #526 review — NodeFilter carries memory-scope fields that appNodes can't
      // honor (its scope is the App's memories). Reject rather than silently
      // ignore them, so a caller who assumed they scoped fails fast instead of
      // getting a surprising superset. Use findNodes for cross-memory scoping.
      if (f.memoryIds?.length || f.memoryClasses?.length) {
        throw badInput(
          'appNodes: filter.memoryIds / filter.memoryClasses are not supported — ' +
            "the App's installed-agent memories are the authoritative scope. " +
            'Use findNodes for cross-memory scoping.',
        );
      }
      if (f.updatedAfter && Number.isNaN(Date.parse(f.updatedAfter))) {
        throw badInput('appNodes filter.updatedAfter must be a valid date string.');
      }
      if (f.updatedBefore && Number.isNaN(Date.parse(f.updatedBefore))) {
        throw badInput('appNodes filter.updatedBefore must be a valid date string.');
      }

      const results = await ctx.db.node.findMany({
        where: {
          memoryId: { in: memoryIds },
          ...(f.includeDeleted ? {} : { deletedAt: null }),
          ...(f.nodeType ? { nodeType: f.nodeType } : {}),
          ...(f.objectType ? { objectType: f.objectType } : {}),
          ...(f.isRunnable != null ? { isRunnable: f.isRunnable } : {}),
          ...(f.tags?.length ? tagsFilter(f.tags) : {}),
          ...(f.locPrefix ? { loc: { startsWith: f.locPrefix } } : {}),
          ...(f.createdBy ? { createdBy: f.createdBy } : {}),
          ...((f.updatedAfter || f.updatedBefore)
            ? { updatedAt: {
                ...(f.updatedAfter ? { gte: new Date(f.updatedAfter) } : {}),
                ...(f.updatedBefore ? { lte: new Date(f.updatedBefore) } : {}),
              } }
            : {}),
        },
        orderBy: { loc: 'asc' },
        take: limit ?? 500,
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
          memory: { select: { id: true, urn: true, name: true, organizationId: true } },
        },
      });
      await decryptNodesBatch(ctx.db, results);
      return results;
    },

};

