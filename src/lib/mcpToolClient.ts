import { GraphQLError } from 'graphql';

/**
 * Client for the generic MCP conduit tool (hadrontool-mcp). Mirrors
 * slackClient.ts / emailClient.ts: hadron-server stays the front door —
 * the policy chain, grants, and org gates have all run before anything
 * here is called — and this module only ships already-authorized requests
 * to the internal conduit, which speaks MCP to the registered external
 * server per request (stateless; no sessions survive a call).
 *
 * Configured by env:
 *   MCP_TOOL_URL    e.g. http://hadrontool-mcp:8080 (required)
 *   MCP_TOOL_TOKEN  shared bearer token (optional; sent when set)
 *
 * Error surface: MCP_TOOL_NOT_CONFIGURED / MCP_TOOL_UNREACHABLE /
 * MCP_TOOL_ERROR as GraphQL extensions.code — plus pass-through of the
 * conduit's own typed codes (upstream_unreachable, upstream_timeout,
 * upstream_protocol_error, private_network_blocked, not_found,
 * validation_error) via extensions.mcpErrorCode.
 */

const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

/** The registered external server a request is aimed at. */
export interface McpUpstreamTarget {
  /** Streamable-HTTP MCP endpoint URL. */
  url: string;
  /** Decrypted static request headers (v1 auth posture). */
  headers?: Record<string, string>;
}

/** One tool as the external server advertises it (MCP `tools/list`). */
export interface McpToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments, passed through verbatim. */
  inputSchema: Record<string, unknown>;
}

/** MCP `tools/call` result, unflattened: content blocks + the isError flag. */
export interface McpToolCallResult {
  isError: boolean;
  content: Array<Record<string, unknown>>;
}

function conduit(): { baseUrl: string; token?: string } {
  const baseUrl = process.env.MCP_TOOL_URL;
  if (!baseUrl) {
    throw new GraphQLError('External MCP servers are not configured (MCP_TOOL_URL unset).', {
      extensions: { code: 'MCP_TOOL_NOT_CONFIGURED' },
    });
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token: process.env.MCP_TOOL_TOKEN || undefined };
}

/** POST a JSON body to the conduit with timeout + typed error mapping. */
async function postToConduit<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const { baseUrl, token } = conduit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // The body read stays INSIDE the timeout window (slackClient posture).
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err; // timed out mid-body → outer catch
      payload = null;
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new GraphQLError(timedOut ? 'MCP conduit timed out.' : 'MCP conduit is unreachable.', {
      extensions: { code: 'MCP_TOOL_UNREACHABLE', cause: String(err) },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const mcpErrorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    const message =
      typeof payload?.message === 'string' ? payload.message.slice(0, 500) : `MCP conduit error (${res.status}).`;
    throw new GraphQLError(message, {
      extensions: {
        code: 'MCP_TOOL_ERROR',
        ...(mcpErrorCode ? { mcpErrorCode } : {}),
        status: res.status,
      },
    });
  }

  if (!payload) {
    throw new GraphQLError('MCP conduit returned an unexpected response.', {
      extensions: { code: 'MCP_TOOL_ERROR' },
    });
  }
  return payload as T;
}

/**
 * List the tools an external MCP server advertises. Shape-validated: a
 * tool without a string name is dropped rather than poisoning downstream
 * run-tool materialization.
 */
export async function listMcpTools(target: McpUpstreamTarget): Promise<McpToolDefinition[]> {
  const payload = await postToConduit<{ tools?: unknown }>(
    '/ops/list-tools',
    { url: target.url, ...(target.headers ? { headers: target.headers } : {}) },
    LIST_TIMEOUT_MS,
  );
  if (!Array.isArray(payload.tools)) {
    throw new GraphQLError('MCP conduit returned an invalid tool list.', {
      extensions: { code: 'MCP_TOOL_ERROR' },
    });
  }
  return (payload.tools as Array<Record<string, unknown>>)
    .filter((t) => t && typeof t.name === 'string' && (t.name as string).length > 0)
    .map((t) => ({
      name: t.name as string,
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      inputSchema:
        t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
          ? (t.inputSchema as Record<string, unknown>)
          : { type: 'object', properties: {} },
    }));
}

/**
 * Invoke one tool on an external MCP server. `isError: true` is a TOOL-level
 * error the calling LLM should see (standard MCP semantics) — only transport
 * and protocol failures throw.
 */
export async function callMcpTool(
  target: McpUpstreamTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolCallResult> {
  const payload = await postToConduit<{ isError?: unknown; content?: unknown }>(
    '/ops/call-tool',
    { url: target.url, ...(target.headers ? { headers: target.headers } : {}), name, arguments: args },
    CALL_TIMEOUT_MS,
  );
  return {
    isError: payload.isError === true,
    content: Array.isArray(payload.content) ? (payload.content as Array<Record<string, unknown>>) : [],
  };
}
