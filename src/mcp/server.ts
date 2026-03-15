import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { resolveAuthContext, type AuthContext } from '../middleware/auth.js';
import { graphNameToNamespace } from '../config.js';
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
  const parts = loc.split('.');
  if (parts.some((p) => !/^[a-zA-Z0-9_-]+$/.test(p))) {
    throw new Error(
      `Invalid loc "${loc}": each segment must contain only letters, digits, hyphens, or underscores`,
    );
  }
}

// ---------------------------------------------------------------------------
// Access control: check if a client can access/write to a graph
// ---------------------------------------------------------------------------

/**
 * Get the graph IDs accessible to a client through bundle subscriptions.
 * Returns a map of graphId → subscriptionType.
 */
async function getClientGraphAccess(
  clientId: string,
): Promise<Map<string, string>> {
  const subs = await db.clientBundleSubscription.findMany({
    where: { clientId, deletedAt: null },
    include: {
      bundle: {
        include: {
          graphs: { include: { graph: true } },
        },
      },
    },
  });

  const access = new Map<string, string>();
  for (const sub of subs) {
    for (const bg of sub.bundle.graphs) {
      // If multiple subs include the same graph, READ_WRITE wins
      const existing = access.get(bg.graphId);
      if (!existing || sub.subscriptionType === 'READ_WRITE') {
        access.set(bg.graphId, sub.subscriptionType);
      }
    }
  }
  return access;
}

/**
 * Check if a client has write access to a specific graph.
 * Platform ADMINs and OWNERs bypass subscription checks.
 */
async function canWriteToGraph(
  auth: AuthContext,
  graphId: string,
): Promise<boolean> {
  if (!auth.clientId) return false;
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return true;

  const access = await getClientGraphAccess(auth.clientId);
  return access.get(graphId) === 'READ_WRITE';
}

/**
 * Get the set of node IDs the client can see (via bundle subscriptions).
 * Returns null to mean "all nodes" (for ADMIN/OWNER).
 */
async function getAccessibleGraphIds(
  auth: AuthContext,
): Promise<string[] | null> {
  if (auth.roles?.includes('ADMIN') || auth.roles?.includes('OWNER')) return null;
  if (!auth.clientId) return [];

  const access = await getClientGraphAccess(auth.clientId);
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

  // ── h-find-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-find-node',
    'Search for nodes by name, tags, or description',
    { query: z.string().describe('Search query'), limit: z.number().optional().describe('Max results (default 50)') },
    async ({ query, limit }) => {
      const graphIds = await getAccessibleGraphIds(auth);
      const where: Record<string, unknown> = {};
      if (graphIds) where.graphId = { in: graphIds };

      const nodes = await db.node.findMany({ where, take: 1000 });
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
    'Read a node by its dotted path (e.g. my-org.my-repo.models)',
    { loc: z.string().describe('Dotted path to the node') },
    async ({ loc }) => {
      const node = await db.node.findUnique({
        where: { loc },
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
        },
      });
      if (!node) {
        return textResult(`Node "${loc}" not found.`);
      }

      // Access check
      const graphIds = await getAccessibleGraphIds(auth);
      if (graphIds && !graphIds.includes(node.graphId)) {
        return textResult(`Node "${loc}" not found.`);
      }

      // Record usage event (fire-and-forget)
      db.usageEvent.create({
        data: {
          type: 'read',
          nodeLoc: loc,
          nodeId: node.id,
          clientId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      const meta = [
        `**${node.title}** (${node.name})`,
        node.description ? `> ${node.description}` : '',
        node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
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
    'Read the next sibling node under a parent, ordered by name. Returns the first child if current is omitted.',
    {
      parent: z.string().describe('Dotted path of the parent node'),
      current: z.string().optional().describe('Dotted path of the current child node'),
    },
    async ({ parent, current }) => {
      const prefix = parent + '.';
      const graphIds = await getAccessibleGraphIds(auth);
      const where: Record<string, unknown> = {
        loc: { startsWith: prefix },
      };
      if (graphIds) where.graphId = { in: graphIds };

      const allNodes = await db.node.findMany({ where, orderBy: { loc: 'asc' } });
      // Direct children only (no further dots after prefix)
      const children = allNodes.filter((n) => !n.loc.slice(prefix.length).includes('.'));

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
        `**${node.title}** (${node.name})`,
        node.description ? `> ${node.description}` : '',
        node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
        node.outgoingEdges.length
          ? `Related:\n${node.outgoingEdges.map((e) => `  - ${e.target.loc} (${e.target.name}) — ${e.label}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      return textResult(meta + '\n\n---\n\n' + (node.content || ''));
    },
  );

  // ── h-create-node ────────────────────────────────────────────────────────

  server.tool(
    'h-create-node',
    'Create or update a node. Requires write access to the graph.',
    {
      loc: z.string().describe('Dotted path for the node'),
      graphId: z.string().describe('ID of the graph this node belongs to'),
      name: z.string().describe('Node name'),
      title: z.string().describe('Display title'),
      description: z.string().optional().describe('Short description'),
      content: z.string().optional().describe('Markdown content'),
      tags: z.array(z.string()).optional().describe('Tags'),
      edges: z.array(z.object({
        targetId: z.string().describe('Target node ID'),
        label: z.string().describe('Relationship label'),
      })).optional().describe('Outgoing edges'),
    },
    async ({ loc, graphId, name, title, description, content, tags, edges }) => {
      try {
        validateLoc(loc);
      } catch (e) {
        return textResult((e as Error).message);
      }

      if (!(await canWriteToGraph(auth, graphId))) {
        return textResult('Write access denied for this graph.');
      }

      const namespace = loc.split('.').slice(0, 2).join('.');

      const existing = await db.node.findUnique({ where: { loc } });

      const upserted = await db.node.upsert({
        where: { loc },
        create: {
          id: existing?.id ?? randomUUID().replace(/-/g, ''),
          graphId,
          loc,
          name,
          title,
          namespace,
          description: description ?? null,
          content: content ?? null,
          tags: tags ?? [],
        },
        update: {
          name,
          title,
          description: description ?? null,
          content: content ?? null,
          tags: tags ?? [],
        },
      });

      // Replace edges if provided
      if (edges) {
        await db.edge.deleteMany({ where: { sourceId: upserted.id } });
        for (const edge of edges) {
          await db.edge.create({
            data: {
              sourceId: upserted.id,
              targetId: edge.targetId,
              label: edge.label,
            },
          });
        }
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          type: 'write',
          nodeLoc: loc,
          nodeId: upserted.id,
          clientId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      return textResult(`Node saved: ${loc}`);
    },
  );

  // ── h-move-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-move-node',
    'Move or rename a node. The node keeps its stable ID so all edge references remain valid.',
    {
      from: z.string().describe('Current dotted path'),
      to: z.string().describe('New dotted path'),
    },
    async ({ from, to }) => {
      try {
        validateLoc(to);
      } catch (e) {
        return textResult((e as Error).message);
      }

      const node = await db.node.findUnique({ where: { loc: from } });
      if (!node) return textResult(`Node "${from}" not found.`);

      if (!(await canWriteToGraph(auth, node.graphId))) {
        return textResult('Write access denied for this graph.');
      }

      const newNamespace = to.split('.').slice(0, 2).join('.');
      const newName = to.split('.').pop()!;

      await db.node.update({
        where: { id: node.id },
        data: { loc: to, name: newName, namespace: newNamespace },
      });

      return textResult(`Moved "${from}" → "${to}"`);
    },
  );

  // ── h-run-action ─────────────────────────────────────────────────────────

  server.tool(
    'h-run-action',
    'Load an action node and resolve its dependencies. Returns the action instructions with all referenced node content.',
    {
      loc: z.string().describe('Dotted path to the action node'),
      args: z.record(z.string(), z.string()).optional().describe('Action arguments as key-value pairs'),
    },
    async ({ loc, args }) => {
      const node = await db.node.findUnique({
        where: { loc },
        include: { outgoingEdges: { include: { target: true } } },
      });
      if (!node) return textResult(`Node "${loc}" not found.`);

      // Access check
      const graphIds = await getAccessibleGraphIds(auth);
      if (graphIds && !graphIds.includes(node.graphId)) {
        return textResult(`Node "${loc}" not found.`);
      }

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
          clientId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
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
      const sessionId = randomUUID();

      const session = await db.session.create({
        data: {
          id: sessionId,
          type: (type || 'DEVELOPER') as SessionType,
          plan: description,
          clientId: auth.clientId?.startsWith('github:') ? null : auth.clientId ?? null,
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
    'Check the graph for broken edge references and nodes with missing content',
    {},
    async () => {
      const graphIds = await getAccessibleGraphIds(auth);
      const where: Record<string, unknown> = {};
      if (graphIds) where.graphId = { in: graphIds };

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
    'Trigger an on-demand sync for a graph from its GitHub source.',
    {
      graphId: z.string().describe('ID of the graph to sync'),
    },
    async ({ graphId }) => {
      if (!(await canWriteToGraph(auth, graphId))) {
        return textResult('Access denied.');
      }

      const graph = await db.graph.findUnique({
        where: { id: graphId },
        include: { organization: true },
      });
      if (!graph) return textResult('Graph not found.');
      if (!graph.source) return textResult('Graph has no source repository configured.');

      // Import and call syncGraphFromGithub
      const { syncGraphFromGithub } = await import('../integrations/github/syncGraphFromGithub.js');
      const result = await syncGraphFromGithub(graph as Parameters<typeof syncGraphFromGithub>[0]);

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

  // New session — only allowed for initialization requests
  if (sessionId && !transports.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Create new transport + MCP server for this session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const mcpServer = createMcpServerInstance(auth);

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) transports.delete(sid);
  };

  await mcpServer.connect(transport);

  // Store transport by session ID (set after handleRequest processes the init)
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
