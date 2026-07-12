/**
 * Dynamic run tools backed by REGISTERED EXTERNAL MCP SERVERS (the
 * hadrontool-mcp conduit). The static registry in index.ts covers built-in
 * `hadron_*` tools; anything named `mcp__<slug>__<tool>` resolves here
 * instead — against the run org's McpServer rows and a live `tools/list`
 * from the conduit at hop start.
 *
 * Governance is UNCHANGED from built-ins: the kernel gates every call via
 * checkActivation('tool.mcp__<slug>__<tool>') and every call costs 1
 * action (an external tool's side effects are unknowable, so no cost-0
 * reads here — a retry after one of these ran is never assumed safe).
 *
 * Trust posture: upstream descriptions, schemas, and results are
 * THIRD-PARTY CONTENT entering the LLM context. v1 admits them verbatim
 * (bounded) — the org admin's registration + allowlist is the trust
 * decision; tool-definition pinning is a known follow-up.
 */

import type { PrismaClient, AppRun, McpServer } from '../../../generated/prisma/index.js';
import { listMcpTools, callMcpTool } from '../../mcpToolClient.js';
import {
  decryptMcpHeaders,
  mcpToolAllowed,
  parseMcpRunToolName,
  MAX_MCP_DESCRIPTION_LENGTH,
  MAX_RUN_TOOL_NAME_LENGTH,
  MCP_RUN_TOOL_PREFIX,
} from '../../mcpServers.js';
import type { RunToolDef } from './types.js';

/** Cap on the total flattened result text handed to the LLM. The conduit
 *  bounds per-block (200k) and per-count (100); this is core's own ceiling
 *  so a rogue payload can never inflate a hop's context unbounded. */
const MAX_FLATTENED_RESULT_LENGTH = 100_000;

/** True when a `data.tools` entry belongs to this dynamic namespace. */
export function isMcpRunToolName(name: string): boolean {
  return name.startsWith(MCP_RUN_TOOL_PREFIX);
}

/**
 * Load the org's registered servers for a set of mcp__ names, keyed by
 * slug. Disabled rows are dropped (same as unregistered — resolution
 * fails loud on the name).
 */
async function loadServers(
  db: PrismaClient,
  organizationId: string,
  slugs: string[],
): Promise<Map<string, McpServer>> {
  if (slugs.length === 0) return new Map();
  const rows = await db.mcpServer.findMany({
    where: { organizationId, slug: { in: [...new Set(slugs)] }, enabled: true },
  });
  return new Map(rows.map((r) => [r.slug, r]));
}

/**
 * Registration-level validation for loadNodeSpec (D-TL-6: unknown names
 * fail the hop LOUD before any LLM call). Checks grammar, a live+enabled
 * registration in the RUN's org, the allowlist, and the provider name-length
 * cap — everything knowable without calling the conduit. Whether the
 * external server still advertises the tool is checked at materialization.
 */
export async function unknownMcpToolNames(
  db: PrismaClient,
  organizationId: string,
  names: string[],
): Promise<string[]> {
  const parsed = names.map((name) => ({ name, parts: parseMcpRunToolName(name) }));
  const servers = await loadServers(
    db,
    organizationId,
    parsed.flatMap((p) => (p.parts ? [p.parts.slug] : [])),
  );
  return parsed
    .filter(({ name, parts }) => {
      if (!parts || name.length > MAX_RUN_TOOL_NAME_LENGTH) return true;
      const server = servers.get(parts.slug);
      return !server || !mcpToolAllowed(server, parts.tool);
    })
    .map(({ name }) => name);
}

/** Flatten an MCP content-block array to the text the LLM sees. Blocks are
 *  THIRD-PARTY payload — null/primitive elements must degrade, not crash
 *  the hop (PR-634 review, Gemini + Copilot). */
function flattenContent(content: Array<Record<string, unknown>>): string {
  const parts = content.map((block) => {
    const isObject = block !== null && typeof block === 'object' && !Array.isArray(block);
    if (isObject && block.type === 'text' && typeof block.text === 'string') return block.text;
    // Non-text blocks (image/audio/resource) have no v1 rendering path
    // into a run hop — surface their presence instead of dropping them.
    const typeLabel = isObject && typeof block.type === 'string' ? block.type : 'unknown';
    return `[unsupported ${typeLabel} content omitted]`;
  });
  const text = parts.join('\n');
  return text.length > MAX_FLATTENED_RESULT_LENGTH
    ? `${text.slice(0, MAX_FLATTENED_RESULT_LENGTH)}\n[truncated by hadron-server]`
    : text;
}

/**
 * Materialize RunToolDefs for the mcp__ names on a hop: one live
 * `tools/list` per referenced server (via the conduit), then a proxy def
 * per name. A name whose tool the server no longer advertises throws —
 * running the hop without a declared tool would silently change semantics
 * (the D-TL-8 posture).
 */
export async function materializeMcpRunTools(
  db: PrismaClient,
  run: AppRun,
  names: string[],
): Promise<RunToolDef[]> {
  const parsed = names.map((name) => {
    const parts = parseMcpRunToolName(name);
    if (!parts) throw new Error(`Malformed MCP tool name "${name}".`);
    return { name, ...parts };
  });
  const servers = await loadServers(db, run.organizationId, parsed.map((p) => p.slug));

  const upstreamBySlug = new Map<string, Map<string, { description?: string; inputSchema: Record<string, unknown> }>>();
  // One live tools/list per referenced server, in parallel — a multi-server
  // node must not pay the timeouts sequentially (PR-634 review, Gemini).
  await Promise.all(
    [...new Set(parsed.map((p) => p.slug))].map(async (slug) => {
      const server = servers.get(slug);
      // loadNodeSpec validated registration, but a row can be deleted or
      // disabled between validation and this hop — same loud failure.
      if (!server) throw new Error(`MCP server "${slug}" is not registered (or disabled) for this organization.`);
      const tools = await listMcpTools({ url: server.url, headers: decryptMcpHeaders(server) });
      upstreamBySlug.set(slug, new Map(tools.map((t) => [t.name, t])));
    }),
  );

  return parsed.map(({ name, slug, tool }) => {
    const server = servers.get(slug)!;
    if (!mcpToolAllowed(server, tool)) {
      throw new Error(`Tool "${tool}" is not in the allowlist of MCP server "${slug}".`);
    }
    const upstream = upstreamBySlug.get(slug)!.get(tool);
    if (!upstream) {
      throw new Error(`MCP server "${slug}" does not advertise a tool named "${tool}".`);
    }
    return {
      name,
      description:
        `[External tool on MCP server "${server.name}"] ` +
        (upstream.description ?? '').slice(0, MAX_MCP_DESCRIPTION_LENGTH),
      inputSchema: upstream.inputSchema,
      cost: 1,
      execute: async (ctx, args) => {
        const result = await callMcpTool(
          { url: server.url, headers: decryptMcpHeaders(server) },
          tool,
          args ?? {},
        );
        const text = flattenContent(result.content);
        // MCP semantics: isError is a TOOL-level failure the LLM should
        // see and adapt to — only transport/protocol failures (thrown by
        // callMcpTool) become TOOL_FAILED.
        if (result.isError) {
          ctx.log(`${name}: upstream tool error`);
          return { isError: true, error: text || 'The external tool reported an error.' };
        }
        return { result: text };
      },
    } satisfies RunToolDef;
  });
}
