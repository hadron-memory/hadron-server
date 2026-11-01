/** #1655 / DAE, DAG, DAI: shared compiled-automation format foundation.
 * This module does not grant execution authority; publish/load callers must
 * also verify the live environment and the version's approval/signature.
 * Validation never rewrites signed bytes: the compiler normalizes text to LF,
 * then publish/load hash the validated object.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertFullyQualifiedUrn } from '../urn.js';
import { validateEdgeCondition } from '../edge-conditions/validator.js';
import { validateExtractionSpec } from '../edge-conditions/reserved-names.js';

export const FORMAT = 'hadron-automation-v1';
export const SPEC_LIMITS = Object.freeze({
  OBJECT_BYTES: 256 * 1024, NODES: 200, EDGES: 1000, CONTENT_BYTES: 64 * 1024, TOOLS_PER_NODE: 50,
});
export type AutomationLimits = { -readonly [K in keyof typeof SPEC_LIMITS]: number };
export function readAutomationLimits(env: Record<string, string | undefined>): AutomationLimits {
  const limits: AutomationLimits = { ...SPEC_LIMITS };
  for (const name of Object.keys(env)) {
    if (name.startsWith('AUTOMATION_MAX_') && !Object.hasOwn(SPEC_LIMITS, name.slice('AUTOMATION_MAX_'.length))) {
      throw new Error(`Unknown automation limit ${name}.`);
    }
  }
  for (const key of Object.keys(limits) as (keyof AutomationLimits)[]) {
    const name = `AUTOMATION_MAX_${key}`;
    const raw = env[name];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > SPEC_LIMITS[key]) {
      throw new Error(`${name} must be a positive integer no greater than ${SPEC_LIMITS[key]}.`);
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

export class AutomationFormatError extends Error {
  readonly code = 'AUTOMATION_INVALID';
  constructor(readonly path: string, readonly reason: string) { super(`Invalid automation at ${path}: ${reason}`); }
}
const fail = (path: string, reason: string): never => { throw new AutomationFormatError(path, reason); };

/** RFC 8785, over JSON values (not raw JSON text): UTF-16 key ordering,
 * ECMAScript primitives, no Unicode normalization, no toJSON hooks.
 */
export function canonicalizeAutomationJson(value: unknown): string {
  const ancestors = new Set<object>();
  const string = (s: string): string => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('$', 'INVALID_UNICODE');
      } else if (c >= 0xdc00 && c <= 0xdfff) fail('$', 'INVALID_UNICODE');
    }
    return JSON.stringify(s);
  };
  const visit = (v: unknown): string => {
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return string(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('$', 'INVALID_NUMBER');
      return JSON.stringify(v);
    }
    if (typeof v !== 'object' || !v) return fail('$', 'NOT_JSON');
    if (ancestors.has(v)) return fail('$', 'CYCLE');
    if (ancestors.size >= 100) return fail('$', 'NESTING_TOO_DEEP');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      return fail('$', 'NOT_JSON');
    }
    if (Object.getOwnPropertySymbols(v).length) return fail('$', 'NOT_JSON');
    ancestors.add(v);
    try {
      const read = (key: string) => {
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d || !('value' in d)) return fail('$', 'NOT_JSON');
        return visit(d.value);
      };
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) return fail('$', 'NOT_JSON');
        return `[${Array.from({ length: v.length }, (_, i) => read(String(i))).join(',')}]`;
      }
      return `{${Object.keys(v).sort().map(key => `${string(key)}:${read(key)}`).join(',')}}`;
    } finally { ancestors.delete(v); }
  };
  return visit(value);
}

export function automationVersionHash(value: unknown): string {
  return createHash('sha256').update(`${FORMAT}\n`).update(canonicalizeAutomationJson(value), 'utf8').digest('hex');
}
const localKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const nonempty = z.string().min(1);
const text = z.string().nullable();
const urn = z.string().refine(v => { try { assertFullyQualifiedUrn(v, 'node'); return true; } catch { return false; } });
const extraction = z.strictObject({ field: nonempty, description: z.string().optional(), shape: z.string().optional() });
const flow = z.strictObject({
  tools: z.array(nonempty).optional(), extractionSpec: z.array(extraction).optional(),
  // #670 (cor:agt:010:04): a script node's one declared call; excludes tools and extractionSpec.
  script: z.strictObject({ call: z.strictObject({ tool: nonempty, args: z.record(z.string(), z.unknown()).optional() }) }).optional(),
  output: z.strictObject({ writeTo: urn, mode: z.enum(['replace', 'append']) }).optional(),
  runTargets: z.array(localKey).optional(), credentials: z.array(nonempty).optional(),
});
const schema = z.strictObject({
  format: z.literal(FORMAT), app: nonempty, entry: localKey,
  nodes: z.record(localKey, z.strictObject({
    source: z.strictObject({ nodeId: nonempty, revision: z.number().int().nonnegative() }),
    title: text, abstract: text, content: text, flow,
  })),
  edges: z.array(z.strictObject({
    from: localKey, to: localKey, name: nonempty, order: z.number().int().nonnegative(),
    condition: z.unknown().refine(v => v !== undefined),
  })),
  environment: z.strictObject({
    ai: z.strictObject({ configId: nonempty, provider: nonempty, model: nonempty, tier: z.number().int().positive(), endpoint: z.string().nullable() }),
    tools: z.array(z.strictObject({ name: nonempty, registrationId: nonempty, url: nonempty, opAllowlist: z.array(nonempty) })),
    policy: z.strictObject({ allow: z.array(nonempty) }),
    budgets: z.strictObject({ tokens: z.number().int().positive(), actions: z.number().int().positive(), timeoutMs: z.number().int().positive() }),
  }),
});
export type CompiledAutomation = z.output<typeof schema>;

/** Tool resolution is supplied by the publishing/loading caller's live registry.
 * No tool is considered valid solely because its name appears in the object.
 * Optional caller limits can only tighten the live deployment limits.
 */
export function validateCompiledAutomation(input: unknown, options: {
  appId: string; limits?: AutomationLimits; resolvesTool: (name: string) => boolean; resolvesCredential: (ref: string) => boolean;
}): CompiledAutomation {
  // Refuse non-JSON values before Zod could strip or invoke an accessor.
  const limits = { ...readAutomationLimits(process.env) };
  if (options.limits) {
    for (const key of Object.keys(limits) as (keyof AutomationLimits)[]) {
      const value = options.limits[key];
      if (!Number.isSafeInteger(value) || value <= 0) fail('$', 'INVALID_LIMIT');
      limits[key] = Math.min(value, limits[key]);
    }
  }
  const canonical = canonicalizeAutomationJson(input);
  if (Buffer.byteLength(canonical, 'utf8') > limits.OBJECT_BYTES) {
    fail('$', 'LIMIT_EXCEEDED:AUTOMATION_MAX_OBJECT_BYTES');
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].path.join('.'), 'SCHEMA');
  const obj = parsed.data;
  const cap = (size: number, key: keyof AutomationLimits, path: string) => {
    if (size > limits[key]) fail(path, `LIMIT_EXCEEDED:AUTOMATION_MAX_${key}`);
  };
  if (obj.app !== options.appId) fail('app', 'APP_MISMATCH');
  cap(Object.keys(obj.nodes).length, 'NODES', 'nodes'); cap(obj.edges.length, 'EDGES', 'edges');
  if (!Object.hasOwn(obj.nodes, obj.entry)) fail('entry', 'MISSING_NODE');
  const registrations = new Set<string>();
  for (const tool of obj.environment.tools) {
    if (registrations.has(tool.name)) fail('environment.tools', 'DUPLICATE_TOOL');
    registrations.add(tool.name);
  }
  for (const [key, node] of Object.entries(obj.nodes)) {
    const path = `nodes.${key}`;
    for (const field of ['title', 'abstract', 'content'] as const) {
      if (node[field]?.includes('\r')) fail(`${path}.${field}`, 'NOT_NORMALIZED');
    }
    cap(Buffer.byteLength(node.content ?? '', 'utf8'), 'CONTENT_BYTES', `${path}.content`);
    cap(node.flow.tools?.length ?? 0, 'TOOLS_PER_NODE', `${path}.flow.tools`);
    if (node.flow.tools !== undefined && node.flow.extractionSpec !== undefined) fail(`${path}.flow`, 'TOOLS_AND_EXTRACTION');
    if (node.flow.script !== undefined && (node.flow.tools !== undefined || node.flow.extractionSpec !== undefined)) fail(`${path}.flow`, 'SCRIPT_AND_TOOLS_OR_EXTRACTION');
    if (node.flow.extractionSpec) {
      const check = validateExtractionSpec(node.flow.extractionSpec);
      if (!check.ok || node.flow.extractionSpec.some(e => e.field.startsWith('__'))) fail(`${path}.flow.extractionSpec`, 'RESERVED_NAME');
    }
    for (const ref of node.flow.credentials ?? []) {
      if (!options.resolvesCredential(ref)) fail(`${path}.flow.credentials`, 'INVALID_CREDENTIAL_REFERENCE');
    }
    for (const target of node.flow.runTargets ?? []) {
      if (!Object.hasOwn(obj.nodes, target)) fail(`${path}.flow.runTargets`, 'MISSING_NODE');
    }
    // A script node's tool is held to the same name and registration checks as a declared tool.
    const scriptTool = node.flow.script?.call.tool;
    if (scriptTool !== undefined) {
      if (!options.resolvesTool(scriptTool)) fail(`${path}.flow.script`, 'UNKNOWN_TOOL');
      if (/^(mcp__|ha__)/.test(scriptTool) && !registrations.has(scriptTool)) fail(`${path}.flow.script`, 'MISSING_REGISTRATION');
    }
    for (const tool of node.flow.tools ?? []) {
      if (!options.resolvesTool(tool)) fail(`${path}.flow.tools`, 'UNKNOWN_TOOL');
      if (/^(mcp__|ha__)/.test(tool) && !registrations.has(tool)) fail(`${path}.flow.tools`, 'MISSING_REGISTRATION');
    }
  }
  const orders = new Map<string, Set<number>>();
  for (const [i, edge] of obj.edges.entries()) {
    if (!Object.hasOwn(obj.nodes, edge.from) || !Object.hasOwn(obj.nodes, edge.to)) fail(`edges.${i}`, 'MISSING_NODE');
    const seen = orders.get(edge.from) ?? new Set<number>();
    if (seen.has(edge.order)) fail(`edges.${i}.order`, 'DUPLICATE_ORDER');
    seen.add(edge.order); orders.set(edge.from, seen);
    if (!validateEdgeCondition(edge.condition).ok) fail(`edges.${i}.condition`, 'INVALID_CONDITION');
  }
  cap(Buffer.byteLength(canonicalizeAutomationJson(obj), 'utf8'), 'OBJECT_BYTES', '$');
  return obj;
}
