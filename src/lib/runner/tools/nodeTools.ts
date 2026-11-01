/**
 * Node tools (plan-tools D-TL-2, phase 3): hadron_read_node /
 * hadron_create_node / hadron_update_node — the first tools a flow's LLM
 * can call to ACT on the graph, under the run principal. Names follow the
 * MCP convention (locked); the write tools carry FULL MCP arg parity
 * (Holger review 2026-07-07 — e.g. `seq` so an appended chat message gets
 * explicit ordering).
 *
 * Every handler inherits the flow guards via resolveFlowMemory: same-org
 * only, encrypted memories denied. Writes go through writeNodeCore under
 * ctx.principal, so the memory class gates apply unchanged — a run with
 * no on-behalf-of user cannot touch personal/private memories.
 */

import { writeNodeCore } from '../../../api/graphql/schema/resolvers.mutation.node.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { splitNodeUrn } from '../../urn.js';
import { resolveFlowMemory, loadFlowNode } from '../loadFlowNode.js';
import type { RunToolDef, RunToolContext } from './types.js';

/** Shared arg schema for the write tools (full NodeInput parity, minus edges — v1). */
const WRITE_ARG_PROPERTIES = {
  urn: {
    type: 'string',
    description: 'Fully-qualified node URN (hrn:node:<root>:<memory>:<loc>). Same-org only.',
  },
  name: { type: 'string', description: 'Node display name.' },
  content: { type: 'string', description: 'Markdown content.' },
  nodeType: {
    type: 'string',
    description: 'Node classification (info, record, prompt, reference, …). Default: record.',
  },
  data: { type: 'object', description: 'Structured key-value data.' },
  seq: {
    type: 'number',
    description: 'Sort order among siblings (lower first) — set this when appending ordered items like chat messages.',
  },
  tags: { type: 'array', items: { type: 'string' } },
  description: { type: 'string', description: 'Short description.' },
  abstract: { type: 'string', description: 'Paragraph-length summary (max 2000 chars).' },
  properties: { type: 'object', description: 'Structured key-value properties.' },
  isRunnable: { type: 'boolean', description: 'Whether the node can be run as a task.' },
} as const;

const WRITE_FIELD_KEYS = [
  'name', 'content', 'nodeType', 'data', 'seq', 'tags',
  'description', 'abstract', 'properties', 'isRunnable',
] as const;

function pickWriteFields(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WRITE_FIELD_KEYS) {
    if (args[k] !== undefined) out[k] = args[k];
  }
  return out;
}

function principalAuth(ctx: RunToolContext): AuthContext {
  return {
    clientId: ctx.principal.clientId,
    userId: ctx.principal.userId,
    appId: ctx.principal.appId,
    organizationId: ctx.principal.organizationId,
  };
}

export const hadronReadNode: RunToolDef = {
  name: 'hadron_read_node',
  description:
    'Read a Hadron node by fully-qualified URN (hrn:node:<root>:<memory>:<loc>). Returns its name, ' +
    'content, and data. Same-organization nodes only.',
  inputSchema: {
    type: 'object',
    properties: { urn: WRITE_ARG_PROPERTIES.urn },
    required: ['urn'],
  },
  cost: 0, // reads are budget-free (D-TL-2)
  execute: async (ctx, args) => {
    const urn = String(args.urn ?? '');
    // Auth BEFORE the node fetch — an unauthorized caller must not be able
    // to probe node existence via error-message differences (PR-545 review,
    // Copilot). Memory resolution leaks nothing beyond org scoping.
    const { memoryUrn, loc } = splitNodeUrn(urn);
    const memory = await resolveFlowMemory(ctx.db, memoryUrn, ctx.run.organizationId, urn);
    if (!(await canReadMemory(ctx.db, principalAuth(ctx), memory.id))) {
      throw new Error(`Memory not readable for "${urn}" under the run principal.`);
    }
    const node = await ctx.db.node.findUnique({
      where: { loc_memoryId: { loc, memoryId: memory.id } },
      select: { name: true, content: true, data: true, deletedAt: true },
    });
    if (!node || node.deletedAt) throw new Error(`Flow node not found: "${urn}".`);
    return { urn, name: node.name, content: node.content, data: node.data };
  },
};

export const hadronCreateNode: RunToolDef = {
  name: 'hadron_create_node',
  description:
    'Create a new Hadron node at the given fully-qualified URN (hrn:node:<root>:<memory>:<loc>). ' +
    'Fails if a node already exists there — use hadron_update_node to change one. ' +
    'Set seq when appending ordered items of an ordinary node type. The default nodeType is record, and a record (or chat-message) outside a Channel refuses an explicit seq (SEQ_PROTECTED): seq is protected conversation order.',
  inputSchema: {
    type: 'object',
    properties: WRITE_ARG_PROPERTIES,
    required: ['urn', 'name'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const urn = String(args.urn ?? '');
    const { memoryUrn, loc } = splitNodeUrn(urn);
    const memory = await resolveFlowMemory(ctx.db, memoryUrn, ctx.run.organizationId, urn);
    // No pre-existence probe (PR-545 review, Copilot): writeNodeCore's own
    // create gate rejects live-loc collisions (NodeLocConflictError) and
    // resurrects soft-deleted ones — duplicating the check here would run
    // before its auth and leak node existence in unwritable memories.
    try {
      const written = await writeNodeCore(
        {
          memoryId: memory.id,
          loc,
          nodeType: 'record',
          ...pickWriteFields(args),
          reason: `run tool hadron_create_node (run ${ctx.run.id})`,
        } as never,
        ctx.principal,
        'create',
      );
      return { created: true, urn, id: written.id };
    } catch (err) {
      const code = (err as { extensions?: { code?: string } }).extensions?.code;
      if (code === 'NodeLocConflictError') {
        throw new Error(`Node already exists at "${urn}" — use hadron_update_node.`);
      }
      throw err;
    }
  },
};

export const hadronUpdateNode: RunToolDef = {
  name: 'hadron_update_node',
  description:
    'Update an existing Hadron node by fully-qualified URN. Only the fields you pass ' +
    'change; `data` merges shallowly into the existing data (your keys win, others stay).',
  inputSchema: {
    type: 'object',
    properties: WRITE_ARG_PROPERTIES,
    required: ['urn'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const urn = String(args.urn ?? '');
    const { memory, loc, node } = await loadFlowNode(ctx.db, urn, ctx.run.organizationId, principalAuth(ctx));
    const fields = pickWriteFields(args);
    if (fields.data !== undefined) {
      // The model controls this input — validate before spreading (PR-545
      // review, Copilot): null/array/scalar `data` is a loud tool error,
      // not a surprising merge.
      if (fields.data === null || typeof fields.data !== 'object' || Array.isArray(fields.data)) {
        throw new Error(`hadron_update_node: "data" must be a plain object (got ${Array.isArray(fields.data) ? 'array' : typeof fields.data}).`);
      }
      // Shallow merge, patch wins — hadron_update_node_data semantics.
      const existing =
        node.data !== null && typeof node.data === 'object' && !Array.isArray(node.data)
          ? (node.data as Record<string, unknown>)
          : {};
      fields.data = { ...existing, ...(fields.data as Record<string, unknown>) };
    }
    const written = await writeNodeCore(
      {
        memoryId: memory.id,
        loc,
        ...fields,
        reason: `run tool hadron_update_node (run ${ctx.run.id})`,
      } as never,
      ctx.principal,
      'update',
      { targetNodeId: node.id },
    );
    return { updated: true, urn, id: written.id };
  },
};

export const NODE_TOOLS: readonly RunToolDef[] = [hadronReadNode, hadronCreateNode, hadronUpdateNode];
