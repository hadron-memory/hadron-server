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

/**
 * Bounds on the TEAM's schema (§10 review of #2877): it is authored by whoever writes the Team Agent's system memory
 * or a base Agent's, and it runs synchronously on the shared event loop against a value the writer controls, so an
 * unbounded schema is a way to freeze every tenant on the process.
 */
export const TASK_PROPERTIES_SCHEMA_MAX_BYTES = 64 * 1024;
export const TASK_PROPERTIES_SCHEMA_MAX_DEPTH = 32;
/**
 * Bounds on what validating may COST, not only on bytes (§10 P2-1 at b99c4fc1: a ref-free 64 KiB schema of ~60k nodes
 * cost ~1 s of event loop per write; at 1000 nodes / 2M pairs, ~480 ms per cached write, and enum leaves went uncounted).
 * A schema may hold this many values, leaves included, and a write is refused when
 * schema nodes x value nodes passes the work budget. Team schemas run to tens of nodes; both bounds are far above that.
 */
export const TASK_PROPERTIES_SCHEMA_MAX_NODES = 500;
export const TASK_PROPERTIES_VALIDATION_BUDGET = 200_000;

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
  const found = await readTeamSchemaNode(tx, txCtx, appId, TASK_PROPERTIES_SCHEMA_LOC, () => refusal(
    'PROPERTIES_SCHEMA_UNUSABLE',
    `More than one installed Agent carries a roles: branch, so the team's ${TASK_PROPERTIES_SCHEMA_LOC} cannot be chosen and no properties can be set until the team has one Team Agent.`,
  ));
  if (found === undefined) return;
  const unusable = () => refusal(
    'PROPERTIES_SCHEMA_UNUSABLE',
    `The team's ${TASK_PROPERTIES_SCHEMA_LOC} node exists but is not a usable JSON Schema, so no properties can be set until it is fixed.`,
  );
  const schema = found;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw unusable();
  const schemaNodes = schemaNodeCount(schema);
  if (schemaNodes === null) throw unusable();
  if (schemaNodes * valueNodeCount(value) > TASK_PROPERTIES_VALIDATION_BUDGET) {
    throw refusal('PROPERTIES_TOO_LARGE', 'properties are too large to validate against the team\'s schema; send a smaller value.');
  }
  let validate: ReturnType<Ajv['compile']>;
  try {
    validate = compileSchema(schema);
  } catch {
    throw unusable();
  }
  if ((validate as { $async?: boolean }).$async) throw unusable();
  let valid: boolean;
  try {
    valid = validate(value) as boolean;
  } catch {
    // e.g. a RangeError from a very wide anyOf: the schema cannot be used, not an internal error.
    throw unusable();
  }
  if (!valid) {
    // The path in the WRITER's own value and the failing keyword only: ajv's message would echo the schema's text
    // (required names, enum values, limits) to a writer who may not be able to read the schema's memory.
    const first = validate.errors?.[0];
    throw refusal(
      'PROPERTIES_SCHEMA_VIOLATION',
      `properties do not satisfy the team's ${TASK_PROPERTIES_SCHEMA_LOC}: ${first?.instancePath || '(root)'} fails "${first?.keyword ?? 'schema'}".`,
    );
  }
}

/** Where a value sits in a schema: a schema (keywords apply), a map of names to schemas, or literal data. */
type SchemaPosition = 'schema' | 'map' | 'data';
const SCHEMA_DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'definitions', '$defs', 'dependencies']);

/**
 * The schema's node count, or null when it is out of bounds (size, depth, node cap) or uses regex or reference keywords. Regular expressions are refused outright: `pattern`
 * and `patternProperties` run the engine's backtracking RegExp, and a catastrophic pattern such as `^(a+)+$` takes
 * seconds on a 28-character value and hours on a 40-character one, on the event loop every tenant shares. Walked
 * without recursion so a deeply nested schema cannot overflow the stack. Properties merely NAMED `pattern` or
 * `patternProperties` are fine: a name-map key is not a schema keyword. Literal data is never inspected as a schema.
 */
function schemaNodeCount(schema: object): number | null {
  let nodes = 0;
  const stack: Array<[unknown, number, SchemaPosition]> = [[schema, 1, 'schema']];
  while (stack.length > 0) {
    const [node, depth, position] = stack.pop() as [unknown, number, SchemaPosition];
    if (++nodes > TASK_PROPERTIES_SCHEMA_MAX_NODES) return null;
    if (node === null || typeof node !== 'object') continue;
    if (depth > TASK_PROPERTIES_SCHEMA_MAX_DEPTH) return null;
    // Keywords are judged only where the validator reads them: a property-name map ({"uniqueItems": true} under
    // `properties` is a boolean subschema) and literal data (`const`, `enum`, ...) are counted but never inspected.
    if (position === 'schema' && !Array.isArray(node)) {
      const o = node as Record<string, unknown>;
      if (typeof o.pattern === 'string') return null;
      if (o.patternProperties !== undefined && typeof o.patternProperties === 'object') return null;
      // References let a flat, tiny schema describe an exponential evaluation tree (a chain of anyOf [$ref, $ref] is 2^N
      // branches and exhausts the heap). The schema-nodes x value-nodes work budget bounds linear keyword evaluation;
      // it is not a bound for quadratic keywords, which need their own refusal (uniqueItems below).
      // uniqueItems compares every pair of an array's items, so its cost is quadratic in the array and no schema-nodes x
      // value-nodes budget bounds it (60 allOf copies against a 1,600-item array cost 0.5-1.1 s per write).
      if (o.uniqueItems === true) return null;
      if (typeof o.$ref === 'string' || typeof o.$recursiveRef === 'string' || typeof o.$dynamicRef === 'string') return null;
    }
    for (const [key, child] of Object.entries(node)) {
      let childPosition: SchemaPosition = 'schema';
      if (position === 'data') childPosition = 'data';
      else if (position === 'schema' && !Array.isArray(node)) {
        if (SCHEMA_DATA_KEYWORDS.has(key)) childPosition = 'data';
        else if (SCHEMA_MAP_KEYWORDS.has(key)) childPosition = 'map';
      }
      stack.push([child, depth + 1, childPosition]);
    }
  }
  return Buffer.byteLength(canonicalJson(schema), 'utf8') <= TASK_PROPERTIES_SCHEMA_MAX_BYTES ? nodes : null;
}

/** Objects, arrays and leaves of a value, counted without recursion; the work a validator does is proportional to it. */
function valueNodeCount(value: unknown): number {
  let n = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    n++;
    if (node !== null && typeof node === 'object') for (const c of Object.values(node)) stack.push(c);
  }
  return n;
}

/** Compiled validators by the hash of their schema's canonical JSON, so a hot team schema compiles once. */
const compiled = new Map<string, ReturnType<Ajv['compile']>>();
const COMPILED_CAP = 32;

function compileSchema(schema: object): ReturnType<Ajv['compile']> {
  const key = createHash('sha256').update(canonicalJson(schema)).digest('hex');
  const hit = compiled.get(key);
  if (hit) return hit;
  // One instance per schema: Ajv caches every compiled schema object for the life of the instance.
  const validate = new Ajv({ strict: false, allErrors: false, logger: false }).compile(schema);
  if (compiled.size >= COMPILED_CAP) compiled.delete(compiled.keys().next().value as string);
  compiled.set(key, validate);
  return validate;
}

/**
 * The team's schema node at `loc` (#2420; #2652 reuses it for the outcome set, cor:agt:050:30): the node in the Team
 * Agent's system memory, found through its base chain, nearest Agent first (cor:dmo:050:14), read as the platform.
 * `undefined` when there is no Team Agent or no node (no schema applies); the node's `data`, or `null` when the node or
 * its memory is gone mid-read (the caller treats that as unusable). Two or more Team Agents is NOT "no schema": the
 * platform cannot tell whose applies, so `onAmbiguous` is thrown rather than the check skipped. With
 * `ambiguousOnlyIfAnyHasNode` (#2652: finishing is not optional the way properties are), it is thrown only when some
 * candidate's chain actually holds a node at `loc`; when none does, there is no schema whichever Agent is meant.
 */
export async function readTeamSchemaNode(
  tx: Prisma.TransactionClient,
  txCtx: Context,
  appId: string,
  loc: string,
  onAmbiguous: () => Error,
  options: { ambiguousOnlyIfAnyHasNode?: boolean } = {},
): Promise<Prisma.JsonValue | null | undefined> {
  let memoryId: string | null;
  try {
    memoryId = await teamSystemMemoryId(txCtx, appId);
  } catch (e) {
    if ((e as { extensions?: { code?: string } }).extensions?.code !== 'TEAM_AGENT_AMBIGUOUS') throw e;
    if (options.ambiguousOnlyIfAnyHasNode) {
      const ids = ((e as { extensions?: { candidates?: Array<{ id: string }> } }).extensions?.candidates ?? []).map((c) => c.id);
      const agents = await tx.agent.findMany({ where: { id: { in: ids } }, select: { systemMemoryId: true } });
      // Fail closed on a candidate list we cannot read: an empty one is not proof that no candidate has the node.
      let anyHas = ids.length === 0;
      for (const a of agents) if (a.systemMemoryId && await findEffectiveNodeIdByLoc(tx, a.systemMemoryId, loc)) anyHas = true;
      if (!anyHas) return undefined;
    }
    throw onAmbiguous();
  }
  if (!memoryId) return undefined;
  const hit = await findEffectiveNodeIdByLoc(tx, memoryId, loc);
  if (!hit) return undefined;
  const node = await tx.node.findFirst({
    where: { id: hit.id, memoryId: hit.memoryId, deletedAt: null },
    select: { data: true, memory: { select: { deletedAt: true } } },
  });
  return node && !node.memory.deletedAt ? node.data : null;
}

/** The Team Agent's system memory, or null when the App has none; TEAM_AGENT_AMBIGUOUS propagates to the caller. */
async function teamSystemMemoryId(txCtx: Context, appId: string): Promise<string | null> {
  try {
    return (await locateTeamAgent(txCtx, appId, undefined)).systemMemoryId;
  } catch (e) {
    if ((e as { extensions?: { code?: string } }).extensions?.code === 'TEAM_AGENT_NOT_FOUND') return null;
    throw e;
  }
}
