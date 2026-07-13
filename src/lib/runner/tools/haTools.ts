/**
 * Dynamic run tools backed by REGISTERED HOME ASSISTANT INSTANCES (the
 * hadrontool-home-assistant tool). The static registry in index.ts covers
 * built-in `hadron_*` tools; anything named `ha__<slug>__<op>` resolves
 * here instead — against the run org's HomeAssistantInstance rows and the
 * CLOSED op catalog in src/lib/homeAssistant.ts (no live tools/list; the
 * defs are static, which is the whole point: deterministic passthroughs,
 * no per-call LLM mediation).
 *
 * Governance is UNCHANGED from built-ins: the kernel gates every call via
 * checkActivation('tool.ha__<slug>__<op>') and every call costs 1 action
 * (Holger 2026-07-12: actions only in v1 — even reads, matching the
 * external-side-effects posture of mcpTools).
 */

import type { PrismaClient, AppRun, HomeAssistantInstance } from '../../../generated/prisma/index.js';
import { GraphQLError } from 'graphql';
import { callHaOp } from '../../haToolClient.js';
import {
  decryptHaAccessToken,
  haOpAllowed,
  haOpDef,
  parseHaRunToolName,
  HA_RUN_TOOL_PREFIX,
  MAX_HA_RUN_TOOL_NAME_LENGTH,
} from '../../homeAssistant.js';
import type { RunToolDef } from './types.js';

/** Cap on the serialized result handed to the LLM — core's own ceiling on
 *  top of the tool's per-op bounding (a 500-entity states payload is
 *  legal tool-side but must not inflate a hop's context unbounded). */
const MAX_RESULT_LENGTH = 60_000;

/** Tool-level HA failures the LLM should SEE and adapt to (wrong entity
 *  id → list_states; template error → fix the template). Everything else
 *  (unreachable, timeout, auth, network policy, not-configured) is an
 *  operator problem → thrown → TOOL_FAILED. */
const LLM_VISIBLE_HA_ERRORS = new Set(['ha_not_found', 'ha_error', 'validation_error']);

/** True when a `data.tools` entry belongs to this dynamic namespace. */
export function isHaRunToolName(name: string): boolean {
  return name.startsWith(HA_RUN_TOOL_PREFIX);
}

/** Load the org's registered instances for a set of slugs. Disabled rows
 *  are dropped (same as unregistered — resolution fails loud on the name). */
async function loadInstances(
  db: PrismaClient,
  organizationId: string,
  slugs: string[],
): Promise<Map<string, HomeAssistantInstance>> {
  if (slugs.length === 0) return new Map();
  const rows = await db.homeAssistantInstance.findMany({
    where: { organizationId, slug: { in: [...new Set(slugs)] }, enabled: true },
  });
  return new Map(rows.map((r) => [r.slug, r]));
}

/**
 * Registration-level validation for loadNodeSpec (D-TL-6: unknown names
 * fail the hop LOUD before any LLM call). Checks grammar, the closed op
 * catalog, a live+enabled registration in the RUN's org, the op
 * allowlist, and the name-length cap. Everything is knowable locally —
 * no tool round-trip (the catalog is static).
 */
export async function unknownHaToolNames(
  db: PrismaClient,
  organizationId: string,
  names: string[],
): Promise<string[]> {
  const parsed = names.map((name) => ({ name, parts: parseHaRunToolName(name) }));
  const instances = await loadInstances(
    db,
    organizationId,
    parsed.flatMap((p) => (p.parts ? [p.parts.slug] : [])),
  );
  return parsed
    .filter(({ name, parts }) => {
      if (!parts || name.length > MAX_HA_RUN_TOOL_NAME_LENGTH || !haOpDef(parts.op)) return true;
      const instance = instances.get(parts.slug);
      return !instance || !haOpAllowed(instance, parts.op);
    })
    .map(({ name }) => name);
}

/**
 * Materialize RunToolDefs for the ha__ names on a hop — static defs from
 * the catalog, no upstream round-trip. A row deleted or disabled between
 * loadNodeSpec and this hop fails loud (the mcpTools posture).
 */
export async function materializeHaRunTools(
  db: PrismaClient,
  run: AppRun,
  names: string[],
): Promise<RunToolDef[]> {
  const parsed = names.map((name) => {
    const parts = parseHaRunToolName(name);
    if (!parts) throw new Error(`Malformed Home Assistant tool name "${name}".`);
    return { name, ...parts };
  });
  const instances = await loadInstances(db, run.organizationId, parsed.map((p) => p.slug));

  return parsed.map(({ name, slug, op }) => {
    const instance = instances.get(slug);
    if (!instance) {
      throw new Error(`Home Assistant instance "${slug}" is not registered (or disabled) for this organization.`);
    }
    const def = haOpDef(op);
    if (!def) throw new Error(`Unknown Home Assistant op "${op}" in "${name}".`);
    if (!haOpAllowed(instance, op)) {
      throw new Error(`Op "${op}" is not in the allowlist of Home Assistant instance "${slug}".`);
    }
    return {
      name,
      description: `[Home Assistant "${instance.name}"] ${def.description}`,
      inputSchema: def.inputSchema,
      cost: 1,
      execute: async (ctx, args) => {
        try {
          const payload = await callHaOp(
            { url: instance.url, accessToken: decryptHaAccessToken(instance) },
            def.route,
            args ?? {},
          );
          const text = JSON.stringify(payload);
          return {
            result:
              text.length > MAX_RESULT_LENGTH
                ? `${text.slice(0, MAX_RESULT_LENGTH)}…[truncated by hadron-server]`
                : text,
          };
        } catch (err) {
          // ha_not_found / ha_error / validation_error are author-facing:
          // the LLM should see them and adapt. Operator-level failures
          // (unreachable, timeout, auth, network policy) rethrow →
          // TOOL_FAILED, matching the mcpTools transport/tool split.
          const haErrorCode =
            err instanceof GraphQLError ? (err.extensions?.haErrorCode as string | undefined) : undefined;
          if (haErrorCode && LLM_VISIBLE_HA_ERRORS.has(haErrorCode)) {
            ctx.log(`${name}: ${haErrorCode}`);
            return { isError: true, error: err instanceof Error ? err.message : String(err) };
          }
          throw err;
        }
      },
    } satisfies RunToolDef;
  });
}
