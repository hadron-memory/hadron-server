import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateId } from '../lib/id.js';
import {
  parseUrnInput,
  formatUrn,
  assertFullyQualifiedUrn,
  splitNodeUrn,
  normalizeUrnForLookup,
  UrnNotQualifiedError,
} from '../lib/urn.js';
import { validateParentRel, InvalidParentRelError } from '../lib/parentRel.js';
import { validateLoc } from '../lib/validateLoc.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { resolveAuthContext, type AuthContext } from '../middleware/auth.js';
import { resolveUserApps } from '../auth/user-app-resolution.js';
import {
  canReadMemory,
  canWriteToMemory,
  getAccessibleMemoryIds,
  getMemoryAccess,
} from './access-control.js';
import { writeNodeToGit } from '../integrations/github/writeNodeToGit.js';
import { resolveNodeRef } from '../lib/entityRef/nodeRef.js';
import { NodeNotFoundError } from '../lib/entityRef/errors.js';
import { isId } from '../lib/entityRef/shape.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { SessionType } from '../generated/prisma/index.js';
import type { InputJsonValue } from '../generated/prisma/runtime/library.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** A single resolved edge ready to be written to the database. */
export type ResolvedEdge = { targetNodeId: string; label: string };

/**
 * Resolve every edge `targetId` through `resolveNodeRef` (spec 007)
 * so all four supported reference shapes — bare ID, full `urn:node:`
 * URN, memory-prefixed loc, and short loc within `sourceMemoryId` —
 * work uniformly.
 *
 * Pure read; writes nothing. Returns the resolved edges on success,
 * or `{ error: <user-facing string> }` when any ref doesn't resolve.
 * Callers run this BEFORE mutating the source node, so an unresolvable
 * target aborts the mutation cleanly without committing the source
 * upsert/update.
 *
 * Issue #107: prior inline logic in h-add-node / h-update-node used a
 * `targetId.includes(':')` heuristic plus `findFirst({loc})` (no
 * memory scope), which silently no-op'd memory-prefixed/URN forms and
 * FK-errored on single-segment short locs.
 */
export async function resolveEdgeRefs(
  edges: Array<{ targetId: string; label: string }>,
  sourceMemoryId: string,
): Promise<{ resolved: ResolvedEdge[] } | { error: string }> {
  const resolved: ResolvedEdge[] = [];
  for (const edge of edges) {
    try {
      const { id: targetNodeId } = await resolveNodeRef(db, edge.targetId, sourceMemoryId);
      resolved.push({ targetNodeId, label: edge.label });
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        return { error: `Edge target not found: "${err.ref}"` };
      }
      throw err;
    }
  }
  return { resolved };
}

/**
 * Replace the outgoing edges of `sourceNodeId` with `resolved`, in a
 * single `$transaction` so we never observe a state where the
 * existing edges are gone but the new ones are missing.
 *
 * Caller must have already validated targets via `resolveEdgeRefs` —
 * this function performs only writes. Each row gets an explicit
 * UUIDv7 from `generateId()` because the Prisma client extension at
 * `src/integrations/db/client.ts` only auto-injects IDs on `create`
 * and `upsert`, not on `createMany`.
 */
export async function replaceOutgoingEdges(args: {
  sourceNodeId: string;
  resolved: ResolvedEdge[];
  createdBy: string | null;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.edge.deleteMany({ where: { sourceId: args.sourceNodeId } });
    await tx.pendingEdge.deleteMany({ where: { sourceId: args.sourceNodeId } });
    if (args.resolved.length > 0) {
      await tx.edge.createMany({
        data: args.resolved.map((e) => ({
          id: generateId(),
          sourceId: args.sourceNodeId,
          targetId: e.targetNodeId,
          label: e.label,
          createdBy: args.createdBy,
        })),
        skipDuplicates: true,
      });
    }
  });
}

/** Build a full urn:node: URN from a loc and memoryId. Caches memory URNs. */
const memoryUrnCache = new Map<string, string>();
async function nodeUrn(loc: string, memoryId: string): Promise<string> {
  let memUrn = memoryUrnCache.get(memoryId);
  if (!memUrn) {
    const mem = await db.memory.findUnique({ where: { id: memoryId }, select: { urn: true } });
    memUrn = mem?.urn ?? memoryId;
    memoryUrnCache.set(memoryId, memUrn);
  }
  return formatUrn('node', `${memUrn}:${loc}`);
}

function matchesQuery(
  node: { name: string; loc: string; description: string | null; tags: string[] },
  query: string,
): boolean {
  const terms = query.toLowerCase().split(/\s+/);
  const haystack = [node.name, node.loc, node.description || '', ...node.tags]
    .join(' ')
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

// Loc validation moved to src/lib/validateLoc.ts so the GraphQL
// upsertNode resolver and the MCP tool surface share the same rule
// and produce the same typed InvalidLocError.

/**
 * If the user passes a full URN (e.g. "hadronmemory.com:dev:architecture"),
 * try to strip the memory URN prefix and return just the loc.
 * Also returns the matched memoryId for scoping.
 */
async function resolveLocFromUrn(
  rawInput: string,
  accessibleMemoryIds: string[] | null,
): Promise<{ loc: string; memoryId?: string }> {
  // Strip urn:node: or loc: prefix if present
  const parsed = parseUrnInput(rawInput);
  const input = parsed.value;

  // First, try as-is — it might already be a valid loc
  const directWhere: Record<string, unknown> = { loc: input };
  if (accessibleMemoryIds) directWhere.memoryId = { in: accessibleMemoryIds };
  const direct = await db.node.findFirst({ where: directWhere, select: { id: true } });
  if (direct) return { loc: input };

  // Try stripping known memory URN prefixes
  // Load accessible memories and check if input starts with any URN
  const memoryFilter = accessibleMemoryIds ? { id: { in: accessibleMemoryIds } } : {};
  const memories = await db.memory.findMany({ where: memoryFilter, select: { id: true, urn: true } });
  for (const mem of memories) {
    const prefix = mem.urn + ':';
    if (input.startsWith(prefix)) {
      const loc = input.slice(prefix.length);
      return { loc, memoryId: mem.id };
    }
  }

  // No match — return as-is
  return { loc: input };
}

/**
 * Look up a Memory by a user-supplied URN that may be canonical
 * (`urn:memory:foo:bar`) or bare (`foo:bar`). Memory.urn is stored bare,
 * so a prefixed input must be stripped before the DB lookup. A wrong-type
 * URN prefix (`urn:agent:`, `urn:org:`, etc.) returns null so the caller
 * can surface a clean error rather than silently coerce — see #100 #3
 * (the memory-scoped read-after-write asymmetry traced to this exact
 * normalization gap).
 *
 * Soft-deleted memories are treated as not found, matching the convention
 * in `resolveMemoryRef` and the entity-ref helpers under `src/lib/entityRef/`.
 */
async function resolveMemoryByUrn(
  rawUrn: string,
): Promise<{ id: string; urn: string } | null> {
  const parsed = parseUrnInput(rawUrn.trim());
  if (parsed.type !== 'memory' && parsed.type !== 'unknown') return null;
  if (!parsed.value) return null;
  // Spec 021 migration window: DB stores legacy `:`-form URNs on pre-
  // migrated rows. Normalize canonical `::` input to legacy form so the
  // lookup matches; see `normalizeUrnForLookup` for the rationale.
  const normalized = normalizeUrnForLookup(parsed.value);
  return await db.memory.findFirst({
    where: { urn: normalized, deletedAt: null },
    select: { id: true, urn: true },
  });
}

// Access control lives in ./access-control.ts.

// ---------------------------------------------------------------------------
// MCP Server factory — one McpServer per transport session
// ---------------------------------------------------------------------------

function createMcpServerInstance(auth: AuthContext): McpServer {
  const server = new McpServer(
    { name: 'hadron', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  // Per-session state. The field is preserved per spec 022 D4a as advisory
  // metadata — the agent inference layer (hadron-client) MAY read it as a
  // future hint signal, but no server-side code reads it. Set via
  // `h-set-active-memory`; never consumed here.
  // TODO(spec-022-cleanup): tracked as Q-2026-05-07-001 in the design
  // discussion registry; revisit if usage stays "set, never read" past pilot.
  let activeMemoryUrn: string | undefined;

  // ── h-list-memories ──────────────────────────────────────────────────────

  server.tool(
    'h-list-memories',
    'List all memories this caller has access to, with URN and access level (read-only or read-write).',
    {},
    async () => {
      if (!auth.clientId && !auth.appId) return textResult('Not authenticated.');

      const access = await getMemoryAccess(db, auth);
      if (access.size === 0) {
        return textResult('No memories accessible. Subscribe to an agent with memories first.');
      }

      const memoryIds = [...access.keys()];
      const memories = await db.memory.findMany({
        where: { id: { in: memoryIds } },
        select: { id: true, urn: true, name: true },
      });

      const lines = memories.map((m) => {
        const level = access.get(m.id) === 'READ_WRITE' ? 'read-write' : 'read-only';
        return `- **${formatUrn('memory', m.urn)}** — ${m.name} (${level})`;
      });

      return textResult(`${memories.length} accessible memories:\n\n${lines.join('\n')}`);
    },
  );

  // ── h-set-active-memory ──────────────────────────────────────────────────

  server.tool(
    'h-set-active-memory',
    'Set the active memory for this session. Subsequent tree tools will use this as the default scope.',
    {
      memoryUrn: z.string().describe('Memory URN, e.g. hadronmemory.com:dev or urn:memory:hadronmemory.com:dev'),
    },
    async ({ memoryUrn }) => {
      // #100 #3: Memory.urn is stored bare ('hadronmemory.com:dev'). Storing
      // the caller-supplied string verbatim makes every downstream
      // findFirst({urn:activeMemoryUrn}) silently miss when the caller passed
      // the canonical 'urn:memory:' form. Writes have fallback paths
      // (single-writable-memory, parent-node lookup) and so still land on
      // the right memory; reads do not. Result: writes succeed, reads see
      // an inconsistent / empty scope, which is the read-after-write
      // asymmetry reported in issue #100.
      const parsed = parseUrnInput(memoryUrn.trim());
      if (parsed.type !== 'memory' && parsed.type !== 'unknown') {
        const prefix = parsed.type === 'loc' ? 'loc:' : `urn:${parsed.type}:`;
        return textResult(
          `Expected a memory URN, got '${prefix}'. Pass 'hadronmemory.com:dev' or 'urn:memory:hadronmemory.com:dev'.`,
        );
      }

      // Resolve via the shared helper — soft-delete filtering, trimming, and
      // bare-URN normalization all live in one place so every read-side
      // scoping point behaves consistently.
      const mem = await resolveMemoryByUrn(memoryUrn);
      if (!mem) {
        return textResult(`Memory not found: '${memoryUrn}'. Use h-list-memories to see what's available.`);
      }
      if (!(await canReadMemory(db, auth, mem.id))) {
        return textResult(`Access denied: '${memoryUrn}'.`);
      }

      // Store the bare URN from the DB row (the canonical form for downstream
      // findFirst({urn:activeMemoryUrn}) lookups).
      activeMemoryUrn = mem.urn;
      return textResult(`Active memory set to: ${formatUrn('memory', mem.urn)}`);
    },
  );

  // ── h-add-parent-node ───────────────────────────────────────────────────

  server.tool(
    'h-add-parent-node',
    'Create a parent (section/category) node in the memory graph. Lightweight container for organizing nodes. The URN MUST be fully qualified (org:memory:loc).',
    {
      urn: z.string().describe('Fully-qualified node URN for the new section, e.g. "acme.com:mmdata:services" or "acme.com:mmdata:services:db-helpers"'),
      name: z.string().optional().describe('Display name (defaults to the last loc atom)'),
      description: z.string().optional().describe('What this section contains'),
      tags: z.array(z.string()).optional(),
    },
    async ({ urn: rawUrn, name: rawName, description, tags }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      const memoryId = memory.id;
      // Default name to the last loc atom (e.g. `services:db-helpers` → `db-helpers`).
      const name = rawName ?? loc.split(':').pop()!;
      const content = description ?? `Section: ${name}`;

      try {
        validateLoc(loc);
      } catch (e) {
        return textResult((e as Error).message);
      }

      if (!(await canWriteToMemory(db, auth, memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      await db.node.upsert({
        where: { loc_memoryId: { loc, memoryId } },
        create: {
          id: generateId(),
          memoryId,
          loc,
          name,
          nodeType: 'info',
          description: description ?? null,
          content,
          tags: tags ?? [],
          createdBy: auth.clientId ?? null,
        },
        update: {
          name,
          nodeType: 'info',
          description: description ?? null,
          content,
          tags: tags ?? [],
        },
      });

      const urn = await nodeUrn(loc, memoryId);
      return textResult(`Node saved: ${urn}`);
    },
  );

  // ── h-find-nodes ─────────────────────────────────────────────────────────

  server.tool(
    'h-find-nodes',
    'Search for nodes by name, tags, or description.',
    {
      query: z.string().describe('Search query'),
      parentRel: z.string().optional().describe('Scope search to this subtree'),
      memoryUrn: z.string().optional().describe('Scope search to this memory'),
      brief: z.boolean().optional().describe('Return index info only: name, description, edges'),
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async ({ query, parentRel, memoryUrn, brief, limit }) => {
      try {
        validateParentRel(parentRel);
      } catch (e) {
        if (e instanceof InvalidParentRelError) return textResult(e.message);
        throw e;
      }

      // Normalize parentRel once so validation, resolution, and scoping all
      // operate on the same string. Without this, ' review ' passes
      // validation (which trims internally) but then resolveLocFromUrn /
      // findFirst-by-loc see the whitespace-padded version and miss.
      const trimmedParentRel = parentRel?.trim();

      const memoryIds = await getAccessibleMemoryIds(db, auth);
      const where: Record<string, unknown> = {};
      if (memoryIds) where.memoryId = { in: memoryIds };

      // Scope to memory URN if provided. Spec 022 (FR-003): no fallback to
      // `activeMemoryUrn` — the caller must supply a fully-qualified memory
      // URN when scoping a search, otherwise the search runs across all
      // accessible memories (set in `where.memoryId` above). #100 #3:
      // route through resolveMemoryByUrn so a canonical 'urn:memory:' input
      // from the caller doesn't silently miss against a bare-stored
      // Memory.urn.
      if (memoryUrn) {
        try {
          assertFullyQualifiedUrn(memoryUrn, 'memory');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) return textResult(e.message);
          throw e;
        }
        const mem = await resolveMemoryByUrn(memoryUrn);
        if (!mem) {
          return textResult(
            `Memory not found or invalid: '${memoryUrn}'. Use h-list-memories to see what is available.`,
          );
        }
        where.memoryId = mem.id;
      }

      // Scope to subtree if parentRel provided
      if (trimmedParentRel) {
        const resolvedParent = await resolveLocFromUrn(trimmedParentRel, memoryIds);
        where.loc = { startsWith: resolvedParent.loc };
        if (resolvedParent.memoryId) where.memoryId = resolvedParent.memoryId;
      }

      const allNodes = await db.node.findMany({
        where,
        take: 1000,
        include: brief ? { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } } : undefined,
      });
      // Deduplicate by loc: prefer canonical (isLink=false) over link nodes
      const byLoc = new Map<string, typeof allNodes[0]>();
      for (const n of allNodes) {
        const existing = byLoc.get(n.loc);
        if (!existing || (existing.isLink && !n.isLink)) byLoc.set(n.loc, n);
      }
      const nodes = Array.from(byLoc.values());
      const matches = nodes.filter((n) => matchesQuery(n, query));
      const limited = matches.slice(0, limit ?? 50);

      if (limited.length === 0) {
        return textResult(`No nodes found matching "${query}".`);
      }

      const lines = await Promise.all(limited.map(async (n: any) => {
        const urn = await nodeUrn(n.loc, n.memoryId);
        const parts = [`- **${urn}** — ${n.name}`];
        if (n.description) parts.push(`  ${n.description}`);
        if (n.tags?.length) parts.push(`  Tags: ${n.tags.join(', ')}`);
        if (brief && n.outgoingEdges?.length) {
          const edgeStrs = await Promise.all(n.outgoingEdges.map(async (e: any) => {
            const targetUrn = await nodeUrn(e.target.loc, e.target.memoryId);
            return `→ ${targetUrn} (${e.label})`;
          }));
          parts.push(`  Edges: ${edgeStrs.join(', ')}`);
        }
        return parts.join('\n');
      }));

      return textResult(`Found ${limited.length} node(s):\n\n${lines.join('\n')}`);
    },
  );

  // ── h-read-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-read-node',
    'Read a node by its fully-qualified URN. The URN MUST be fully qualified (org:memory:loc).',
    { urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com:mmdata:architecture" or "urn:node:acme.com:mmdata:architecture"') },
    async ({ urn: rawUrn }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      if (!(await canReadMemory(db, auth, memory.id))) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }

      const node = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
        },
      });
      if (!node) {
        return textResult(`Node "${rawUrn}" not found.`);
      }

      // Record usage event (fire-and-forget)
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'read',
          nodeLoc: loc,
          nodeId: node.id,
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      const urn = await nodeUrn(node.loc, node.memoryId);
      const outgoingLines = await Promise.all(node.outgoingEdges.map(async (e) => {
        const targetUrn = await nodeUrn(e.target.loc, (e.target as any).memoryId);
        return `  - ${targetUrn} (${e.target.name}) — ${e.label}`;
      }));
      const incomingLines = await Promise.all(node.incomingEdges.map(async (e) => {
        const sourceUrn = await nodeUrn(e.source.loc, (e.source as any).memoryId);
        return `  - ${sourceUrn} (${e.source.name}) — ${e.label}`;
      }));
      const meta = [
        `**${node.name}**`,
        urn,
        node.description ? `> ${node.description}` : '',
        node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
        node.seq !== null ? `Seq: ${node.seq}` : '',
        node.properties ? `Properties: ${JSON.stringify(node.properties)}` : '',
        node.data ? `Data: ${JSON.stringify(node.data)}` : '',
        outgoingLines.length ? `Related:\n${outgoingLines.join('\n')}` : '',
        incomingLines.length ? `Referenced by:\n${incomingLines.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return textResult(meta + '\n\n---\n\n' + (node.content || ''));
    },
  );

  // ── h-read-next-node ─────────────────────────────────────────────────────

  server.tool(
    'h-read-next-node',
    'Read the next sibling node under a parent, ordered by `seq`. Returns the first child if current is omitted. The URN MUST be fully qualified (org:memory:loc).',
    {
      parent: z.string().describe('Fully-qualified parent node URN, e.g. "acme.com:mmdata:sections"'),
      current: z.string().optional().describe('Fully-qualified current child node URN (must be in the same memory as `parent`)'),
    },
    async ({ parent: rawParent, current: rawCurrent }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawParent, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(`Parent: ${e.message}`);
        throw e;
      }
      if (rawCurrent) {
        try {
          assertFullyQualifiedUrn(rawCurrent, 'node');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) return textResult(`Current: ${e.message}`);
          throw e;
        }
      }

      const { memoryUrn, loc: parentLoc } = splitNodeUrn(rawParent);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      if (!(await canReadMemory(db, auth, memory.id))) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      const prefix = parentLoc + ':';

      const allNodes = await db.node.findMany({
        where: { memoryId: memory.id, loc: { startsWith: prefix } },
        orderBy: { loc: 'asc' },
      });
      // Direct children only (no further colons after prefix)
      const children = allNodes
        .filter((n) => !n.loc.slice(prefix.length).includes(':'))
        .sort((a, b) => {
          // Sort by seq first (nodes with seq come before those without), then by loc
          if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
          if (a.seq !== null) return -1;
          if (b.seq !== null) return 1;
          return a.loc.localeCompare(b.loc);
        });

      if (children.length === 0) {
        return textResult(`No children found under "${parentLoc}".`);
      }

      let next;
      if (!rawCurrent) {
        next = children[0];
      } else {
        const { memoryUrn: currentMemoryUrn, loc: currentLoc } = splitNodeUrn(rawCurrent);
        if (currentMemoryUrn !== memoryUrn) {
          return textResult(`Current URN's memory (${currentMemoryUrn}) doesn't match parent's memory (${memoryUrn}).`);
        }
        const idx = children.findIndex((n) => n.loc === currentLoc);
        if (idx === -1) {
          return textResult(`Current node "${currentLoc}" not found among children of "${parentLoc}".`);
        }
        if (idx + 1 >= children.length) {
          return textResult(`No more nodes after "${currentLoc}".`);
        }
        next = children[idx + 1];
      }

      const node = await db.node.findUnique({
        where: { id: next.id },
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
        },
      });
      if (!node) return textResult('Node not found.');

      const urn = await nodeUrn(node.loc, node.memoryId);
      const outEdgeLines = await Promise.all(node.outgoingEdges.map(async (e) => {
        const targetUrn = await nodeUrn(e.target.loc, (e.target as any).memoryId);
        return `  - ${targetUrn} (${e.target.name}) — ${e.label}`;
      }));
      const meta = [
        `**${node.name}**`,
        urn,
        node.description ? `> ${node.description}` : '',
        node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
        node.seq !== null ? `Seq: ${node.seq}` : '',
        outEdgeLines.length ? `Related:\n${outEdgeLines.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return textResult(meta + '\n\n---\n\n' + (node.content || ''));
    },
  );

  // ── h-list-nodes ─────────────────────────────────────────────────────────

  server.tool(
    'h-list-nodes',
    'Browse the tree structure of a Hadron memory. Returns an indented tree view.',
    {
      parentRel: z.string().optional().describe('Parent node rel path; omit to list from memory root'),
      memoryUrn: z.string().optional().describe('Memory URN; uses active memory if not provided'),
      depth: z.number().optional().describe('Max depth to traverse (default: 1)'),
    },
    async ({ parentRel, memoryUrn, depth }) => {
      try {
        validateParentRel(parentRel);
      } catch (e) {
        if (e instanceof InvalidParentRelError) return textResult(e.message);
        throw e;
      }

      // Normalize parentRel once (matches the h-find-nodes pattern).
      const trimmedParentRel = parentRel?.trim();

      // Spec 022 (FR-003): no fallback to `activeMemoryUrn`. Caller MUST
      // supply either `memoryUrn` or `parentRel`.
      if (!memoryUrn && !trimmedParentRel) {
        return textResult('Please provide a memoryUrn or parentRel.');
      }

      const memoryIds = await getAccessibleMemoryIds(db, auth);
      const maxDepth = depth ?? 1;

      // Resolve the parent prefix
      let prefix: string;
      let memoryId: string | undefined;
      if (trimmedParentRel) {
        const resolved = await resolveLocFromUrn(trimmedParentRel, memoryIds);
        prefix = resolved.loc;
        memoryId = resolved.memoryId;
      } else {
        prefix = '';
        // Find memory by URN. #100 #3: route through resolveMemoryByUrn so
        // a canonical 'urn:memory:' input doesn't miss against bare-stored
        // Memory.urn. Spec 022: require qualification at this boundary.
        if (memoryUrn) {
          try {
            assertFullyQualifiedUrn(memoryUrn, 'memory');
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) return textResult(e.message);
            throw e;
          }
          const mem = await resolveMemoryByUrn(memoryUrn);
          if (!mem) {
            return textResult(
              `Memory not found or invalid: '${memoryUrn}'. Use h-list-memories to see what is available.`,
            );
          }
          memoryId = mem.id;
        }
      }

      const where: Record<string, unknown> = {};
      if (prefix) where.loc = { startsWith: prefix + ':' };
      if (memoryId) where.memoryId = memoryId;
      else if (memoryIds) where.memoryId = { in: memoryIds };

      const allNodes = await db.node.findMany({ where, orderBy: { loc: 'asc' } });

      // Deduplicate
      const byLoc = new Map<string, typeof allNodes[0]>();
      for (const n of allNodes) {
        const existing = byLoc.get(n.loc);
        if (!existing || (existing.isLink && !n.isLink)) byLoc.set(n.loc, n);
      }
      const nodes = Array.from(byLoc.values());

      // Filter to requested depth
      const prefixDepth = prefix ? prefix.split(':').length : 0;
      const filtered = nodes.filter((n) => {
        const nodeDepth = n.loc.split(':').length - prefixDepth;
        return nodeDepth > 0 && nodeDepth <= maxDepth;
      });

      if (filtered.length === 0) {
        return textResult(`No child nodes found under "${prefix || memoryUrn}".`);
      }

      // Compute child counts and render tree
      const lines = await Promise.all(filtered.map(async (n) => {
        const nodeDepth = n.loc.split(':').length - prefixDepth - 1;
        const indent = '  '.repeat(nodeDepth);
        const childCount = nodes.filter((c) =>
          c.loc.startsWith(n.loc + ':') && c.loc.split(':').length === n.loc.split(':').length + 1
        ).length;
        const childInfo = childCount > 0 ? ` (${childCount} children)` : '';
        const nUrn = await nodeUrn(n.loc, n.memoryId);
        return `${indent}├── ${nUrn} — ${n.name}${childInfo}`;
      }));

      const header = `Tree: ${prefix || memoryUrn}`;
      return textResult(`${header}\n${lines.join('\n')}`);
    },
  );

  // ── h-add-node ───────────────────────────────────────────────────────────

  server.tool(
    'h-add-node',
    'Add a new node to the memory graph (creates or updates). The URN MUST be fully qualified (org:memory:loc). Requires write access to the memory.',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com:mmdata:review:sort-imports" or "urn:node:acme.com:mmdata:review:sort-imports". Both bare and prefixed forms accepted. Relative-form URNs (no memory) are rejected.'),
      name: z.string().describe('Node name'),
      nodeType: z.string().optional().describe('Node type: info, data, task, record, chat, plan, parent'),
      description: z.string().optional().describe('Short description'),
      content: z.string().optional().describe('Markdown content'),
      seq: z.number().optional().describe('Sort order among siblings (lower values first)'),
      tags: z.array(z.string()).optional().describe('Tags'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
      data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config)'),
      llmModel: z.string().optional().describe('LLM model used (e.g. claude-opus-4-6)'),
      aiAgent: z.string().optional().describe('AI agent tool used (e.g. claude-code, cursor)'),
      edges: z.array(z.object({
        targetUrn: z.string().describe('Target node fully-qualified URN'),
        label: z.string().describe('Relationship label'),
      })).optional().describe('Outgoing edges'),
    },
    async ({ urn: rawUrn, name, nodeType, description, content, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges }) => {
      // Spec 022: enforce qualification at the API boundary. Relative-form
      // URNs (e.g., `review:sort-imports` without org+memory) reject here
      // before any DB lookup runs.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      // Split into memory URN + loc and resolve the memory.
      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      const memoryId = memory.id;

      try {
        validateLoc(loc);
      } catch (e) {
        return textResult((e as Error).message);
      }

      if (!(await canWriteToMemory(db, auth, memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      // Resolve edge targets BEFORE the source upsert so an
      // unresolvable target rolls back cleanly with no source-node
      // mutation (parallel to the GraphQL upsertNode resolver from
      // #106). Issue #107 review feedback.
      //
      // Spec 022: each edge target MUST be a fully-qualified URN (or an
      // ID-shape value via spec 007 dispatch). Pre-validate so short-loc
      // targets reject at the API boundary, before resolveEdgeRefs.
      let resolvedEdges: ResolvedEdge[] | null = null;
      if (edges) {
        for (const edge of edges) {
          try {
            if (!isId(edge.targetUrn)) {
              assertFullyQualifiedUrn(edge.targetUrn, 'node');
            }
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) {
              return textResult(`Edge target: ${e.message}`);
            }
            throw e;
          }
        }
        const r = await resolveEdgeRefs(
          edges.map((e) => ({ targetId: e.targetUrn, label: e.label })),
          memoryId,
        );
        if ('error' in r) return textResult(r.error);
        resolvedEdges = r.resolved;
      }

      const existing = await db.node.findUnique({ where: { loc_memoryId: { loc, memoryId } } });

      const upserted = await db.node.upsert({
        where: { loc_memoryId: { loc, memoryId } },
        create: {
          id: existing?.id ?? generateId(),
          memoryId,
          loc,
          name,
          nodeType: nodeType ?? 'info',
          description: description ?? null,
          content: content ?? null,
          seq: seq ?? null,
          tags: tags ?? [],
          properties: properties as any ?? undefined,
          data: nodeData as any ?? undefined,
          llmModel: llmModel ?? null,
          aiAgent: aiAgent ?? null,
          createdBy: auth.clientId ?? null,
        },
        update: {
          name,
          ...(nodeType ? { nodeType } : {}),
          description: description ?? null,
          content: content ?? null,
          seq: seq ?? null,
          tags: tags ?? [],
          ...(properties !== undefined ? { properties: properties as any } : {}),
          ...(nodeData !== undefined ? { data: nodeData as any } : {}),
          ...(llmModel ? { llmModel } : {}),
          ...(aiAgent ? { aiAgent } : {}),
        } as any,
      });

      if (resolvedEdges !== null) {
        await replaceOutgoingEdges({
          sourceNodeId: upserted.id,
          resolved: resolvedEdges,
          createdBy: auth.clientId ?? null,
        });
      }

      // Resolve any PendingEdges waiting for this node (by ID or loc)
      const pendingByLoc = await db.pendingEdge.findMany({ where: { targetId: loc } });
      const pendingById = await db.pendingEdge.findMany({ where: { targetId: upserted.id } });
      for (const p of [...pendingByLoc, ...pendingById]) {
        await db.edge.upsert({
          where: { sourceId_targetId_label: { sourceId: p.sourceId, targetId: upserted.id, label: p.label ?? '' } },
          create: { id: generateId(), sourceId: p.sourceId, targetId: upserted.id, label: p.label ?? '' },
          update: {},
        });
        await db.pendingEdge.delete({ where: { id: p.id } });
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'write',
          nodeLoc: loc,
          nodeId: upserted.id,
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      // Write to git (fire-and-forget)
      const nodeForGit = await db.node.findUnique({
        where: { id: upserted.id },
        include: { outgoingEdges: { include: { target: true } } },
      });
      if (nodeForGit) {
        writeNodeToGit({
          id: nodeForGit.id,
          loc: nodeForGit.loc,
          name: nodeForGit.name,
          alias: nodeForGit.alias,
          description: nodeForGit.description,
          content: nodeForGit.content,
          tags: nodeForGit.tags as string[],
          outgoingEdges: nodeForGit.outgoingEdges ?? [],
        }, '', auth.clientId, memoryId).catch((err) => {
          console.error('[h-add-node] git write error:', err);
        });
      }

      const savedUrn = await nodeUrn(loc, memoryId);
      return textResult(`Node saved: ${savedUrn}`);
    },
  );

  // ── h-update-node ────────────────────────────────────────────────────────

  server.tool(
    'h-update-node',
    'Partially update an existing node. Only the fields you provide are changed — everything else is preserved. The URN MUST be fully qualified (org:memory:loc).',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com:mmdata:review:sort-imports"'),
      name: z.string().optional().describe('New node name'),
      nodeType: z.string().optional().describe('Node type: info, data, task, record, chat, plan, parent'),
      description: z.string().optional().describe('New short description'),
      content: z.string().optional().describe('New markdown content'),
      seq: z.number().optional().describe('New sort order among siblings'),
      tags: z.array(z.string()).optional().describe('Replace tags'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
      data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config)'),
      llmModel: z.string().optional().describe('LLM model used'),
      aiAgent: z.string().optional().describe('AI agent tool used'),
      edges: z.array(z.object({
        targetUrn: z.string().describe('Target node fully-qualified URN'),
        label: z.string().describe('Relationship label'),
      })).optional().describe('Replace outgoing edges'),
      reason: z.string().optional().describe('Why this change was made (stored in version history)'),
    },
    async ({ urn: rawUrn, name, nodeType, description, content, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges, reason }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }

      const existing = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
      });
      if (!existing) {
        return textResult(`Node not found: "${rawUrn}"`);
      }

      if (!(await canWriteToMemory(db, auth, existing.memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      // Resolve edge targets BEFORE the version snapshot + node update
      // so an unresolvable target rolls back cleanly with no source-
      // node mutation. Issue #107 review feedback.
      //
      // Spec 022: pre-validate edge URN qualification (matches h-add-node).
      let resolvedEdges: ResolvedEdge[] | null = null;
      if (edges !== undefined) {
        for (const edge of edges) {
          try {
            if (!isId(edge.targetUrn)) {
              assertFullyQualifiedUrn(edge.targetUrn, 'node');
            }
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) {
              return textResult(`Edge target: ${e.message}`);
            }
            throw e;
          }
        }
        const r = await resolveEdgeRefs(
          edges.map((e) => ({ targetId: e.targetUrn, label: e.label })),
          existing.memoryId,
        );
        if ('error' in r) return textResult(r.error);
        resolvedEdges = r.resolved;
      }

      // Snapshot current state for version history
      await db.nodeVersion.create({
        data: {
          id: generateId(),
          nodeId: existing.id,
          loc: existing.loc,
          name: existing.name,
          alias: existing.alias,
          description: existing.description,
          content: existing.content,
          tags: existing.tags as string[],
          editedBy: reason ?? (auth.clientId ?? null),
          createdBy: auth.clientId ?? null,
        },
      }).catch(() => {});

      // Build partial update — only fields that were provided
      const data: Record<string, unknown> = {};
      if (name !== undefined) data.name = name;
      if (nodeType !== undefined) data.nodeType = nodeType;
      if (description !== undefined) data.description = description;
      if (content !== undefined) data.content = content;
      if (seq !== undefined) data.seq = seq;
      if (tags !== undefined) data.tags = tags;
      if (properties !== undefined) data.properties = properties as any;
      if (nodeData !== undefined) data.data = nodeData as any;
      if (llmModel !== undefined) data.llmModel = llmModel;
      if (aiAgent !== undefined) data.aiAgent = aiAgent;

      if (Object.keys(data).length > 0) {
        await db.node.update({ where: { id: existing.id }, data });
      }

      if (resolvedEdges !== null) {
        await replaceOutgoingEdges({
          sourceNodeId: existing.id,
          resolved: resolvedEdges,
          createdBy: auth.clientId ?? null,
        });
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'write',
          nodeLoc: loc,
          nodeId: existing.id,
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      // Write to git (fire-and-forget)
      const updatedNode = await db.node.findUnique({
        where: { id: existing.id },
        include: { outgoingEdges: { include: { target: true } } },
      });
      if (updatedNode) {
        writeNodeToGit({
          id: updatedNode.id,
          loc: updatedNode.loc,
          name: updatedNode.name,
          alias: updatedNode.alias,
          description: updatedNode.description,
          content: updatedNode.content,
          tags: updatedNode.tags as string[],
          outgoingEdges: updatedNode.outgoingEdges ?? [],
        }, '', auth.clientId, existing.memoryId).catch((err) => {
          console.error('[h-update-node] git write error:', err);
        });
      }

      const updatedUrn = await nodeUrn(loc, existing.memoryId);
      return textResult(`Node updated: ${updatedUrn}`);
    },
  );

  // ── h-move-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-move-node',
    'Move or rename a node, optionally across memories. The node keeps its stable ID so all edge references remain valid. Both URNs MUST be fully qualified (org:memory:loc).',
    {
      urn: z.string().describe('Current node fully-qualified URN, e.g. "acme.com:mmdata:services:db-helper"'),
      targetUrn: z.string().describe('Destination node fully-qualified URN. Different memory in the target URN performs a cross-memory move.'),
    },
    async ({ urn: rawFrom, targetUrn: rawTo }) => {
      // Spec 022: qualification at the API boundary for both source and target.
      try {
        assertFullyQualifiedUrn(rawFrom, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(`Source: ${e.message}`);
        throw e;
      }
      try {
        assertFullyQualifiedUrn(rawTo, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(`Target: ${e.message}`);
        throw e;
      }

      const { memoryUrn: fromMemoryUrn, loc: fromLoc } = splitNodeUrn(rawFrom);
      const { memoryUrn: toMemoryUrn, loc: toLoc } = splitNodeUrn(rawTo);

      const fromMemory = await resolveMemoryByUrn(fromMemoryUrn);
      if (!fromMemory) {
        return textResult(`Source memory not found: "${fromMemoryUrn}".`);
      }
      const toMemory = await resolveMemoryByUrn(toMemoryUrn);
      if (!toMemory) {
        return textResult(`Target memory not found: "${toMemoryUrn}".`);
      }

      try {
        validateLoc(toLoc);
      } catch (e) {
        return textResult((e as Error).message);
      }

      const node = await db.node.findUnique({
        where: { loc_memoryId: { loc: fromLoc, memoryId: fromMemory.id } },
      });
      if (!node) return textResult(`Node "${rawFrom}" not found.`);

      if (!(await canWriteToMemory(db, auth, fromMemory.id))) {
        return textResult('Write access denied for source memory.');
      }
      if (toMemory.id !== fromMemory.id && !(await canWriteToMemory(db, auth, toMemory.id))) {
        return textResult('Write access denied for target memory.');
      }

      const newName = toLoc.split(':').pop()!;

      await db.node.update({
        where: { loc_memoryId: { loc: fromLoc, memoryId: fromMemory.id } },
        data: { loc: toLoc, name: newName, memoryId: toMemory.id },
      });

      const fromUrn = await nodeUrn(fromLoc, fromMemory.id);
      const toUrn = await nodeUrn(toLoc, toMemory.id);
      return textResult(`Moved "${fromUrn}" → "${toUrn}"`);
    },
  );

  // ── h-run-action ─────────────────────────────────────────────────────────

  server.tool(
    'h-run-action',
    'Load an action node and resolve its dependencies. Returns the action instructions with all referenced node content. The URN MUST be fully qualified (org:memory:loc).',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com:mmdata:actions:review"'),
      args: z.record(z.string(), z.string()).optional().describe('Action arguments as key-value pairs'),
    },
    async ({ urn: rawUrn, args }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      if (!(await canReadMemory(db, auth, memory.id))) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }

      const node = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
        include: { outgoingEdges: { include: { target: true } } },
      });
      if (!node) return textResult(`Node "${rawUrn}" not found.`);

      let actionContent = node.content || '';

      // Substitute args
      if (args) {
        for (const [key, value] of Object.entries(args)) {
          actionContent = actionContent.replaceAll(`{{${key}}}`, value);
        }
      }

      // Resolve referenced node content from edges
      const topicSections: string[] = [];
      for (const edge of node.outgoingEdges) {
        const target = edge.target;
        if (target.content) {
          const targetUrn = await nodeUrn(target.loc, (target as any).memoryId);
          topicSections.push(
            `## Node: ${target.name} (${targetUrn})\n\n${target.content}`,
          );
        }
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'action-run',
          nodeLoc: loc,
          nodeId: node.id,
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
          actionArgs: (args ?? undefined) as Record<string, string> | undefined,
        },
      }).catch(() => {});

      const parts = [`# Node: ${node.name}\n\n${actionContent}`];
      if (topicSections.length > 0) {
        parts.push(
          '---\n\n# Referenced Nodes\n\n' + topicSections.join('\n\n---\n\n'),
        );
      }
      return textResult(parts.join('\n\n'));
    },
  );

  // ── h-start-session ──────────────────────────────────────────────────────

  server.tool(
    'h-start-session',
    'Start a new work session. All subsequent tool calls can reference this session ID for attribution.',
    {
      description: z.string().describe("What this session is about"),
      type: z.string().optional().describe('Session type: DEVELOPER, CHATBOT, AUTOMATION, EDGE'),
      repo: z.string().optional().describe('Repository being worked on (e.g. org/repo)'),
      branch: z.string().optional().describe('Git branch'),
      prNumber: z.number().optional().describe('Pull request number'),
      customerId: z.string().optional().describe('Customer ID for chatbot sessions'),
      language: z.string().optional().describe('Programming language'),
      llmModel: z.string().optional().describe('LLM model being used'),
      parentSessionId: z.string().optional().describe('Parent session ID'),
      prevSessionId: z.string().optional().describe('Previous session ID'),
    },
    async ({ description, type, repo, branch, prNumber, customerId, language, llmModel, parentSessionId, prevSessionId }) => {
      const sessionId = generateId();

      const session = await db.session.create({
        data: {
          id: sessionId,
          type: (type || 'DEVELOPER') as SessionType,
          plan: description,
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          repo: repo ?? null,
          branch: branch ?? null,
          prNumber: prNumber ?? null,
          customerId: customerId ?? null,
          language: language ?? null,
          llmModel: llmModel ?? null,
          parentSessionId: parentSessionId ?? null,
          prevSessionId: prevSessionId ?? null,
        },
      });

      return textResult(
        `Session started: ${session.id}\n> ${description}`,
      );
    },
  );

  // ── h-end-session ────────────────────────────────────────────────────────

  server.tool(
    'h-end-session',
    'End a session. Records summary and final metrics.',
    {
      id: z.string().describe('Session ID to end'),
      summary: z.string().optional().describe('Summary of what was accomplished'),
      inputTokens: z.number().optional().describe('Total input tokens used'),
      outputTokens: z.number().optional().describe('Total output tokens used'),
      turnCount: z.number().optional().describe('Number of conversation turns'),
      errorCount: z.number().optional().describe('Number of errors encountered'),
    },
    async ({ id, summary, inputTokens, outputTokens, turnCount, errorCount }) => {
      const session = await db.session.findUnique({ where: { id } });
      if (!session) return textResult(`Session "${id}" not found.`);

      await db.session.update({
        where: { id },
        data: {
          endedAt: new Date(),
          summary: summary ?? null,
          inputTokens: inputTokens ?? null,
          outputTokens: outputTokens ?? null,
          turnCount: turnCount ?? null,
          errorCount: errorCount ?? null,
        },
      });

      return textResult(`Session ended: ${id}`);
    },
  );

  // ── h-validate ───────────────────────────────────────────────────────────

  server.tool(
    'h-validate',
    'Check a memory for broken edge references and nodes with missing content. The memory URN MUST be fully qualified.',
    {
      memoryUrn: z.string().describe('Fully-qualified memory URN, e.g. "acme.com:mmdata"'),
    },
    async ({ memoryUrn }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(memoryUrn, 'memory');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      if (!(await canReadMemory(db, auth, memory.id))) {
        return textResult('Access denied for this memory.');
      }

      const nodes = await db.node.findMany({
        where: { memoryId: memory.id },
        include: { outgoingEdges: true },
      });
      const nodeIds = new Set(nodes.map((n) => n.id));
      const issues: string[] = [];

      for (const node of nodes) {
        const nUrn = await nodeUrn(node.loc, node.memoryId);
        for (const edge of node.outgoingEdges) {
          if (!nodeIds.has(edge.targetId)) {
            issues.push(`[broken-ref] ${nUrn} → id:${edge.targetId} (${edge.label})`);
          }
        }
        if (!node.description && !node.content) {
          issues.push(`[sparse] ${nUrn} — no description and no content`);
        }
      }

      if (issues.length === 0) {
        return textResult(`Validated ${nodes.length} nodes. No issues found.`);
      }
      return textResult(
        `Found ${issues.length} issue(s) in ${nodes.length} nodes:\n\n${issues.join('\n')}`,
      );
    },
  );

  // ── h-sync-graph ─────────────────────────────────────────────────────────

  server.tool(
    'h-sync-graph',
    'Trigger an on-demand sync for a memory from its GitHub source. The memory URN MUST be fully qualified.',
    {
      memoryUrn: z.string().describe('Fully-qualified memory URN, e.g. "acme.com:mmdata"'),
    },
    async ({ memoryUrn }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(memoryUrn, 'memory');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const memoryRef = await resolveMemoryByUrn(memoryUrn);
      if (!memoryRef) return textResult(`Memory not found: "${memoryUrn}".`);
      if (!(await canWriteToMemory(db, auth, memoryRef.id))) {
        return textResult('Access denied.');
      }

      const memory = await db.memory.findUnique({
        where: { id: memoryRef.id },
        include: { organization: true },
      });
      if (!memory) return textResult('Memory not found.');
      if (!memory.source) return textResult('Memory has no source repository configured.');

      // Import and call syncGraphFromGithub
      const { syncGraphFromGithub } = await import('../integrations/github/syncGraphFromGithub.js');
      const result = await syncGraphFromGithub(memory as Parameters<typeof syncGraphFromGithub>[0]);

      if (result.error) return textResult(`Sync failed: ${result.error}`);
      return textResult(`Synced ${result.nodeCount ?? 0} nodes.`);
    },
  );

  // ── Chat tools ───────────────────────────────────────────────────────────
  // These call the GraphQL mutation resolvers directly with a constructed
  // Context. The MCP App-key auth maps to ctx.appId; the userId param
  // identifies the persona being tested.

  function gqlCtx(userIdOverride?: string): Context {
    return {
      db,
      clientId: auth.clientId ?? undefined,
      userId: userIdOverride ?? auth.userId ?? undefined,
      roles: auth.roles as Context['roles'],
      organizationId: auth.organizationId ?? undefined,
    };
  }

  // ── h-chat-start ─────────────────────────────────────────────────────

  server.tool(
    'h-chat-start',
    'Start a new chat session with an agent. Returns the chat ID, compiled system prompt, tool schema, conversation name, and first stage. The LLM should use the system prompt and tools to generate a welcome message, then call h-chat-process with the result.',
    {
      agentId: z.string().describe('ID of the agent to chat with'),
      userId: z.string().optional().describe('User/persona identifier (e.g. "alex-chen"). Used to scope the per-user memory. If omitted, uses the authenticated user.'),
      conversationName: z.string().optional().describe('Specific conversation to start (e.g. "onboarding"). If omitted, picks the first non-setup conversation.'),
    },
    async ({ agentId, userId, conversationName }) => {
      try {
        const ctx = gqlCtx(userId);
        const result = await resolvers.Mutation.startChat(
          null,
          { agentId, userId, conversationName },
          ctx,
        );
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'startChat failed'}`);
      }
    },
  );

  // ── h-chat-send ──────────────────────────────────────────────────────

  server.tool(
    'h-chat-send',
    "Send a user message in an existing chat. Returns the recompiled system prompt for the current stage, tool schema, message history, and whether summarization is needed. Use the returned prompt + tools to generate the assistant's response, then call h-chat-process.",
    {
      chatId: z.string().describe('Chat ID returned by h-chat-start (e.g. "chats:20260417-abc12345-onboarding")'),
      userMessage: z.string().describe("The user's message text"),
    },
    async ({ chatId, userMessage }) => {
      try {
        const ctx = gqlCtx();
        const result = await resolvers.Mutation.sendChatMessage(
          null,
          { chatId, userMessage },
          ctx,
        );
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'sendChatMessage failed'}`);
      }
    },
  );

  // ── h-chat-process ───────────────────────────────────────────────────

  server.tool(
    'h-chat-process',
    "Process the LLM's structured response for a chat turn. The toolResponse must match the respond() tool schema: { message, data, next_stage }. Hadron saves the assistant message, extracts data into user memory, and handles stage transitions. Returns the display message, whether a stage transition occurred, and the new stage name.",
    {
      chatId: z.string().describe('Chat ID'),
      message: z.string().describe("The assistant's response message to display to the user"),
      data: z.record(z.string(), z.unknown()).optional().describe('Extracted data fields matching the stage extractionSpec (e.g. { "memory.name": "Alex Chen" })'),
      next_stage: z.string().nullable().optional().describe('Stage to transition to (null or omitted to stay in current stage)'),
    },
    async ({ chatId, message, data, next_stage }) => {
      try {
        const ctx = gqlCtx();
        const toolResponse = {
          message,
          ...(data !== undefined ? { data } : {}),
          ...(next_stage !== undefined ? { next_stage } : {}),
        };
        const result = await resolvers.Mutation.processChatResponse(
          null,
          { chatId, toolResponse },
          ctx,
        );
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'processChatResponse failed'}`);
      }
    },
  );

  // ── h-chat-get-routing-map ───────────────────────────────────────────

  server.tool(
    'h-chat-get-routing-map',
    "Download the full routing map for an agent: topics, conversations (with goals/signals), stages, and edges. Use this to understand the chatbot's conversation structure before routing.",
    {
      agentId: z.string().describe('ID of the agent'),
    },
    async ({ agentId }) => {
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        // Load all conversation-related nodes from the system memory
        const nodes = await db.node.findMany({
          where: { memoryId: sysMemId, deletedAt: null },
          select: { id: true, loc: true, name: true, description: true, data: true, nodeType: true },
          orderBy: { loc: 'asc' },
        });

        const topics = nodes
          .filter((n) => n.loc.startsWith('topics:') && n.loc.split(':').length === 2)
          .map((n) => ({ loc: n.loc, name: n.name, data: n.data }));

        const conversations = nodes
          .filter((n) => n.loc.startsWith('conversations:') && n.loc.split(':').length === 2)
          .map((n) => ({ loc: n.loc, name: n.name, description: n.description, data: n.data }));

        const stages = nodes
          .filter((n) => n.loc.startsWith('conversations:') && n.loc.split(':').length === 3)
          .map((n) => ({ loc: n.loc, name: n.name, description: n.description, data: n.data }));

        // Load edges between these nodes
        const nodeIds = nodes.map((n) => n.id);
        const edges = await db.edge.findMany({
          where: { sourceId: { in: nodeIds }, deletedAt: null },
          include: { source: { select: { loc: true } }, target: { select: { loc: true } } },
        });

        const edgeList = edges.map((e) => ({
          id: e.id,
          sourceLoc: e.source.loc,
          targetLoc: e.target.loc,
          label: e.label,
          data: e.data,
        }));

        // Include training entries if they exist
        const trainingNode = nodes.find((n) => n.loc === 'goals:training');
        const trainingEntries = trainingNode
          ? ((trainingNode.data as Record<string, unknown>)?.entries as unknown[]) ?? []
          : [];

        return textResult(JSON.stringify({ topics, conversations, stages, edges: edgeList, trainingEntries }, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to get routing map'}`);
      }
    },
  );

  // ── h-chat-get-route-history ──────────────────────────────────────────

  server.tool(
    'h-chat-get-route-history',
    'Get the route history and goal stack for a chat. Shows where the chat has been and what goals are active.',
    {
      chatId: z.string().describe('Chat ID'),
    },
    async ({ chatId }) => {
      try {
        const chatNode = await db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
        if (!chatNode) return textResult(`Chat "${chatId}" not found.`);
        const chatData = (chatNode.data as Record<string, unknown>) ?? {};
        return textResult(JSON.stringify({
          conversationName: chatData.conversationName,
          stageName: chatData.stageName,
          goalStack: chatData.goalStack ?? [],
          routeHistory: chatData.routeHistory ?? [],
        }, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to get route history'}`);
      }
    },
  );

  // ── h-chat-push-goal ──────────────────────────────────────────────────

  server.tool(
    'h-chat-push-goal',
    'Push a new goal onto the goal stack. Use this when the user mentions something they want to do later, or when a detour is needed.',
    {
      chatId: z.string().describe('Chat ID'),
      description: z.string().describe('Description of the goal'),
      createdBy: z.enum(['ASSISTANT', 'USER']).optional().describe('Who identified this goal (default: ASSISTANT)'),
    },
    async ({ chatId, description, createdBy }) => {
      try {
        const chatNode = await db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
        if (!chatNode) return textResult(`Chat "${chatId}" not found.`);
        const chatData = (chatNode.data as Record<string, unknown>) ?? {};
        const stack = (chatData.goalStack as Array<Record<string, unknown>>) ?? [];
        stack.push({
          description,
          createdBy: createdBy ?? 'ASSISTANT',
          createdAt: new Date().toISOString(),
          conversationUrn: chatData.conversationName ? `conversations:${chatData.conversationName}` : undefined,
          nodeUrn: chatData.stageName && chatData.conversationName
            ? `conversations:${chatData.conversationName}:${chatData.stageName}`
            : undefined,
          status: 'ACTIVE',
        });
        chatData.goalStack = stack;
        await db.node.update({
          where: { id: chatNode.id },
          data: { data: chatData as InputJsonValue },
        });
        return textResult(`Goal pushed: "${description}". Stack depth: ${stack.filter((g: any) => g.status === 'ACTIVE').length}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to push goal'}`);
      }
    },
  );

  // ── h-chat-pop-goal ───────────────────────────────────────────────────

  server.tool(
    'h-chat-pop-goal',
    'Complete the current goal and return to the previous one. Use this when a detour conversation has finished its purpose.',
    {
      chatId: z.string().describe('Chat ID'),
    },
    async ({ chatId }) => {
      try {
        const chatNode = await db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
        if (!chatNode) return textResult(`Chat "${chatId}" not found.`);
        const chatData = (chatNode.data as Record<string, unknown>) ?? {};
        const stack = (chatData.goalStack as Array<Record<string, unknown>>) ?? [];

        // Find and complete the topmost ACTIVE goal
        let completed: Record<string, unknown> | null = null;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].status === 'ACTIVE') {
            stack[i].status = 'COMPLETED';
            stack[i].completedAt = new Date().toISOString();
            completed = stack[i];
            break;
          }
        }

        chatData.goalStack = stack;
        await db.node.update({
          where: { id: chatNode.id },
          data: { data: chatData as InputJsonValue },
        });

        if (completed) {
          const remaining = stack.filter((g: any) => g.status === 'ACTIVE').length;
          return textResult(`Goal completed: "${completed.description}". ${remaining} active goal(s) remaining.`);
        }
        return textResult('No active goals to complete.');
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to pop goal'}`);
      }
    },
  );

  // ── h-chat-add-training-entry ───────────────────────────────────────

  server.tool(
    'h-chat-add-training-entry',
    'Add a user statement to the agent-wide routing training set. These entries help the routing engine match future user messages to the right conversation. Stored in the system memory (not encrypted user memory).',
    {
      agentId: z.string().describe('ID of the agent'),
      userStatement: z.string().describe('The user statement that should route here (e.g. "Is Nina back in town?")'),
      matchedConversation: z.string().describe('The conversation name this statement should route to (e.g. "class-schedule")'),
      language: z.string().optional().describe('Language code (e.g. "en", "es"). Defaults to "en".'),
    },
    async ({ agentId, userStatement, matchedConversation, language }) => {
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        // Ensure the training node exists
        const trainingLoc = 'goals:training';
        let trainingNode = await db.node.findFirst({
          where: { memoryId: sysMemId, loc: trainingLoc, deletedAt: null },
        });

        if (!trainingNode) {
          // Create parent + training node
          try {
            await db.node.upsert({
              where: { loc_memoryId: { loc: 'goals', memoryId: sysMemId } },
              create: { id: generateId(), memoryId: sysMemId, loc: 'goals', name: 'goals', nodeType: 'system' },
              update: {},
            });
          } catch { /* exists */ }
          trainingNode = await db.node.create({
            data: {
              id: generateId(), memoryId: sysMemId, loc: trainingLoc, name: 'training',
              nodeType: 'system', data: { entries: [] } as InputJsonValue,
            },
          });
        }

        const trainingData = (trainingNode.data as Record<string, unknown>) ?? {};
        const entries = (trainingData.entries as Array<Record<string, unknown>>) ?? [];

        entries.push({
          userStatement,
          matchedConversation,
          language: language ?? 'en',
          addedAt: new Date().toISOString(),
          addedBy: auth.userId ?? auth.clientId ?? 'system',
        });

        await db.node.update({
          where: { id: trainingNode.id },
          data: { data: { ...trainingData, entries } as InputJsonValue },
        });

        return textResult(`Training entry added: "${userStatement}" → ${matchedConversation}. Total entries: ${entries.length}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to add training entry'}`);
      }
    },
  );

  // ── h-chat-define-persona ───────────────────────────────────────────

  server.tool(
    'h-chat-define-persona',
    'Define a test persona for automated chatbot testing. The persona has a name, description, opening message, and optionally an expected conversation path. Stored in the system memory under test-personas:*.',
    {
      agentId: z.string().describe('ID of the agent'),
      name: z.string().describe('Persona name (e.g. "Maria Santos")'),
      description: z.string().describe('Brief description: who they are, what they want (e.g. "Freelance designer in Austin, wants to find a mentor")'),
      openingMessage: z.string().describe('The first message the persona sends to start the chat'),
      conversationName: z.string().optional().describe('Which conversation to start with (omit to let routing decide)'),
      followUpMessages: z.array(z.string()).optional().describe('Subsequent messages the persona sends, in order. If omitted, the LLM improvises based on the persona description.'),
      expectedConversations: z.array(z.string()).optional().describe('Expected conversation path for validation (e.g. ["onboarding", "strategy"])'),
    },
    async ({ agentId, name, description, openingMessage, conversationName, followUpMessages, expectedConversations }) => {
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const personaLoc = `test-personas:${slug}`;

        // Ensure parent exists
        try {
          await db.node.upsert({
            where: { loc_memoryId: { loc: 'test-personas', memoryId: sysMemId } },
            create: { id: generateId(), memoryId: sysMemId, loc: 'test-personas', name: 'test-personas', nodeType: 'system', description: 'Test personas for automated chatbot testing' },
            update: {},
          });
        } catch { /* exists */ }

        await db.node.upsert({
          where: { loc_memoryId: { loc: personaLoc, memoryId: sysMemId } },
          create: {
            id: generateId(), memoryId: sysMemId, loc: personaLoc, name: slug,
            nodeType: 'system', description: name,
            data: {
              personaName: name, description, openingMessage,
              conversationName: conversationName ?? null,
              followUpMessages: followUpMessages ?? [],
              expectedConversations: expectedConversations ?? [],
              createdAt: new Date().toISOString(),
            } as InputJsonValue,
          },
          update: {
            description: name,
            data: {
              personaName: name, description, openingMessage,
              conversationName: conversationName ?? null,
              followUpMessages: followUpMessages ?? [],
              expectedConversations: expectedConversations ?? [],
              updatedAt: new Date().toISOString(),
            } as InputJsonValue,
            deletedAt: null,
          },
        });

        return textResult(`Persona "${name}" saved at ${personaLoc}.\nOpening: "${openingMessage}"\nFollow-ups: ${(followUpMessages ?? []).length}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to define persona'}`);
      }
    },
  );

  // ── h-chat-list-personas ──────────────────────────────────────────

  server.tool(
    'h-chat-list-personas',
    'List all test personas defined for an agent.',
    {
      agentId: z.string().describe('ID of the agent'),
    },
    async ({ agentId }) => {
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        const personas = await db.node.findMany({
          where: { memoryId: sysMemId, loc: { startsWith: 'test-personas:' }, deletedAt: null },
          select: { loc: true, description: true, data: true },
          orderBy: { loc: 'asc' },
        });

        if (personas.length === 0) return textResult('No test personas defined. Use h-chat-define-persona to create one.');

        const lines = personas.map((p) => {
          const d = (p.data as Record<string, unknown>) ?? {};
          return `- ${d.personaName ?? p.description ?? p.loc}: "${d.openingMessage ?? ''}"${d.conversationName ? ` (starts: ${d.conversationName})` : ''}`;
        });
        return textResult(`${personas.length} persona(s):\n${lines.join('\n')}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to list personas'}`);
      }
    },
  );

  // ── h-chat-run-persona ────────────────────────────────────────────

  server.tool(
    'h-chat-run-persona',
    'Run a test persona through the chatbot in "dry run" mode. This starts a chat as the persona, sends their opening message, and returns the chatbot\'s compiled prompt + tool schema so the client LLM can generate the response. Call h-chat-process with the response, then call this tool again with the next follow-up message. Use this iteratively to walk through the full conversation.\n\nWorkflow:\n1. Call h-chat-run-persona to start (sets up chat, sends opening message)\n2. Read the returned prompt, generate a chatbot response as the client LLM\n3. Call h-chat-process with the response\n4. Call h-chat-run-persona again with step=1 (next follow-up)\n5. Repeat until all follow-ups are done or the conversation ends\n\nAt the end, call h-chat-get-route-history to see the full path taken.',
    {
      agentId: z.string().describe('ID of the agent'),
      personaLoc: z.string().describe('Loc of the persona (e.g. "test-personas:maria-santos")'),
      step: z.number().optional().describe('Follow-up message index (0 = opening message, 1 = first follow-up, etc.). Defaults to 0.'),
      chatId: z.string().optional().describe('Chat ID from a previous step. Omit on step 0 to start a new chat.'),
    },
    async ({ agentId, personaLoc, step, chatId }) => {
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        const personaNode = await db.node.findFirst({
          where: { memoryId: sysMemId, loc: personaLoc, deletedAt: null },
        });
        if (!personaNode) return textResult(`Persona "${personaLoc}" not found.`);
        const persona = (personaNode.data as Record<string, unknown>) ?? {};
        const followUps = (persona.followUpMessages as string[]) ?? [];
        const currentStep = step ?? 0;

        const ctx = gqlCtx(persona.personaName as string ?? 'test-persona');

        if (currentStep === 0) {
          // Start a new chat
          const startResult = await resolvers.Mutation.startChat(
            null,
            {
              agentId,
              userId: persona.personaName as string,
              conversationName: (persona.conversationName as string) ?? undefined,
            },
            ctx,
          );

          // Send the opening message
          const sendResult = await resolvers.Mutation.sendChatMessage(
            null,
            { chatId: startResult.chatId, userMessage: persona.openingMessage as string },
            ctx,
          );

          return textResult(JSON.stringify({
            chatId: startResult.chatId,
            step: 0,
            personaMessage: persona.openingMessage,
            totalFollowUps: followUps.length,
            conversationName: startResult.conversationName,
            stageName: startResult.stageName,
            systemMessage: sendResult.systemMessage,
            tools: sendResult.tools,
            messageHistory: sendResult.messageHistory,
            instruction: 'Generate a chatbot response based on the systemMessage and tools above. Then call h-chat-process with chatId, message, data, and next_stage. After that, call h-chat-run-persona with step=1 to send the next follow-up.',
          }, null, 2));
        }

        // Follow-up steps
        if (!chatId) return textResult('chatId is required for follow-up steps.');
        const followUpIdx = currentStep - 1;

        if (followUpIdx >= followUps.length) {
          // All follow-ups done — generate the test report
          const chatNode = await db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
          const chatData = (chatNode?.data as Record<string, unknown>) ?? {};
          const expected = (persona.expectedConversations as string[]) ?? [];
          const routeHistory = (chatData.routeHistory as Array<Record<string, unknown>>) ?? [];
          const visitedConvs = [...new Set(routeHistory.filter((r) => r.conversationUrn).map((r) => (r.conversationUrn as string).replace('conversations:', '')))];

          let pass = true;
          const issues: string[] = [];
          if (expected.length > 0) {
            for (const exp of expected) {
              if (!visitedConvs.includes(exp)) {
                pass = false;
                issues.push(`Expected conversation "${exp}" was not visited.`);
              }
            }
          }

          return textResult(JSON.stringify({
            chatId,
            step: currentStep,
            status: 'COMPLETE',
            pass,
            issues,
            visitedConversations: visitedConvs,
            totalTurns: (chatData.messageCount as number) ?? 0,
            routeHistory,
            goalStack: chatData.goalStack ?? [],
            instruction: 'Test complete. Review the results above.',
          }, null, 2));
        }

        const userMessage = followUps[followUpIdx];

        // Send the follow-up message
        const sendResult = await resolvers.Mutation.sendChatMessage(
          null,
          { chatId, userMessage },
          ctx,
        );

        return textResult(JSON.stringify({
          chatId,
          step: currentStep,
          personaMessage: userMessage,
          remainingFollowUps: followUps.length - followUpIdx - 1,
          systemMessage: sendResult.systemMessage,
          tools: sendResult.tools,
          messageHistory: sendResult.messageHistory,
          instruction: `Generate a chatbot response for: "${userMessage}". Then call h-chat-process, then h-chat-run-persona with step=${currentStep + 1}.`,
        }, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to run persona'}`);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport management — one transport per MCP session
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Handle MCP requests on the Express /mcp endpoint.
 * Authenticates via Bearer token, creates or reuses transport sessions.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  // Check for existing session first — skip expensive auth if already authenticated
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — authenticate. Accept JWT users (userId/clientId set by
  // resolveAuthContext) OR App Keys (appId set) OR User API Keys (userId
  // set without appId, per spec 025-oauth-for-mcp). App Keys are the
  // canonical way for hadron-client / Claude Code MCP / Cursor / etc. to
  // authenticate; user-credential MCP arrives via OAuth or portal-minted
  // hdr_user_<…> bearer tokens.
  const auth = await resolveAuthContext(req, db);
  if (!auth.appId && !auth.userId && !auth.clientId) {
    // Advertise the protected-resource metadata URL per RFC 9728 §5.1 so
    // MCP-spec-compliant clients (Claude Desktop, MCP Inspector) can
    // discover the OAuth authorization server and walk the OAuth dance.
    // Host is derived from req.protocol + req.get('host'); req.protocol
    // honors `app.set('trust proxy', …)` so the URL is HTTPS when the
    // server is reached over a TLS-terminating proxy.
    const host = req.get('host');
    if (!host) {
      // RFC 7230 §5.4 requires Host on every HTTP/1.1 request. A request
      // without one is malformed; we can't synthesize a usable
      // resource_metadata URL. Respond 400 honestly rather than emit a
      // partially-formed URL that downstream clients would 404 against.
      res.status(400).json({ error: 'Missing Host header' });
      return;
    }
    const prmUrl = `${req.protocol}://${host}/.well-known/oauth-protected-resource`;
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="hadron", error="invalid_token", resource_metadata="${prmUrl}"`,
    );
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Spec 025-oauth-for-mcp FR-020 / research §R-6 — App-identification
  // resolution at the MCP boundary for user-credential callers
  // (userId set but appId not set, i.e., JWT or hdr_user_<…> Bearer).
  // App-key callers already have appId populated by the middleware
  // and skip this block.
  //
  // Single-App default regime only — directory-aware and session-
  // scoped regimes are carved out to sibling spec
  // `02X-app-identification-regimes`. The handler MUST NOT silently
  // pick when a user has 2+ Apps; it returns HTTP 409 with a typed
  // `multiple_apps_resolved` body so the client can surface a clear
  // error or (in a future sibling spec) prompt for selection.
  if (auth.userId && !auth.appId) {
    const apps = await resolveUserApps(auth.userId, db);
    if (apps.length > 1) {
      // Hadron-namespaced custom error code per research §R-6 (not in
      // the MCP error vocabulary — the MCP spec's authentication
      // errors are token-scoped, not resource-ambiguity-scoped).
      res.status(409).json({
        error: 'multiple_apps_resolved',
        error_description:
          'User has more than one Hadron App; this MCP client does not support App selection. See https://hadronmemory.com/docs/auth/multiple-apps-resolved for guidance.',
      });
      return;
    }
    if (apps.length === 1) {
      auth.appId = apps[0].id;
      auth.organizationId = apps[0].organizationId;
    }
    // Zero-App path: continue without setting appId (preserves existing
    // JWT-without-App behavior; downstream App-scoped tool calls will
    // fail with their existing errors). Zero-App handling is
    // intentionally not in FR-020's scope.
  }

  // Session not found or no session — create a new one.
  // This handles both first-time connections and reconnections after server restart.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: sessionId
      ? () => sessionId  // Reuse the client's session ID so it doesn't need to re-init
      : () => randomUUID(),
  });

  const mcpServer = createMcpServerInstance(auth);

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) transports.delete(sid);
  };

  await mcpServer.connect(transport);

  // Handle the request with the new transport
  await transport.handleRequest(req, res, req.body);

  const sid = transport.sessionId;
  if (sid) {
    transports.set(sid, transport);
  }
}

/**
 * Handle DELETE requests to close an MCP session.
 */
export async function handleMcpDelete(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const transport = transports.get(sessionId)!;
  await transport.close();
  transports.delete(sessionId);
  res.status(200).json({ ok: true });
}
