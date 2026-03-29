import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateId } from '../lib/id.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { resolveAuthContext, type AuthContext } from '../middleware/auth.js';
import { writeNodeToGit } from '../integrations/github/writeNodeToGit.js';
import type { SessionType } from '../generated/prisma/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
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

function validateLoc(loc: string): void {
  const parts = loc.split(':');
  if (parts.some((p) => !/^[a-zA-Z0-9_-]+$/.test(p))) {
    throw new Error(
      `Invalid loc "${loc}": each segment must contain only letters, digits, hyphens, or underscores`,
    );
  }
}

/**
 * If the user passes a full URN (e.g. "hadronmemory.com:dev:architecture"),
 * try to strip the memory URN prefix and return just the loc.
 * Also returns the matched memoryId for scoping.
 */
async function resolveLocFromUrn(
  input: string,
  accessibleMemoryIds: string[] | null,
): Promise<{ loc: string; memoryId?: string }> {
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
 * Resolve a memoryId that may be either a cuid (primary key) or a memory URN.
 * Returns the actual database ID, or null if not found.
 */
async function resolveMemoryId(memoryIdOrName: string): Promise<string | null> {
  // If it looks like a cuid (no colons, no slashes), try it directly
  if (!memoryIdOrName.includes(':') && !memoryIdOrName.includes('/')) {
    const exists = await db.memory.findUnique({ where: { id: memoryIdOrName }, select: { id: true } });
    if (exists) return exists.id;
  }
  // Try to find by URN
  const byUrn = await db.memory.findFirst({ where: { urn: memoryIdOrName }, select: { id: true } });
  if (byUrn) return byUrn.id;
  // Try to find by name
  const byName = await db.memory.findFirst({ where: { name: memoryIdOrName }, select: { id: true } });
  if (byName) return byName.id;
  // Last resort: try as ID
  if (memoryIdOrName.includes(':')) {
    const byId = await db.memory.findUnique({ where: { id: memoryIdOrName }, select: { id: true } });
    if (byId) return byId.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Access control: check if a station can access/write to a memory
// ---------------------------------------------------------------------------

/**
 * Get the memory IDs accessible to a station through agent subscriptions.
 * Returns a map of memoryId → subscriptionType.
 */
async function getStationMemoryAccess(
  stationId: string,
): Promise<Map<string, string>> {
  const subs = await db.stationAgentSubscription.findMany({
    where: { stationId, deletedAt: null },
    include: {
      agent: {
        include: {
          memoryItems: { include: { memory: true } },
        },
      },
    },
  });

  const access = new Map<string, string>();
  for (const sub of subs) {
    for (const item of sub.agent.memoryItems) {
      // Effective access = min(station subscription type, agent memory item role)
      // Station READ_ONLY → always read-only regardless of agent role
      // Station READ_WRITE + agent role "read" → read-only
      // Station READ_WRITE + agent role "read-write" → read-write
      const agentRole = (item as any).role ?? 'read';
      const effective = sub.subscriptionType === 'READ_WRITE' && agentRole === 'read-write'
        ? 'READ_WRITE'
        : 'READ_ONLY';
      // If multiple subs include the same memory, READ_WRITE wins
      const existing = access.get(item.memoryId);
      if (!existing || effective === 'READ_WRITE') {
        access.set(item.memoryId, effective);
      }
    }
  }
  return access;
}

/**
 * Check if a station has write access to a specific memory.
 * Platform ADMINs and OWNERs bypass subscription checks.
 */
async function canWriteToMemory(
  auth: AuthContext,
  memoryId: string,
): Promise<boolean> {
  if (!auth.clientId) return false;
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;

  const access = await getStationMemoryAccess(auth.clientId);
  return access.get(memoryId) === 'READ_WRITE';
}

/**
 * Get the set of memory IDs the client can see (via bundle subscriptions).
 * Returns null to mean "all" (for ADMIN/OWNER).
 */
async function getAccessibleMemoryIds(
  auth: AuthContext,
): Promise<string[] | null> {
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return null;
  if (!auth.clientId) return [];

  const access = await getStationMemoryAccess(auth.clientId);
  return [...access.keys()];
}

// ---------------------------------------------------------------------------
// MCP Server factory — one McpServer per transport session
// ---------------------------------------------------------------------------

function createMcpServerInstance(auth: AuthContext): McpServer {
  const server = new McpServer(
    { name: 'hadron', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  // ── h-list-memories ──────────────────────────────────────────────────────

  server.tool(
    'h-list-memories',
    'List all memories this station has access to, with URN and access level (read-only or read-write).',
    {},
    async () => {
      if (!auth.clientId) return textResult('Not authenticated.');

      const access = await getStationMemoryAccess(auth.clientId);
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
        return `- **${m.urn}** — ${m.name} (${level})`;
      });

      return textResult(`${memories.length} accessible memories:\n\n${lines.join('\n')}`);
    },
  );

  // ── h-find-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-find-node',
    'Search for nodes by name, tags, or description',
    { query: z.string().describe('Search query'), limit: z.number().optional().describe('Max results (default 50)') },
    async ({ query, limit }) => {
      const memoryIds = await getAccessibleMemoryIds(auth);
      const where: Record<string, unknown> = {};
      if (memoryIds) where.memoryId = { in: memoryIds };

      const allNodes = await db.node.findMany({ where, take: 1000 });
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
      const lines = limited.map((n) => {
        return `- **${n.loc}** — ${n.description || n.name}`;
      });
      return textResult(lines.join('\n'));
    },
  );

  // ── h-read-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-read-node',
    'Read a node by its loc path (e.g. architecture) or full URN (e.g. hadronmemory.com:dev:architecture)',
    { loc: z.string().describe('Node loc path or full URN') },
    async ({ loc: rawLoc }) => {
      const memoryIds = await getAccessibleMemoryIds(auth);
      const { loc, memoryId } = await resolveLocFromUrn(rawLoc, memoryIds);
      const where: Record<string, unknown> = { loc };
      if (memoryId) where.memoryId = memoryId;
      else if (memoryIds) where.memoryId = { in: memoryIds };

      const candidates = await db.node.findMany({
        where,
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
        },
      });
      // Prefer canonical (isLink=false) over link nodes
      const node = candidates.find((n) => !n.isLink) ?? candidates[0] ?? null;
      if (!node) {
        return textResult(`Node "${loc}" not found.`);
      }

      // Record usage event (fire-and-forget)
      db.usageEvent.create({
        data: {
          type: 'read',
          nodeLoc: loc,
          nodeId: node.id,
          stationId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      const meta = [
        `**${node.name}**`,
        node.description ? `> ${node.description}` : '',
        node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
        node.seq !== null ? `Seq: ${node.seq}` : '',
        node.outgoingEdges.length
          ? `Related:\n${node.outgoingEdges.map((e) => `  - ${e.target.loc} (${e.target.name}) — ${e.label}`).join('\n')}`
          : '',
        node.incomingEdges.length
          ? `Referenced by:\n${node.incomingEdges.map((e) => `  - ${e.source.loc} (${e.source.name}) — ${e.label}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      return textResult(meta + '\n\n---\n\n' + (node.content || ''));
    },
  );

  // ── h-read-next-node ─────────────────────────────────────────────────────

  server.tool(
    'h-read-next-node',
    'Read the next sibling node under a parent, ordered by `seq`. Returns the first child if current is omitted.',
    {
      parent: z.string().describe('Colon-delimited path of the parent node'),
      current: z.string().optional().describe('Colon-delimited path of the current child node'),
    },
    async ({ parent, current }) => {
      const prefix = parent + ':';
      const memoryIds = await getAccessibleMemoryIds(auth);
      const where: Record<string, unknown> = {
        loc: { startsWith: prefix },
      };
      if (memoryIds) where.memoryId = { in: memoryIds };

      const allNodes = await db.node.findMany({ where, orderBy: { loc: 'asc' } });
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
        return textResult(`No children found under "${parent}".`);
      }

      let next;
      if (!current) {
        next = children[0];
      } else {
        const idx = children.findIndex((n) => n.loc === current);
        if (idx === -1) {
          return textResult(`Current node "${current}" not found among children of "${parent}".`);
        }
        if (idx + 1 >= children.length) {
          return textResult(`No more nodes after "${current}".`);
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

      const meta = [
        `**${node.name}**`,
        node.description ? `> ${node.description}` : '',
        node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
        node.seq !== null ? `Seq: ${node.seq}` : '',
        node.outgoingEdges.length
          ? `Related:\n${node.outgoingEdges.map((e) => `  - ${e.target.loc} (${e.target.name}) — ${e.label}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      return textResult(meta + '\n\n---\n\n' + (node.content || ''));
    },
  );

  // ── h-list-children ──────────────────────────────────────────────────────

  server.tool(
    'h-list-children',
    'List direct child nodes under a parent, ordered by seq then loc. Returns loc, name, description, seq, and nodeType for each child.',
    {
      parent: z.string().describe('Parent node loc path or full URN'),
    },
    async ({ parent: rawParent }) => {
      const memoryIds = await getAccessibleMemoryIds(auth);
      const resolved = await resolveLocFromUrn(rawParent, memoryIds);
      const parent = resolved.loc;
      const prefix = parent + ':';
      const where: Record<string, unknown> = {
        loc: { startsWith: prefix },
      };
      if (resolved.memoryId) where.memoryId = resolved.memoryId;
      else if (memoryIds) where.memoryId = { in: memoryIds };

      const allNodes = await db.node.findMany({ where, orderBy: { loc: 'asc' } });
      // Direct children only (no further colons after prefix)
      const children = allNodes
        .filter((n) => !n.loc.slice(prefix.length).includes(':'))
        .sort((a, b) => {
          if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
          if (a.seq !== null) return -1;
          if (b.seq !== null) return 1;
          return a.loc.localeCompare(b.loc);
        });

      if (children.length === 0) {
        return textResult(`No children found under "${parent}".`);
      }

      const lines = children.map((n) => {
        const parts = [
          `- **${n.loc}**`,
          n.name,
        ];
        if (n.seq !== null) parts.push(`(seq: ${n.seq})`);
        if (n.nodeType !== 'knowledge') parts.push(`[${n.nodeType}]`);
        if (n.description) parts.push(`— ${n.description}`);
        return parts.join(' ');
      });

      return textResult(`${children.length} children under "${parent}":\n\n${lines.join('\n')}`);
    },
  );

  // ── h-create-node ────────────────────────────────────────────────────────

  server.tool(
    'h-create-node',
    'Create or update a node. Requires write access to the memory.',
    {
      loc: z.string().describe('Node loc path or full URN (e.g. architecture or hadronmemory.com:dev:architecture)'),
      memoryId: z.string().optional().describe('Memory ID or URN. Omit to auto-detect from loc URN prefix, or uses the only writable memory.'),
      name: z.string().describe('Node name'),
      nodeType: z.string().optional().describe('Node type: "knowledge" (default) or "data"'),
      description: z.string().optional().describe('Short description'),
      content: z.string().optional().describe('Markdown content'),
      seq: z.number().optional().describe('Sort order among siblings (lower values first)'),
      tags: z.array(z.string()).optional().describe('Tags'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
      llmModel: z.string().optional().describe('LLM model used (e.g. claude-opus-4-6)'),
      aiAgent: z.string().optional().describe('AI agent tool used (e.g. claude-code, cursor)'),
      edges: z.array(z.object({
        targetId: z.string().describe('Target node ID or loc path'),
        label: z.string().describe('Relationship label'),
      })).optional().describe('Outgoing edges'),
    },
    async ({ loc: rawLoc, memoryId: inputMemoryId, name, nodeType, description, content, seq, tags, properties, llmModel, aiAgent, edges }) => {
      // Resolve URN to loc + memoryId if a full URN was passed
      const memoryIds = await getAccessibleMemoryIds(auth);
      const resolved = await resolveLocFromUrn(rawLoc, memoryIds);
      const loc = resolved.loc;
      // If URN resolution found a memory, use it (unless explicitly provided)
      let rawMemoryId = inputMemoryId ?? resolved.memoryId ?? undefined;

      try {
        validateLoc(loc);
      } catch (e) {
        return textResult((e as Error).message);
      }

      let memoryId: string | null = null;

      if (rawMemoryId) {
        // Explicit memoryId provided — resolve by name or ID
        memoryId = await resolveMemoryId(rawMemoryId);
        if (!memoryId) {
          return textResult(`Memory not found: "${rawMemoryId}". Use the memory name (e.g. "my-org.my-repo") or its ID.`);
        }
      } else {
        // Infer memoryId
        const access = auth.clientId ? await getStationMemoryAccess(auth.clientId) : new Map();
        const writableIds = [...access.entries()].filter(([, v]) => v === 'READ_WRITE').map(([k]) => k);

        if (writableIds.length === 1) {
          // Only one writable memory — use it
          memoryId = writableIds[0];
        } else if (writableIds.length > 1) {
          // Multiple writable memories — find the right one by looking for parent nodes
          const locParts = loc.split(':');
          for (let i = locParts.length - 1; i >= 1; i--) {
            const parentLoc = locParts.slice(0, i).join(':');
            const parentNode = await db.node.findFirst({
              where: { loc: parentLoc, memoryId: { in: writableIds } },
              select: { memoryId: true },
            });
            if (parentNode) {
              memoryId = parentNode.memoryId;
              break;
            }
          }

          // If no parent found, try edges
          if (!memoryId && edges?.length) {
            const edgeMemoryIds = new Set<string>();
            for (const edge of edges) {
              if (edge.targetId.includes(':')) {
                const targetNode = await db.node.findFirst({ where: { loc: edge.targetId }, select: { memoryId: true } });
                if (targetNode && writableIds.includes(targetNode.memoryId)) {
                  edgeMemoryIds.add(targetNode.memoryId);
                }
              }
            }
            if (edgeMemoryIds.size === 1) {
              memoryId = [...edgeMemoryIds][0];
            }
          }
        }

        if (!memoryId) {
          const memories = await db.memory.findMany({
            where: { id: { in: writableIds } },
            select: { urn: true, name: true },
          });
          const list = memories.map((m) => `${m.name} (${m.urn})`).join(', ');
          return textResult(
            writableIds.length === 0
              ? 'No writable memories available. Subscribe to a memory with READ_WRITE access.'
              : `Multiple writable memories available: ${list}. Please specify memoryId using the memory URN.`
          );
        }
      }

      if (!(await canWriteToMemory(auth, memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      const existing = await db.node.findUnique({ where: { loc_memoryId: { loc, memoryId } } });

      const upserted = await db.node.upsert({
        where: { loc_memoryId: { loc, memoryId } },
        create: {
          id: existing?.id ?? generateId(),
          memoryId,
          loc,
          name,
          nodeType: nodeType ?? 'knowledge',
          description: description ?? null,
          content: content ?? null,
          seq: seq ?? null,
          tags: tags ?? [],
          properties: properties as any ?? undefined,
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
          ...(llmModel ? { llmModel } : {}),
          ...(aiAgent ? { aiAgent } : {}),
        } as any,
      });

      // Replace edges if provided
      if (edges) {
        await db.edge.deleteMany({ where: { sourceId: upserted.id } });
        await db.pendingEdge.deleteMany({ where: { sourceId: upserted.id } });
        for (const edge of edges) {
          // Resolve targetId: if it looks like a loc path (contains dots), look up the node
          let resolvedTargetId = edge.targetId;
          if (edge.targetId.includes(':')) {
            const targetNode = await db.node.findFirst({ where: { loc: edge.targetId } });
            if (targetNode) {
              resolvedTargetId = targetNode.id;
            } else {
              // Target doesn't exist yet — create a PendingEdge
              await db.pendingEdge.upsert({
                where: { sourceId_targetId: { sourceId: upserted.id, targetId: edge.targetId } },
                create: {
                  sourceId: upserted.id,
                  targetId: edge.targetId,
                  label: edge.label,
                  createdBy: auth.clientId ?? null,
                },
                update: { label: edge.label },
              });
              continue;
            }
          }
          // Target exists — create a real Edge
          await db.edge.upsert({
            where: { sourceId_targetId_label: { sourceId: upserted.id, targetId: resolvedTargetId, label: edge.label } },
            create: {
              sourceId: upserted.id,
              targetId: resolvedTargetId,
              label: edge.label,
              createdBy: auth.clientId ?? null,
            },
            update: {},
          });
        }
      }

      // Resolve any PendingEdges waiting for this node (by ID or loc)
      const pendingByLoc = await db.pendingEdge.findMany({ where: { targetId: loc } });
      const pendingById = await db.pendingEdge.findMany({ where: { targetId: upserted.id } });
      for (const p of [...pendingByLoc, ...pendingById]) {
        await db.edge.upsert({
          where: { sourceId_targetId_label: { sourceId: p.sourceId, targetId: upserted.id, label: p.label ?? '' } },
          create: { sourceId: p.sourceId, targetId: upserted.id, label: p.label ?? '' },
          update: {},
        });
        await db.pendingEdge.delete({ where: { id: p.id } });
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          type: 'write',
          nodeLoc: loc,
          nodeId: upserted.id,
          stationId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
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
          console.error('[h-create-node] git write error:', err);
        });
      }

      return textResult(`Node saved: ${loc}`);
    },
  );

  // ── h-update-node ────────────────────────────────────────────────────────

  server.tool(
    'h-update-node',
    'Partially update an existing node. Only the fields you provide are changed — everything else is preserved.',
    {
      loc: z.string().describe('Node loc path or full URN'),
      name: z.string().optional().describe('New node name'),
      nodeType: z.string().optional().describe('Node type: "knowledge" or "data"'),
      description: z.string().optional().describe('New short description'),
      content: z.string().optional().describe('New markdown content'),
      seq: z.number().optional().describe('New sort order among siblings'),
      tags: z.array(z.string()).optional().describe('Replace tags'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
      llmModel: z.string().optional().describe('LLM model used'),
      aiAgent: z.string().optional().describe('AI agent tool used'),
      edges: z.array(z.object({
        targetId: z.string().describe('Target node ID or loc path'),
        label: z.string().describe('Relationship label'),
      })).optional().describe('Replace outgoing edges'),
      reason: z.string().optional().describe('Why this change was made (stored in version history)'),
    },
    async ({ loc: rawLoc, name, nodeType, description, content, seq, tags, properties, llmModel, aiAgent, edges, reason }) => {
      // Resolve URN to loc if needed
      const memoryIds = await getAccessibleMemoryIds(auth);
      const resolved = await resolveLocFromUrn(rawLoc, memoryIds);
      const loc = resolved.loc;
      const where: Record<string, unknown> = { loc };
      if (resolved.memoryId) where.memoryId = resolved.memoryId;
      else if (memoryIds) where.memoryId = { in: memoryIds };

      const existing = await db.node.findFirst({ where });
      if (!existing) {
        return textResult(`Node not found: "${loc}"`);
      }

      if (!(await canWriteToMemory(auth, existing.memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      // Snapshot current state for version history
      await db.nodeVersion.create({
        data: {
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
      if (llmModel !== undefined) data.llmModel = llmModel;
      if (aiAgent !== undefined) data.aiAgent = aiAgent;

      if (Object.keys(data).length > 0) {
        await db.node.update({ where: { id: existing.id }, data });
      }

      // Replace edges if provided (same logic as h-create-node)
      if (edges !== undefined) {
        await db.edge.deleteMany({ where: { sourceId: existing.id } });
        await db.pendingEdge.deleteMany({ where: { sourceId: existing.id } });
        for (const edge of edges) {
          let resolvedTargetId = edge.targetId;
          if (edge.targetId.includes(':')) {
            const targetNode = await db.node.findFirst({ where: { loc: edge.targetId } });
            if (targetNode) {
              resolvedTargetId = targetNode.id;
            } else {
              await db.pendingEdge.upsert({
                where: { sourceId_targetId: { sourceId: existing.id, targetId: edge.targetId } },
                create: {
                  sourceId: existing.id,
                  targetId: edge.targetId,
                  label: edge.label,
                  createdBy: auth.clientId ?? null,
                },
                update: { label: edge.label },
              });
              continue;
            }
          }
          await db.edge.upsert({
            where: { sourceId_targetId_label: { sourceId: existing.id, targetId: resolvedTargetId, label: edge.label } },
            create: {
              sourceId: existing.id,
              targetId: resolvedTargetId,
              label: edge.label,
              createdBy: auth.clientId ?? null,
            },
            update: {},
          });
        }
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          type: 'write',
          nodeLoc: loc,
          nodeId: existing.id,
          stationId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
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

      return textResult(`Node updated: ${loc}`);
    },
  );

  // ── h-move-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-move-node',
    'Move or rename a node. The node keeps its stable ID so all edge references remain valid.',
    {
      from: z.string().describe('Current colon-delimited path'),
      to: z.string().describe('New colon-delimited path'),
    },
    async ({ from, to }) => {
      try {
        validateLoc(to);
      } catch (e) {
        return textResult((e as Error).message);
      }

      // Find the node — try accessible memories, prefer canonical
      const memoryIds = await getAccessibleMemoryIds(auth);
      const moveWhere: Record<string, unknown> = { loc: from };
      if (memoryIds) moveWhere.memoryId = { in: memoryIds };
      const candidates = await db.node.findMany({ where: moveWhere });
      const node = candidates.find((n) => !n.isLink) ?? candidates[0] ?? null;
      if (!node) return textResult(`Node "${from}" not found.`);

      if (!(await canWriteToMemory(auth, node.memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      const newName = to.split(':').pop()!;

      await db.node.update({
        where: { loc_memoryId: { loc: from, memoryId: node.memoryId } },
        data: { loc: to, name: newName },
      });

      return textResult(`Moved "${from}" → "${to}"`);
    },
  );

  // ── h-run-action ─────────────────────────────────────────────────────────

  server.tool(
    'h-run-action',
    'Load an action node and resolve its dependencies. Returns the action instructions with all referenced node content.',
    {
      loc: z.string().describe('Node loc path or full URN'),
      args: z.record(z.string(), z.string()).optional().describe('Action arguments as key-value pairs'),
    },
    async ({ loc: rawLoc, args }) => {
      const memoryIds = await getAccessibleMemoryIds(auth);
      const resolved = await resolveLocFromUrn(rawLoc, memoryIds);
      const loc = resolved.loc;
      const actionWhere: Record<string, unknown> = { loc };
      if (resolved.memoryId) actionWhere.memoryId = resolved.memoryId;
      else if (memoryIds) actionWhere.memoryId = { in: memoryIds };
      const actionCandidates = await db.node.findMany({
        where: actionWhere,
        include: { outgoingEdges: { include: { target: true } } },
      });
      const node = actionCandidates.find((n) => !n.isLink) ?? actionCandidates[0] ?? null;
      if (!node) return textResult(`Node "${loc}" not found.`);

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
          topicSections.push(
            `## Node: ${target.name} (${target.loc})\n\n${target.content}`,
          );
        }
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          type: 'action-run',
          nodeLoc: loc,
          nodeId: node.id,
          stationId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
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
          stationId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
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
    'Check the memory for broken edge references and nodes with missing content',
    {},
    async () => {
      const memoryIds = await getAccessibleMemoryIds(auth);
      const where: Record<string, unknown> = {};
      if (memoryIds) where.memoryId = { in: memoryIds };

      const nodes = await db.node.findMany({
        where,
        include: { outgoingEdges: true },
      });
      const nodeIds = new Set(nodes.map((n) => n.id));
      const issues: string[] = [];

      for (const node of nodes) {
        for (const edge of node.outgoingEdges) {
          if (!nodeIds.has(edge.targetId)) {
            issues.push(`[broken-ref] ${node.loc} → id:${edge.targetId} (${edge.label})`);
          }
        }
        if (!node.description && !node.content) {
          issues.push(`[sparse] ${node.loc} — no description and no content`);
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
    'Trigger an on-demand sync for a memory from its GitHub source.',
    {
      memoryId: z.string().describe('ID of the memory to sync'),
    },
    async ({ memoryId }) => {
      if (!(await canWriteToMemory(auth, memoryId))) {
        return textResult('Access denied.');
      }

      const memory = await db.memory.findUnique({
        where: { id: memoryId },
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
  // Authenticate
  const auth = await resolveAuthContext(req, db);
  if (!auth.clientId && !auth.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Check for existing session
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
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
