import Mustache from 'mustache';
import type { ResolutionBudget } from './resolutionBudget.js';

/**
 * A Mustache writer for one render (hadron-internal#40). It renders exactly as `Mustache.render`
 * does, with two differences:
 *
 * - No template cache. The module-level writer behind `Mustache.render` keeps every parsed
 *   template, keyed by its whole text, for the life of the process, so one read retained its
 *   parse memory (and, for an encrypted memory, its decrypted text) until restart. A writer per
 *   call keeps nothing once the render returns.
 * - Charged as it goes: one step per token visited and per `renderTokens` entry (so empty
 *   sections and their iterations are counted), and every string written, after escaping, against
 *   the budget's rendered-bytes limit. A limit refuses mid-render; nothing partial is returned.
 * - A name lookup is charged by the context stack it may walk. Mustache resolves a name by trying
 *   each enclosing context in turn, so inside N nested sections one `{{name}}` that misses costs N
 *   context probes, not one. Each lookup token (`{{name}}`, `{{&name}}`, `{{#name}}`, `{{^name}}`)
 *   is charged one step per context above the root, on top of its visit, so deep nesting cannot
 *   multiply render work past the step limit (#40). At the root (no section)
 *   the charge is the visit alone.
 */
/** Token types whose render looks a name up through the context stack. */
const LOOKUP_TOKENS: ReadonlySet<string> = new Set(['name', '&', '#', '^']);

export class BudgetedWriter extends Mustache.Writer {
  /** Each context's stack depth (the root view is 1), memoized so a deep section costs O(1) to measure. */
  private readonly depths = new WeakMap<Mustache.Context, number>();

  private depthOf(context: Mustache.Context): number {
    const known = this.depths.get(context);
    if (known !== undefined) return known;
    const parent = (context as unknown as { parent?: Mustache.Context }).parent;
    const depth = parent ? this.depthOf(parent) + 1 : 1;
    this.depths.set(context, depth);
    return depth;
  }

  constructor(private readonly budget: ResolutionBudget) {
    super();
    (this as unknown as { templateCache?: unknown }).templateCache = undefined;
  }

  override renderTokens(
    tokens: string[][], context: Mustache.Context, partials?: Mustache.PartialsOrLookupFn,
    originalTemplate?: string, config?: Mustache.RenderOptions,
  ): string {
    let lookups = 0;
    // A lookup walks each dot segment at each context level (mustache's Context.lookup), so it is charged
    // by its segments, not once (#40).
    for (const token of tokens) if (LOOKUP_TOKENS.has(token[0])) lookups += String(token[1]).split('.').length;
    this.budget.chargeStep(1 + tokens.length + lookups * (this.depthOf(context) - 1));
    return super.renderTokens(tokens, context, partials, originalTemplate, config);
  }

  override unescapedValue(token: string[], context: Mustache.Context): string {
    const value = super.unescapedValue(token, context) as unknown;
    if (value == null) return value as unknown as string;
    this.budget.chargeRendered(String(value));
    return value as string;
  }

  override escapedValue(token: string[], context: Mustache.Context, config?: Mustache.RenderOptions): string {
    const value = super.escapedValue(token, context, config) as unknown;
    if (value == null) return value as unknown as string;
    this.budget.chargeRendered(String(value));
    return value as string;
  }

  override rawValue(token: string[]): string {
    const value = super.rawValue(token);
    this.budget.chargeRendered(value);
    return value;
  }
}

/** `Mustache.render(template, view)` under `budget`, with no retained parse. */
export function renderBudgeted(template: string, view: Record<string, unknown>, budget: ResolutionBudget): string {
  return new BudgetedWriter(budget).render(template, view);
}
