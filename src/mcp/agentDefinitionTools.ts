/**
 * #1892 — an Agent's task list and process list on the MCP surface
 * (cor:dmo:050:15, :16): `hadron_agent_tasks` and `hadron_agent_processes`.
 *
 * Both are thin renders of the same lists GraphQL's `agentTaskList` /
 * `agentProcessList` serve (src/lib/agentDefinitionLists.ts): the gate, the
 * chain walk, the dedupe and the triggers are computed once, so the two
 * surfaces return the same list (050:15 S3, 050:16 S4). Nothing here
 * re-checks or re-derives any of them.
 *
 * #1936 — and the two writes: `hadron_agent_set_base` and
 * `hadron_agent_set_index_refs`, which call GraphQL's `setAgentBase` /
 * `setAgentIndexRefs` as they are. The gate (whoever manages the child), the
 * refusals and their order, the concealment and the in-transaction
 * re-authorization all stay the resolver's; a refusal comes back with the
 * code and message GraphQL's formatter gives it. Nothing is validated here beyond the
 * arguments' shape.
 */
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { formatGraphQLError } from '../api/graphql/formatError.js';
import { canReadMemory, EXPLICIT_REF } from './access-control.js';
import { resolveAgentRef } from '../lib/entityRef/agentRef.js';
import { listAgentProcesses, listAgentTasks, type ListedNode } from '../lib/agentDefinitionLists.js';
import { emitEntityUrnV2, safeNodeUrnV2 } from '../lib/urnEmit.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(e: unknown) {
  return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
}

/**
 * #1936 — a write's refusal as `[<code>] <message>`, exactly as GraphQL sends
 * it: the error goes through `formatGraphQLError`, the server's own formatter,
 * so every code it assigns (a not-found's, URN_NOT_QUALIFIED, the ambiguous
 * legacy alias, and any it gains later) is classified once, there, and the
 * code is written as it is on the wire (Andi's P2 on #1943). An error the
 * formatter leaves untyped, or types INTERNAL_SERVER_ERROR, is a server fault:
 * rethrown to the shared tool error boundary, which redacts a database one.
 */
function refusalResult(e: unknown) {
  const wire = formatGraphQLError(
    { message: e instanceof Error ? e.message : String(e), extensions: e instanceof GraphQLError ? e.extensions : {} },
    e,
  );
  const code = wire.extensions?.code;
  if (typeof code !== 'string' || code === 'INTERNAL_SERVER_ERROR') throw e;
  return { isError: true as const, content: [{ type: 'text' as const, text: `[${code}] ${wire.message}` }] };
}

type AgentRow = { id: string; urn: string; extendsAgentId: string | null; tasksIndexRef: string | null; processesIndexRef: string | null };
type Resolver<A> = (parent: unknown, args: A, ctx: Context) => Promise<AgentRow>;
const M = resolvers.Mutation as unknown as {
  setAgentBase: Resolver<{ ref: string; baseRef: string | null }>;
  setAgentIndexRefs: Resolver<{ ref: string; tasksIndexRef?: string | null; processesIndexRef?: string | null }>;
};

/** The GraphQL Context for the connection's principal, as the other delegating tools build it. */
function contextOf(db: PrismaClient, auth: AuthContext): Context {
  return {
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  };
}

/** Each listed node's URN, from its memory's URN: one memory query per list. */
async function nodeUrns(db: PrismaClient, nodes: ListedNode[]): Promise<Map<string, string>> {
  const memories = await db.memory.findMany({
    where: { id: { in: [...new Set(nodes.map((n) => n.memoryId))] } },
    select: { id: true, urn: true },
  });
  const memUrn = new Map(memories.map((m) => [m.id, m.urn]));
  return new Map(nodes.map((n) => [n.id, safeNodeUrnV2(memUrn.get(n.memoryId)!, n.loc)]));
}

/**
 * One entry's lines: name and URN, then whatever of trigger, kind and base it
 * has. An inherited entry also says where to read it: at its loc in the
 * Agent's own system memory, which reads through to the base (#1891). Its
 * base URN may be closed to a reader of the child only (ruling (B), #10968;
 * Anne's P3 on #1896).
 */
function entryLines(node: ListedNode, urn: string, extra: string[], childMemoryUrn: string | null): string[] {
  const lines = [`- ${node.name} — ${urn}`, ...extra.map((l) => `  ${l}`)];
  if (node.inheritedFrom) {
    lines.push(`  Inherited from: ${emitEntityUrnV2('agent', node.inheritedFrom.agentUrn)}`);
    if (childMemoryUrn) lines.push(`  Read through: ${safeNodeUrnV2(childMemoryUrn, node.loc)}`);
  }
  return lines;
}

/** The bare URN of the Agent's system memory, for the Read through line. */
async function systemMemoryUrn(db: PrismaClient, agentId: string): Promise<string | null> {
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { systemMemoryId: true } });
  if (!agent?.systemMemoryId) return null;
  return (await db.memory.findUnique({ where: { id: agent.systemMemoryId }, select: { urn: true } }))?.urn ?? null;
}

export function registerAgentDefinitionTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const agentRef = z.string().min(1).describe('The Agent: its ID or fully-qualified URN (hrn:agent:<root>:<slug>).');

  server.tool(
    'hadron_agent_tasks',
    "List an Agent's tasks (cor:dmo:050:15): every runnable node in its effective system memory, across its base chain, and every task the tasks index (Agent.tasksIndexRef) of an Agent in the chain lists, each once. A task an index lists carries that edge's name as its Trigger; a task no index lists has none. A base's task keeps its own URN and says which Agent it is inherited from. Readable by whoever may read the Agent's system memory. Returns the same list as GraphQL agentTaskList. To act on a task, follow the Trigger that matches your situation and read the task by its URN; for an inherited one, read it at its 'Read through' address (the same loc in this Agent's own system memory), since you may be able to read the Agent and not its base.",
    { agentRef },
    async ({ agentRef: ref }) => {
      try {
        const { id } = await resolveAgentRef(db, ref);
        const entries = await listAgentTasks(db, auth, id, ref);
        if (entries.length === 0) return textResult(`No tasks for Agent ${ref}.`);
        const urns = await nodeUrns(db, entries.map((e) => e.node));
        const child = await systemMemoryUrn(db, id);
        const lines = [`${entries.length} task(s) for Agent ${ref}:`];
        for (const e of entries) {
          lines.push(...entryLines(e.node, urns.get(e.node.id)!, e.trigger ? [`Trigger: ${e.trigger}`] : [], child));
        }
        return textResult(lines.join('\n'));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.tool(
    'hadron_agent_processes',
    "List an Agent's processes (cor:dmo:050:16): the ones it starts or owns, listed in its processes index (Agent.processesIndexRef) with each edge's Trigger, then the ones it's involved in, derived from stage edges (named 'stage …') to one of its tasks, which carry no trigger. Each is listed once, with its Kind. Same gate as hadron_agent_tasks; returns the same list as GraphQL agentProcessList. A base's process the Agent inherits says 'Inherited from' and gives a 'Read through' address in this Agent's own system memory.",
    { agentRef },
    async ({ agentRef: ref }) => {
      try {
        const { id } = await resolveAgentRef(db, ref);
        const entries = await listAgentProcesses(db, auth, id, ref);
        if (entries.length === 0) return textResult(`No processes for Agent ${ref}.`);
        const urns = await nodeUrns(db, entries.map((e) => e.node));
        const child = await systemMemoryUrn(db, id);
        const lines = [`${entries.length} process(es) for Agent ${ref}:`];
        for (const e of entries) {
          const extra = [`Kind: ${e.kind === 'STARTS' ? 'starts or owns' : 'involved'}`];
          if (e.trigger) extra.push(`Trigger: ${e.trigger}`);
          lines.push(...entryLines(e.node, urns.get(e.node.id)!, extra, child));
        }
        return textResult(lines.join('\n'));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const indexRef = (which: 'tasks' | 'processes', spec: string) => z.string().min(1).nullable().optional().describe(
    `The ${which}-index node (${spec}): its ID or fully-qualified URN. Omit it to leave the pointer as it is; ` +
    'null clears it. The node must be live and readable to you, or the call is refused as NODE_NOT_FOUND.',
  );

  /** A pointer as the caller may see it: the node's URN when its memory is readable to them, else the bare id GraphQL returns. */
  const pointer = async (nodeId: string | null): Promise<string> => {
    if (!nodeId) return 'none';
    const node = await db.node.findUnique({ where: { id: nodeId }, select: { id: true, memoryId: true, loc: true, name: true } });
    if (!node || !(await canReadMemory(db, auth, node.memoryId, EXPLICIT_REF))) return nodeId;
    return (await nodeUrns(db, [node as ListedNode])).get(node.id)!;
  };

  server.tool(
    'hadron_agent_set_base',
    "Set, change or clear an Agent's base (cor:dmo:050:14): the one Agent it extends and inherits from (Agent.extendsAgentId). Pass the base's ID or URN to set or change it, or null to clear it. Only whoever manages the Agent may change its base; managing the base is not enough. Refusals, in this order: for the Agent you're changing, AGENT_NOT_FOUND when it doesn't exist, is retired, or is one you can't read (an Agent you can't read is never confirmed to exist), and FORBIDDEN when you can read it but don't manage it; for the base, AGENT_NOT_FOUND when it doesn't exist, is retired, or is one you hold no licence to; then AGENT_ORG_GRANT_REQUIRED, AGENT_ORG_GRANT_INACTIVE or AGENT_SUBSCRIPTION_REQUIRED (extending another organisation's Agent needs the grant a cross-organisation include needs); then AGENT_BASE_CYCLE (an Agent can't extend itself or an Agent that extends it) and AGENT_BASE_CHAIN_TOO_LONG (at most 4 Agents in a chain, counting every Agent that already extends this one). The same mutation as GraphQL setAgentBase. Read what it now inherits with hadron_agent_tasks / hadron_agent_processes.",
    {
      agentRef: agentRef.describe('The Agent whose base to change (the child): its ID or fully-qualified URN (hrn:agent:<root>:<slug>).'),
      baseRef: z.string().min(1).nullable().describe('The base Agent: its ID or fully-qualified URN. null clears the base. Required, so leaving it out never clears one by accident.'),
    },
    async ({ agentRef: ref, baseRef }) => {
      try {
        const agent = await M.setAgentBase({}, { ref, baseRef }, contextOf(db, auth));
        const base = agent.extendsAgentId
          ? await db.agent.findUnique({ where: { id: agent.extendsAgentId }, select: { urn: true } })
          : null;
        return textResult([
          `Agent ${emitEntityUrnV2('agent', agent.urn)} (id: ${agent.id})`,
          `Base: ${base ? emitEntityUrnV2('agent', base.urn) : 'none'}`,
        ].join('\n'));
      } catch (e) {
        return refusalResult(e);
      }
    },
  );

  server.tool(
    'hadron_agent_set_index_refs',
    "Set or clear an Agent's tasks-index and processes-index pointers (cor:dmo:050:15, :16; Agent.tasksIndexRef and Agent.processesIndexRef). The index node's incoming edges, named for their trigger, are what hadron_agent_tasks and hadron_agent_processes list as Triggers. Each pointer has three states: omit it to leave it as it is, pass null to clear it, or pass a node's ID or URN to set it. Only whoever manages the Agent may change them. Refusals: AGENT_NOT_FOUND when the Agent doesn't exist, is retired, or is one you can't read, FORBIDDEN when you can read it but don't manage it, and NODE_NOT_FOUND for an index node that doesn't exist or that you can't read. The same mutation as GraphQL setAgentIndexRefs.",
    {
      agentRef,
      tasksIndexRef: indexRef('tasks', 'cor:dmo:050:15'),
      processesIndexRef: indexRef('processes', 'cor:dmo:050:16'),
    },
    async ({ agentRef: ref, tasksIndexRef, processesIndexRef }) => {
      try {
        // Only what the caller passed: an omitted pointer stays omitted, so the
        // resolver leaves it as it is.
        const agent = await M.setAgentIndexRefs({}, {
          ref,
          ...(tasksIndexRef !== undefined ? { tasksIndexRef } : {}),
          ...(processesIndexRef !== undefined ? { processesIndexRef } : {}),
        }, contextOf(db, auth));
        return textResult([
          `Agent ${emitEntityUrnV2('agent', agent.urn)} (id: ${agent.id})`,
          `Tasks index: ${await pointer(agent.tasksIndexRef)}`,
          `Processes index: ${await pointer(agent.processesIndexRef)}`,
        ].join('\n'));
      } catch (e) {
        return refusalResult(e);
      }
    },
  );
}
