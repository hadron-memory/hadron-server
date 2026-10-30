/**
 * #2420 (cor:agt:050:28): an agent task's own `properties`, the one optional JSON object the team organises into its
 * own namespaces. The platform stores it, returns it and, when the Team Agent's system memory carries a schema,
 * validates it; it never reads a key for matching or authorization.
 *
 * The write rules live here so every door (create, update, the GraphQL and MCP surfaces) judges a value the same way:
 *   1. it is a JSON OBJECT                                  → PROPERTIES_NOT_AN_OBJECT
 *   2. its canonical JSON is at most 16 KiB of UTF-8        → PROPERTIES_TOO_LARGE
 *   3. it satisfies the team's schema when one applies      → PROPERTIES_SCHEMA_VIOLATION
 *      (a schema that exists but cannot be used refuses     → PROPERTIES_SCHEMA_UNUSABLE, never "no schema")
 * A clear (`null`) skips all of them. The fingerprint (size and SHA-256 of the canonical JSON) is what a change
 * records in the event stream: never the content, which may describe sensitive scheduling.
 */
import { createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';
import Ajv from 'ajv';
import type { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { locateTeamAgent } from '../../api/graphql/schema/resolvers.worker.js';
import { findEffectiveNodeIdByLoc } from '../effectiveSystemMemory.js';

/** The bound on a task's canonical-JSON `properties` (cor:agt:050:28, Proposed: engineering may adjust). */
export const TASK_PROPERTIES_MAX_BYTES = 16 * 1024;

/**
 * How deeply a value may nest. A small value can nest thousands of levels (2,500 levels is 15 KB), which would
 * overflow the recursion that canonicalizes, stores and validates it, so depth is bounded before any of those run.
 * Team namespaces nest a handful of levels; the bound is far above that.
 */
export const TASK_PROPERTIES_MAX_DEPTH = 64;

/** Where the team's schema lives in the Team Agent's system memory; its `data` holds a JSON Schema (draft-07). */
export const TASK_PROPERTIES_SCHEMA_LOC = 'schema:task-properties';

export type PropertiesFingerprint = { bytes: number; sha256: string };

const refusal = (code: string, message: string) => new GraphQLError(message, { extensions: { code } });

/** Compact JSON with object keys in code-unit order at every depth: the one spelling a size and a hash are taken of. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function propertiesFingerprint(value: unknown): PropertiesFingerprint {
  const text = canonicalJson(value);
  return { bytes: Buffer.byteLength(text, 'utf8'), sha256: createHash('sha256').update(text).digest('hex') };
}

/** Whether `value` nests deeper than `max` levels, found without recursion so a hostile value cannot overflow the stack. */
function nestsDeeperThan(value: object, max: number): boolean {
  const stack: Array<[object, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [object, number];
    if (depth > max) return true;
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** Checks 1 and 2: the value must be a JSON object within the size and depth bounds. Returns it for the write. */
export function normalizeTaskProperties(value: unknown): Prisma.InputJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw refusal('PROPERTIES_NOT_AN_OBJECT', 'properties must be a JSON object (or null to clear them).');
  }
  if (nestsDeeperThan(value, TASK_PROPERTIES_MAX_DEPTH)) {
    throw refusal('PROPERTIES_TOO_LARGE', `properties may nest at most ${TASK_PROPERTIES_MAX_DEPTH} levels deep.`);
  }
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > TASK_PROPERTIES_MAX_BYTES) {
    throw refusal('PROPERTIES_TOO_LARGE', `properties may hold at most ${TASK_PROPERTIES_MAX_BYTES} bytes of JSON.`);
  }
  return value as Prisma.InputJsonObject;
}

/**
 * Check 3. The platform reads the team's schema itself, as the platform and not as the writer, so a writer who cannot
 * read the Team Agent's memory is validated all the same (cor:agt:050:28 "What is checked"). The schema is the node at
 * `schema:task-properties`, found through the Team Agent's base chain, nearest Agent first (cor:dmo:050:14); an App
 * has no override. No Team Agent or no node means no schema. A node that exists but cannot be used refuses the write.
 */
export async function checkAgainstTeamSchema(
  tx: Prisma.TransactionClient,
  txCtx: Context,
  appId: string,
  value: Prisma.InputJsonObject,
): Promise<void> {
  const memoryId = await teamSystemMemoryId(txCtx, appId);
  if (!memoryId) return;
  const hit = await findEffectiveNodeIdByLoc(tx, memoryId, TASK_PROPERTIES_SCHEMA_LOC);
  if (!hit) return;
  const unusable = () => refusal(
    'PROPERTIES_SCHEMA_UNUSABLE',
    `The team's ${TASK_PROPERTIES_SCHEMA_LOC} node exists but is not a usable JSON Schema, so no properties can be set until it is fixed.`,
  );
  const node = await tx.node.findFirst({
    where: { id: hit.id, memoryId: hit.memoryId, deletedAt: null },
    select: { data: true, memory: { select: { deletedAt: true } } },
  });
  const schema = node && !node.memory.deletedAt ? node.data : null;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw unusable();
  let validate: ReturnType<Ajv['compile']>;
  try {
    // One instance per check: Ajv caches every compiled schema object for the life of the instance.
    validate = new Ajv({ strict: false, allErrors: false, logger: false }).compile(schema as object);
  } catch {
    throw unusable();
  }
  if ((validate as { $async?: boolean }).$async) throw unusable();
  if (!validate(value)) {
    const first = validate.errors?.[0];
    throw refusal(
      'PROPERTIES_SCHEMA_VIOLATION',
      `properties do not satisfy the team's ${TASK_PROPERTIES_SCHEMA_LOC}: ${first?.instancePath || '(root)'} ${first?.message ?? 'is invalid'}.`,
    );
  }
}

/**
 * The Team Agent's system memory. No Team Agent at all means no schema can exist. Two or more candidates is NOT "no
 * schema": the platform cannot tell which Agent's schema applies, so it refuses rather than skip the check.
 */
async function teamSystemMemoryId(txCtx: Context, appId: string): Promise<string | null> {
  try {
    return (await locateTeamAgent(txCtx, appId, undefined)).systemMemoryId;
  } catch (e) {
    const code = (e as { extensions?: { code?: string } }).extensions?.code;
    if (code === 'TEAM_AGENT_NOT_FOUND') return null;
    if (code === 'TEAM_AGENT_AMBIGUOUS') {
      throw refusal(
        'PROPERTIES_SCHEMA_UNUSABLE',
        `More than one installed Agent carries a roles: branch, so the team's ${TASK_PROPERTIES_SCHEMA_LOC} cannot be chosen and no properties can be set until the team has one Team Agent.`,
      );
    }
    throw e;
  }
}
