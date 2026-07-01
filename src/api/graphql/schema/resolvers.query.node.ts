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
import { reciprocalRankFusion } from '../../../lib/rrf.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { BooleanQueryError } from '../../../lib/retrieval/tsquery.js';
import type { LexicalField } from '../../../lib/retrieval/provider.js';
import { expandWithNeighbors } from '../../../lib/search.js';
import { decryptNodesBatch } from '../../../lib/nodeCrypto.js';
import {
  parseUrnInput,
  validateUrnType,
} from '../../../lib/urn.js';
import { compileTemplate } from '../../../lib/template.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
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
  requireOrgRole,
  getAccessibleMemoryIds,
  memoryAccessFilter,
} from './resolvers.helpers.js';

export const nodeQueries = {
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

      const { type } = parseUrnInput(urn);
      switch (type) {
        case 'memory': {
          let id: string;
          try {
            ({ id } = await resolveMemoryRef(ctx.db, urn));
          } catch {
            return null;
          }
          const memory = await ctx.db.memory.findUnique({
            where: { id },
            select: { organizationId: true },
          });
          if (!memory) return null;
          if (!(await isOrgMember(memory.organizationId))) return null;
          return { kind: 'memory', id };
        }
        case 'node': {
          let id: string;
          try {
            ({ id } = await resolveNodeRef(ctx.db, urn));
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
          return { kind: 'node', id, memoryId: node.memoryId };
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
            select: { organizationId: true },
          });
          if (!agent) return null;
          if (!(await isOrgMember(agent.organizationId))) return null;
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
            select: { organizationId: true },
          });
          if (!app) return null;
          // The dedicated app(id) query requires org ADMIN; mirror that.
          if (!isGlobalAdmin) {
            if (!ctx.userId) return null;
            const member = await ctx.db.orgMember.findUnique({
              where: { organizationId_userId: { organizationId: app.organizationId, userId: ctx.userId } },
            });
            if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER['ADMIN']) return null;
          }
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
        default:
          return null;
      }
    },

    node: async (_: unknown, { loc: rawLoc, memory: memoryRef, raw }: { loc: string; memory?: string; raw?: boolean }, ctx: Context) => {
      const parsed = parseUrnInput(rawLoc);
      const typeErr = validateUrnType(parsed, 'node');
      if (typeErr) throw new Error(typeErr);
      const loc = parsed.value;

      const access = await memoryAccessFilter(ctx);

      // #335: optional `memory` scope (ID or URN per 007-entity-id-or-urn).
      // Without it, node(loc:) resolves across EVERY readable memory; since
      // `loc` is unique only per (loc, memoryId), the same loc can live in
      // many memories, and the old code silently returned one — a false read
      // from the wrong memory. Scoping pins the lookup; the access filter is
      // still intersected so `memory` can never widen visibility.
      let where: Record<string, unknown>;
      if (memoryRef != null && memoryRef !== '') {
        const { id: scopedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
        if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
          if (!(access.memoryId.in as string[]).includes(scopedMemoryId)) return null;
        }
        where = { loc, memoryId: scopedMemoryId };
      } else {
        where = { loc, ...access };
      }
      // #391: exclude soft-deleted nodes so node(loc:) matches resolveUrn — a
      // leaked deleted row is what makes a node list/open but 404 by URN.
      where.deletedAt = null;

      const candidates = await ctx.db.node.findMany({
        where,
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      if (candidates.length === 0) return null;

      // #335: fail loud on a cross-memory loc collision instead of silently
      // picking one. The (loc, memoryId) unique guarantees >1 candidate ⇒
      // distinct memories, so this only fires for a genuinely ambiguous
      // unscoped read. Callers disambiguate with `memory:` (above) or
      // nodeById(id:) for a single-node read.
      if (candidates.length > 1) {
        const memoryIds = candidates.map((n) => n.memoryId);
        throw new GraphQLError(
          `loc "${loc}" matches ${candidates.length} readable memories ` +
            `(${memoryIds.join(', ')}). Pass \`memory:\` to scope the lookup, ` +
            `or use nodeById(id:) for an unambiguous single-node read.`,
          { extensions: { code: 'AMBIGUOUS_NODE_LOC', loc, memoryIds } },
        );
      }

      // Decrypt any nodes that come from encrypted memories (in place).
      await decryptNodesBatch(ctx.db, candidates);
      const node = candidates[0];

      // Compile Mustache templates unless raw: true
      if (!raw && node.content?.includes('{{')) {
        const compiled = await compileTemplate(
          node.content, node.data as Record<string, unknown> | null, node.memoryId, ctx.db, access,
        );
        return { ...node, content: compiled };
      }
      return node;
    },

    nodeById: async (_: unknown, { id, raw }: { id: string; raw?: boolean }, ctx: Context) => {
      const access = await memoryAccessFilter(ctx);
      const node = await ctx.db.node.findUnique({
        where: { id },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      // #391: a soft-deleted node must not resolve by PK either (findUnique
      // can't carry deletedAt in its where, so guard post-fetch) — matches
      // resolveUrn and keeps the by-PK page from opening a deleted node.
      if (!node || node.deletedAt) return null;
      if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
        if (!(access.memoryId.in as string[]).includes(node.memoryId)) return null;
      }
      await decryptNodesBatch(ctx.db, [node]);

      if (!raw && node.content?.includes('{{')) {
        const compiled = await compileTemplate(
          node.content, node.data as Record<string, unknown> | null, node.memoryId, ctx.db, access,
        );
        return { ...node, content: compiled };
      }
      return node;
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
        query, mode, filter, fields, sort, expand, granularity, limit, offset,
      }: {
        query?: string | null;
        mode?: 'keyword' | 'vector' | 'hybrid' | 'regex' | null;
        filter?: {
          memoryIds?: string[] | null;
          memoryClasses?: string[] | null;
          nodeType?: string | null;
          tags?: string[] | null;
          isRunnable?: boolean | null;
          locPrefix?: string | null;
          createdBy?: string | null;
          updatedAfter?: string | null;
          updatedBefore?: string | null;
          includeDeleted?: boolean | null;
        } | null;
        fields?: string[] | null;
        sort?: 'relevance' | 'loc' | 'seq' | 'updatedAt' | null;
        expand?: number | null;
        granularity?: 'node' | 'chunk' | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const f = filter ?? {};
      const finalLimit = limit ?? 50;
      const off = offset ?? 0;
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

      // ── Resolve scope: accessible ∩ requested memories (ID/URN mix) ──
      const accessible = await getAccessibleMemoryIds(ctx);
      const explicitIds = !!(f.memoryIds && f.memoryIds.length > 0);
      const memClassClause: unknown =
        f.memoryClasses && f.memoryClasses.length > 0
          ? { in: f.memoryClasses }
          : (!explicitIds ? { not: 'system' } : undefined); // broad search hides system-class; explicit ids win

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
        if (memClassClause && scopeIds.length > 0) {
          const rows = await ctx.db.memory.findMany({
            where: { id: { in: scopeIds }, class: memClassClause as never },
            select: { id: true },
          });
          scopeIds = rows.map((m) => m.id);
        }
      } else if (accessible === null) {
        // Admin/broad — resolve scope + class filter in one query (not two).
        const rows = await ctx.db.memory.findMany({
          where: { deletedAt: null, ...(memClassClause ? { class: memClassClause as never } : {}) },
          select: { id: true },
        });
        scopeIds = rows.map((m) => m.id);
      } else {
        const rows = await ctx.db.memory.findMany({
          where: { id: { in: accessible }, ...(memClassClause ? { class: memClassClause as never } : {}) },
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

      // ── No query → filtered list (subsumes `nodes`) ──
      if (!hasQuery) {
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
        f.nodeType || f.isRunnable != null || f.tags?.length || f.locPrefix ||
        f.createdBy || f.updatedAfter || f.updatedBefore || f.includeDeleted
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
        const scoreById = new Map(ranked.map((r) => [r.nodeId, r.score]));
        const rankOrder = new Map(ranked.map((r, i) => [r.nodeId, i]));
        const rows = await ctx.db.node.findMany({
          where: { id: { in: ranked.map((r) => r.nodeId) }, ...structuredWhere },
          include: nodeInclude,
        });
        await decryptNodesBatch(ctx.db, rows);
        const ordered = rows.slice().sort((a, b) => {
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

      // Structured filters passed to the lexical SQL so keyword/regex results are
      // filtered + sorted + paged exactly (no relevance-truncate-then-filter).
      const sqlFilter = {
        nodeType: f.nodeType ?? null,
        isRunnable: f.isRunnable ?? null,
        tags: f.tags ?? null,
        locPrefix: f.locPrefix ?? null,
        createdBy: f.createdBy ?? null,
        updatedAfter: f.updatedAfter ?? null,
        updatedBefore: f.updatedBefore ?? null,
      };
      const lexSort = (sort ?? 'relevance') as 'relevance' | 'loc' | 'seq' | 'updatedAt';

      // Hydrate a ranked list the provider has ALREADY filtered/sorted/paged:
      // fetch by id (order preserved), decrypt, attach scores, append neighbours.
      const hydrateInOrder = async (
        ranked: { nodeId: string; score: number }[],
        simById: Map<string, number> | null,
        reason: string | null,
        degraded: string | null,
      ) => {
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

      // ── LEXICAL modes: keyword (FTS) / regex — filter + sort + page in SQL ──
      if (effectiveMode === 'keyword' || effectiveMode === 'regex') {
        try {
          const common = {
            db: ctx.db, memoryIds: scopeIds, fields: lexFields, filter: sqlFilter,
            includeDeleted: !!f.includeDeleted, sort: lexSort, offset: off, limit: finalLimit,
          };
          const ranked = effectiveMode === 'regex'
            ? await provider.regexSearch({ ...common, pattern: q })
            : await provider.lexicalSearch({ ...common, query: q });
          return await hydrateInOrder(ranked, null, null, null);
        } catch (e) {
          if (e instanceof BooleanQueryError) throw badInput(e.message);
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
      const runKeywordRanked = async () => {
        try {
          return await provider.lexicalSearch({ db: ctx.db, query: q, memoryIds: scopeIds, fields: lexFields, filter: sqlFilter, includeDeleted: !!f.includeDeleted, sort: 'relevance', offset: 0, limit: fetchN });
        } catch (e) {
          if (e instanceof BooleanQueryError) throw badInput(e.message);
          throw e;
        }
      };

      if (indexedIds.length === 0) {
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked(), null, null, 'no_vector_index');
        }
        return { hits: [], passages: [], total: 0, reason: 'no_vector_index', degraded: null };
      }
      if (!isEmbeddingConfigured()) {
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked(), null, null, 'embedding_unavailable');
        }
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }

      let qvec: number[] | undefined;
      try {
        [qvec] = await getEmbeddingClient().embed([q], 'query');
      } catch (err) {
        console.warn(`[findNodes] embed() failed in mode:${effectiveMode}; degrading.`, err);
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked(), null, null, 'embedding_unavailable');
        }
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }
      if (!qvec) {
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }

      // Chunk granularity (vector only) → passages, mirroring nodeSearch. Structured
      // node filters are not applied to passage results in v1 (chunk-level, not node-level).
      if (granularity === 'chunk') {
        if (effectiveMode !== 'vector') {
          throw badInput(`findNodes granularity:chunk is only supported in mode:vector (got mode:${effectiveMode}).`);
        }
        // Fetch through the offset so paging works (vectorSearchChunks has no offset).
        const chunkHits = (await provider.vectorSearchChunks({ db: ctx.db, queryEmbedding: qvec, memoryIds: indexedIds, limit: off + finalLimit }))
          .slice(off, off + finalLimit);
        const parents = await ctx.db.node.findMany({
          where: { id: { in: [...new Set(chunkHits.map((c) => c.nodeId))] }, deletedAt: null },
          include: { memory: { select: { urn: true } } },
        });
        const parentById = new Map(parents.map((p) => [p.id, p]));
        const passages = chunkHits
          .filter((c) => parentById.has(c.nodeId))
          .map((c) => {
            const p = parentById.get(c.nodeId)! as { loc: string; memory: { urn: string } };
            return {
              parentNodeId: c.nodeId,
              parentNodeUrn: `${p.memory.urn}::${p.loc}`,
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
      const kwRanked = await runKeywordRanked();
      const fusedIds = reciprocalRankFusion(
        [kwRanked.map((r) => r.nodeId), vecHits.map((h) => h.nodeId)],
        (id) => id,
      ).slice(0, fetchN);
      const simById = new Map(vecHits.map((h) => [h.nodeId, h.score]));
      const kwScore = new Map(kwRanked.map((r) => [r.nodeId, r.score]));
      return await buildResult(
        fusedIds.map((id) => ({ nodeId: id, score: simById.get(id) ?? kwScore.get(id) ?? 0 })),
        simById,
        null,
        null,
      );
    },

    subtree: async (_: unknown, { prefix: rawPrefix }: { prefix: string }, ctx: Context) => {
      const prefix = parseUrnInput(rawPrefix).value;
      const access = await memoryAccessFilter(ctx);
      const results = await ctx.db.node.findMany({
        where: { ...access, loc: { startsWith: prefix } },
        orderBy: { loc: 'asc' },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      await decryptNodesBatch(ctx.db, results);
      return results;
    },

    /**
     * Spec cor:api:040 — batch node read. Returns the full per-node projection
     * for MANY nodes in one round-trip (the durable server-side primitive that
     * lets `spec lint --all` stop doing one nodeById per node). Two mutually-
     * exclusive forms: an explicit `ids` set (input order) or a `memory` +
     * `locPrefix` subtree (loc order).
     *
     * Authorization is per-node and identical to the single-node read: the
     * memoryAccessFilter scopes the fetch to readable memories, so a denied OR
     * missing id simply isn't in the result and lands in `unavailable` —
     * indistinguishable, never failing the call (cor:api:040:03, BOLA). Hard
     * caps (cor:api:040:02): over the node-count cap throws; over the
     * response-size cap returns a partial result flagged `truncated` — never a
     * silent short read. No UsageEvent is recorded, matching the single-node
     * GraphQL reads (nodeById / node), which don't either — per-surface parity.
     */
    nodeBatch: async (
      _: unknown,
      { ids, memory, locPrefix }: { ids?: string[]; memory?: string; locPrefix?: string },
      ctx: Context,
    ) => {
      const hasSet = Array.isArray(ids) && ids.length > 0;
      const hasPrefix = memory != null && locPrefix != null;
      if (hasSet === hasPrefix) {
        throw new GraphQLError(
          'nodeBatch: provide EITHER `ids` (an explicit set) OR `memory` + `locPrefix` (a subtree) — not both, not neither.',
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

      if (hasSet) {
        // Count cap (cor:api:040:02) — caller knows the count; fail loud up front.
        if (ids!.length > BATCH_READ_MAX_NODES) {
          throw new GraphQLError(
            `nodeBatch: ${ids!.length} ids exceeds the ${BATCH_READ_MAX_NODES}-node cap. Split into smaller batches; the batch read does not silently truncate.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        // The access filter scopes to readable memories, so a denied OR missing
        // id is simply absent from the result — reported indistinguishably.
        // Dedup so a repeated id isn't returned twice (the single nodeById
        // can't duplicate); first-occurrence order preserved.
        const uniqueIds = [...new Set(ids!)];
        const rows = await ctx.db.node.findMany({
          where: { id: { in: uniqueIds }, deletedAt: null, ...access },
          include,
        });
        await decryptNodesBatch(ctx.db, rows);
        const byId = new Map(rows.map((n) => [n.id, n]));
        for (const id of uniqueIds) {
          const n = byId.get(id);
          if (n) ordered.push(n);
          else unavailable.push(id);
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
      // stop and flag `truncated` with the omitted ids. At least one node always
      // returns (a single oversize node still comes back). Size is measured on
      // the decrypted content + abstract; the client selects the rest.
      const nodes: unknown[] = [];
      const omitted: string[] = [];
      let bytes = 0;
      let truncated = false;
      for (const n of ordered) {
        if (truncated) {
          omitted.push(n.id);
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
          omitted.push(n.id);
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

    nodeVersions: async (_: unknown, { nodeId, limit }: { nodeId: string; limit?: number }, ctx: Context) => {
      return ctx.db.nodeVersion.findMany({
        where: { nodeId },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
    },

    appNodes: async (
      _: unknown,
      { appId, limit }: { appId: string; limit?: number },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: appId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      // Org-scoped auth: anyone with org membership at READER+ on the App's
      // org may read its accessible nodes; platform ADMIN/OWNER bypasses.
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        await requireOrgRole(ctx, app.organizationId, 'READER');
      }
      // 023-app-shape Phase 2b: App↔Agent is N:M via AppAgent. Gather
      // memoryItems for every installed Agent. Apps with no installed
      // Agents have no accessible nodes.
      const appWithAgents = await ctx.db.app.findUnique({
        where: { id: resolvedAppId },
        select: {
          appAgents: {
            select: { agent: { select: { memoryItems: true } } },
          },
        },
      });
      const memoryIds = [
        ...new Set(
          (appWithAgents?.appAgents ?? []).flatMap((aa) =>
            aa.agent.memoryItems.map((m) => m.memoryId),
          ),
        ),
      ];
      if (memoryIds.length === 0) return [];

      const results = await ctx.db.node.findMany({
        where: { memoryId: { in: memoryIds }, deletedAt: null },
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

