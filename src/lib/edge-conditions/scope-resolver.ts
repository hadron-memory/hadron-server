/**
 * Pre-resolves variables referenced by an edge condition into a nested
 * data bag the JSONLogic engine consumes synchronously. The async surface
 * here is what makes the encrypted-memory error path feasible: a memory
 * layer may be unable to fulfill a read, and we surface that immediately
 * as a typed evaluation error.
 *
 * Bag shape (matches JSONLogic dot-path conventions):
 *   {
 *     memory:  { ...resolved memory values... },
 *     chat:    { ...ctx.chat as-is... },
 *     agent:   { ...ctx.agent as-is... },
 *     message: { data: { ...ctx.messageData as-is... } },
 *     "now()":   "<ISO timestamp>",
 *     "today()": "<YYYY-MM-DD>"
 *   }
 *
 * v1 (US1 scope): single-layer memory cascade with parent-chain walk;
 * chat / agent / message.data scope readers; time builtins. Multi-layer
 * cascade arrives in US3; encrypted-memory layer in US4.
 */

import type { EncryptedMemoryError, EvaluationError } from './errors.js';

/**
 * A handle to one memory layer's read access. The memory cascade walks
 * layers in order; later layers override earlier ones.
 */
export interface MemoryLayerHandle {
  /** Short identifier used in diagnostics (e.g., "edge", "user"). */
  layerName: string;
  /**
   * Resolve a dotted path within this layer, walking the source-node's
   * parent chain (deepest-wins). Returns:
   *   - { ok: true, value }     when the layer found the value,
   *   - { ok: true, value: undefined } when truly missing,
   *   - { ok: false, error }    when the layer cannot be read (e.g.,
   *                              encrypted memory + no key).
   */
  read(path: string): Promise<
    | { ok: true; value: unknown }
    | { ok: false; error: EncryptedMemoryError }
  >;
}

export interface ScopeReadCtx {
  edgeId: string;
  memoryLayers: ReadonlyArray<MemoryLayerHandle>;
  chat?: Readonly<Record<string, unknown>>;
  agent: Readonly<Record<string, unknown>>;
  messageData?: Readonly<Record<string, unknown>>;
  clock: () => Date;
}

export type PreResolveResult =
  | { ok: true; bag: Record<string, unknown> }
  | { ok: false; error: EvaluationError };

/**
 * Walk the JSONLogic AST once, collect every memory.* field reference,
 * and resolve each through the cascade. Other scopes are mounted at the
 * top of the bag as-is so JSONLogic's own dot-path traversal handles
 * them. Returns the nested data bag the engine can consume.
 */
export async function preResolveVariables(
  condition: unknown,
  ctx: ScopeReadCtx,
): Promise<PreResolveResult> {
  const refs = collectVarReferences(condition);
  const bag: Record<string, unknown> = {};

  // Other scopes mount as-is. JSONLogic walks the dot paths within them.
  if (ctx.chat) bag.chat = ctx.chat;
  bag.agent = ctx.agent;
  bag.message = { data: ctx.messageData ?? {} };

  // Time builtins — snapshot once at evaluation start.
  if (refs.has('now()') || refs.has('today()')) {
    const now = ctx.clock();
    if (refs.has('now()')) bag['now()'] = now.toISOString();
    if (refs.has('today()')) bag['today()'] = now.toISOString().slice(0, 10);
  }

  // Memory: resolve each unique path through the cascade, then assemble
  // the nested memory bag.
  const memoryRefs = [...refs].filter((r) => r.startsWith('memory.'));
  if (memoryRefs.length > 0) {
    const memoryBag: Record<string, unknown> = {};
    for (const ref of memoryRefs) {
      const path = ref.slice('memory.'.length);
      const result = await readMemoryCascaded(path, ctx);
      if (!result.ok) return result;
      if (result.value !== undefined) setNestedPath(memoryBag, path, result.value);
    }
    bag.memory = memoryBag;
  }

  return { ok: true, bag };
}

async function readMemoryCascaded(
  path: string,
  ctx: ScopeReadCtx,
): Promise<{ ok: true; value: unknown } | { ok: false; error: EvaluationError }> {
  let value: unknown = undefined;
  for (const layer of ctx.memoryLayers) {
    const result = await layer.read(path);
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: 'MEMORY_ENCRYPTED_NO_KEY',
          message: `memory '${result.error.memoryUrn}' is encrypted and no key is available`,
          detail: {
            edgeId: ctx.edgeId,
            field: `memory.${path}`,
            memoryUrn: result.error.memoryUrn,
          },
        },
      };
    }
    if (result.value !== undefined) {
      value = result.value;
    }
  }
  return { ok: true, value };
}

function setNestedPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = cur[part];
    if (next === undefined || next === null || typeof next !== 'object') {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Walk the AST and collect every variable reference (`var`, `missing`,
 * `missing_some`). Only string-literal paths are collected — computed
 * paths from nested expressions are evaluated at engine time.
 */
function collectVarReferences(node: unknown): Set<string> {
  const out = new Set<string>();
  walk(node);
  return out;

  function walk(n: unknown): void {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (n === null || typeof n !== 'object') return;
    const keys = Object.keys(n);
    if (keys.length !== 1) return;
    const op = keys[0];
    const args = (n as Record<string, unknown>)[op];

    if (op === 'var') {
      let path: string | null = null;
      if (typeof args === 'string') path = args;
      else if (Array.isArray(args) && typeof args[0] === 'string') path = args[0];
      if (path !== null) out.add(path);
    }
    if (op === 'missing' && Array.isArray(args)) {
      for (const f of args) if (typeof f === 'string') out.add(f);
    }
    if (op === 'missing_some' && Array.isArray(args) && args.length === 2) {
      const fields = args[1];
      if (Array.isArray(fields)) {
        for (const f of fields) if (typeof f === 'string') out.add(f);
      }
    }
    walk(args);
  }
}
