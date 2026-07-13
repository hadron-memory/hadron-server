import { GraphQLError } from 'graphql';
import { encryptToken, decryptToken } from './tokenCrypto.js';
import type { HomeAssistantInstance } from '../generated/prisma/index.js';

/**
 * Shared grammar + token crypto + the CLOSED op catalog for the Home
 * Assistant instance registry (hadrontool-home-assistant tool,
 * hadron-server#640). One module so the GraphQL surface and the run
 * kernel can never disagree about what `ha__<slug>__<op>` means — the
 * mcpServers.ts pattern.
 *
 * The run-tool name doubles as the LLM-facing tool name AND the policy
 * action suffix (`tool.ha__<slug>__<op>` through checkActivation), so it
 * must satisfy the strictest provider tool-name rule:
 * ^[a-zA-Z0-9_-]{1,64}$ (Anthropic). Slugs therefore exclude underscores —
 * the first `__` after the prefix is unambiguous as the separator.
 *
 * UNLIKE the MCP conduit there is no live tools/list: the ops are a
 * closed, curated catalog defined HERE, mirrored by the tool's /ops/*
 * routes. Ship both sides together (see the tool repo's CLAUDE.md).
 */

export const HA_RUN_TOOL_PREFIX = 'ha__';

/** Registry slug: lowercase, no underscores (the `__` separator depends on it). */
export const HA_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** Provider tool-name length cap (Anthropic's 64 is the strictest). */
export const MAX_HA_RUN_TOOL_NAME_LENGTH = 64;

/** One entry of the closed op catalog. */
export interface HaOpDef {
  /** Op segment of the run-tool name (`ha__<slug>__<op>`), snake_case. */
  op: string;
  /** The tool's /ops/<route> path segment. */
  route: string;
  description: string;
  /** JSON Schema for the LLM-facing arguments (curated subset, D15 posture). */
  inputSchema: Record<string, unknown>;
}

/**
 * The closed op catalog — everything a flow node can declare against a
 * registered instance. Adding an op means adding the tool-side route in
 * the same release. Every op costs 1 action (Holger, 2026-07-12: actions
 * only in v1; even reads, matching the external-side-effects posture of
 * mcpTools).
 */
export const HA_OPS: readonly HaOpDef[] = [
  {
    op: 'call_service',
    route: 'call-service',
    description:
      'Call a Home Assistant service — the universal action primitive ' +
      '(automation.trigger, light.turn_on, notify.*, script.*, …). ' +
      'serviceData carries the service fields, e.g. {"entity_id": "light.desk"}.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Service domain, e.g. "light" or "automation".' },
        service: { type: 'string', description: 'Service name, e.g. "turn_on" or "trigger".' },
        serviceData: {
          type: 'object',
          description: 'Service fields, typically including entity_id.',
        },
      },
      required: ['domain', 'service'],
    },
  },
  {
    op: 'get_state',
    route: 'get-state',
    description: 'Read one entity\'s current state and attributes, e.g. "binary_sensor.office_occupancy".',
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string', description: 'Entity id, "domain.object_id".' },
      },
      required: ['entityId'],
    },
  },
  {
    op: 'list_states',
    route: 'list-states',
    description:
      'List entity states, filtered by domain (e.g. "light") and/or explicit entity ids. ' +
      'Bounded at 500 states — prefer a filter, or render_template for aggregate questions.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Only entities of this domain.' },
        entityIds: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 100,
          description: 'Only these entity ids (max 100).',
        },
      },
    },
  },
  {
    op: 'render_template',
    route: 'render-template',
    description:
      'Evaluate a Home Assistant Jinja template against live state — the token-efficient ' +
      "read (e.g. \"{{ states('sensor.outside_temperature') }}\" or a loop over areas).",
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'The Jinja template to render.' },
      },
      required: ['template'],
    },
  },
  {
    op: 'fire_event',
    route: 'fire-event',
    description:
      'Fire a custom event on the Home Assistant event bus (e.g. "hadron_attention") — ' +
      "the decoupled actuation path: the user's own HA automations decide what it means.",
    inputSchema: {
      type: 'object',
      properties: {
        eventType: { type: 'string', description: 'Event type, lowercase snake_case.' },
        eventData: { type: 'object', description: 'Arbitrary JSON event payload.' },
      },
      required: ['eventType'],
    },
  },
  {
    op: 'list_services',
    route: 'list-services',
    description:
      'Discover available services (domain/service/description), optionally filtered by domain.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Only services of this domain.' },
      },
    },
  },
];

/** Catalog lookup by op segment. */
export function haOpDef(op: string): HaOpDef | undefined {
  return HA_OPS.find((d) => d.op === op);
}

/** Compose the run-tool / policy name for one op. */
export function haRunToolName(slug: string, op: string): string {
  return `${HA_RUN_TOOL_PREFIX}${slug}__${op}`;
}

/**
 * Split a run-tool name back into (slug, op). Null when the name is not
 * `ha__`-prefixed (i.e. it belongs to another registry) OR is malformed —
 * callers treat malformed as unknown-tool, fail-loud. Whether the op is
 * in the catalog is the caller's check (haOpDef).
 */
export function parseHaRunToolName(name: string): { slug: string; op: string } | null {
  const m = /^ha__([a-z0-9][a-z0-9-]*)__([a-z_]+)$/.exec(name);
  return m ? { slug: m[1], op: m[2] } : null;
}

/** True when an op is admitted by a row's allowlist (empty = all). */
export function haOpAllowed(row: Pick<HomeAssistantInstance, 'opAllowlist'>, op: string): boolean {
  return row.opAllowlist.length === 0 || row.opAllowlist.includes(op);
}

const MAX_TOKEN_LENGTH = 8192;

/**
 * Validate a caller-supplied long-lived access token and encrypt it for
 * the `tokenEncrypted` column. The token is a secret, so this is the ONLY
 * write path and there is deliberately no read path back to the API
 * surface (the McpServer headers posture).
 */
export function encryptHaAccessToken(raw: string): string {
  const token = raw.trim();
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || /[\r\n\s]/.test(token)) {
    throw new GraphQLError('accessToken must be a single non-empty token without whitespace.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return encryptToken(token);
}

/** Decrypt a row's access token for a tool call. */
export function decryptHaAccessToken(row: Pick<HomeAssistantInstance, 'tokenEncrypted'>): string {
  return decryptToken(row.tokenEncrypted);
}

/** Validate a registered instance URL: absolute http(s), no credentials. */
export function validateHaInstanceUrl(raw: string): void {
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
    throw new GraphQLError('url must not embed credentials — use accessToken.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  // A BASE url only — the tool composes /api/* paths onto it, and would
  // silently drop a query/fragment (haFetch uses origin+pathname), so
  // reject at registration rather than store something misleading.
  if (parsed.search || parsed.hash) {
    throw new GraphQLError('url must be a base URL without query parameters or fragments.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}

/** Validate an opAllowlist against the closed catalog; returns the cleaned list. */
export function validateHaOpAllowlist(list: string[]): string[] {
  const cleaned = [...new Set(list.map((t) => t.trim()).filter((t) => t.length > 0))];
  const unknown = cleaned.filter((op) => !haOpDef(op));
  if (unknown.length > 0) {
    throw new GraphQLError(
      `Unknown op(s) in opAllowlist: ${unknown.join(', ')}. Valid: ${HA_OPS.map((d) => d.op).join(', ')}.`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
  return cleaned;
}
