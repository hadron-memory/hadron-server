import { GraphQLError } from 'graphql';
import { encryptToken, decryptToken } from './tokenCrypto.js';
import type { McpServer } from '../generated/prisma/index.js';

/**
 * Shared grammar + header crypto for the external-MCP-server registry
 * (hadrontool-mcp conduit). One module so the GraphQL surface and the run
 * kernel can never disagree about what `mcp__<slug>__<tool>` means.
 *
 * The run-tool name doubles as the LLM-facing tool name AND the policy
 * action suffix (`tool.mcp__<slug>__<tool>` through checkActivation), so
 * it must satisfy the strictest provider tool-name rule:
 * ^[a-zA-Z0-9_-]{1,64}$ (Anthropic). Slugs therefore exclude underscores —
 * `__` is unambiguous as the separator.
 */

export const MCP_RUN_TOOL_PREFIX = 'mcp__';

/** Registry slug: lowercase, no underscores (the `__` separator depends on it). */
export const MCP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** Upstream tool names we can expose (provider tool-name charset). */
export const MCP_UPSTREAM_TOOL_RE = /^[a-zA-Z0-9_-]+$/;

/** Provider tool-name length cap (Anthropic's 64 is the strictest). */
export const MAX_RUN_TOOL_NAME_LENGTH = 64;

/** Cap on an upstream tool description — third-party content that enters
 *  prompts (runner) and GraphQL responses (browse); one cap for both. */
export const MAX_MCP_DESCRIPTION_LENGTH = 1024;

/** Compose the run-tool / policy name for one upstream tool. */
export function mcpRunToolName(slug: string, tool: string): string {
  return `${MCP_RUN_TOOL_PREFIX}${slug}__${tool}`;
}

/**
 * Split a run-tool name back into (slug, upstream tool). Null when the name
 * is not `mcp__`-prefixed (i.e. it belongs to the static builtin registry)
 * OR is malformed — callers treat malformed as unknown-tool, fail-loud.
 */
export function parseMcpRunToolName(name: string): { slug: string; tool: string } | null {
  const m = /^mcp__([a-z0-9][a-z0-9-]*)__([A-Za-z0-9_-]+)$/.exec(name);
  return m ? { slug: m[1], tool: m[2] } : null;
}

/** True when an upstream tool is admitted by a row's allowlist (empty = all). */
export function mcpToolAllowed(row: Pick<McpServer, 'toolAllowlist'>, tool: string): boolean {
  return row.toolAllowlist.length === 0 || row.toolAllowlist.includes(tool);
}

const MAX_HEADER_COUNT = 20;
const MAX_HEADER_NAME = 128;
const MAX_HEADER_VALUE = 4096;

/**
 * Validate a caller-supplied static-header object and encrypt it for the
 * `headersEncrypted` column. Header values are secrets (the v1 auth story
 * is `Authorization: Bearer …`), so this is the ONLY write path and there
 * is deliberately no read path back to the API surface.
 */
export function encryptMcpHeaders(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new GraphQLError('headers must be a JSON object of string values.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_HEADER_COUNT) {
    throw new GraphQLError(`headers must have 1-${MAX_HEADER_COUNT} entries.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  for (const [name, value] of entries) {
    if (
      typeof value !== 'string' ||
      name.length === 0 ||
      name.length > MAX_HEADER_NAME ||
      value.length > MAX_HEADER_VALUE ||
      // Token charset per RFC 9110 field-name; CR/LF in values would be
      // request splitting — reject rather than sanitize.
      !/^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/.test(name) ||
      /[\r\n]/.test(value)
    ) {
      throw new GraphQLError(`Invalid header "${name}".`, { extensions: { code: 'BAD_USER_INPUT' } });
    }
  }
  return encryptToken(JSON.stringify(Object.fromEntries(entries)));
}

/** Decrypt a row's static headers for a conduit call. Undefined when none. */
export function decryptMcpHeaders(row: Pick<McpServer, 'headersEncrypted'>): Record<string, string> | undefined {
  if (!row.headersEncrypted) return undefined;
  return JSON.parse(decryptToken(row.headersEncrypted)) as Record<string, string>;
}

/** Validate a registered endpoint URL: absolute http(s), no credentials. */
export function validateMcpServerUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GraphQLError('url must be an absolute URL.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GraphQLError('url must be http(s).', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  if (parsed.username || parsed.password) {
    throw new GraphQLError('url must not embed credentials — use headers.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}
