import { GraphQLError } from 'graphql';

/**
 * Bounds on resolving one node's content on read (hadron-internal#40; rulings 0196/0197).
 *
 * A resolved read (include splicing, then the template render) is charged as it goes, before
 * anything is materialised or parsed: bytes as UTF-8, the work it does (tag expansions, lookups,
 * loaded text, render steps) as counts. Going over any limit refuses the whole read with one typed
 * error naming the limit; truncated or partial text is never returned. The stored text stays
 * readable with `raw: true`, and a node with no template syntax is never charged.
 *
 * Oracle rule: every charge is made before any state-dependent work, a missing and an unreadable
 * target are charged identically, and loaded bytes are charged only for rows the reader may read.
 */
export type ResolutionLimit = 'bytes' | 'expansions' | 'lookups' | 'loaded' | 'steps' | 'requestBytes';

export interface ResolutionLimits {
  /** UTF-8 bytes of spliced text (what the template parse sees), and separately of rendered output. */
  maxBytes: number;
  /** Include tags expanded across the whole traversal, every repetition counted. */
  maxExpansions: number;
  /** Database lookups a resolution may make (targets, revisions, approvals, data and reference nodes). */
  maxLookups: number;
  /** UTF-8 bytes of authorized text loaded, whether or not it is served. */
  maxLoadedBytes: number;
  /** Template render steps (token visits and section iterations). */
  maxRenderSteps: number;
}

/** Initial values (tunable; not a measured production-compatibility claim). */
export const DEFAULT_RESOLUTION_LIMITS: Readonly<ResolutionLimits> = Object.freeze({
  maxBytes: 1024 * 1024,
  maxExpansions: 10_000,
  maxLookups: 1_000,
  maxLoadedBytes: 4 * 1024 * 1024,
  maxRenderSteps: 200_000,
});

/** Resolved bytes one request may serve across all its resolved reads (ruling 0197 (2)). */
export const DEFAULT_REQUEST_MAX_BYTES = 8 * 1024 * 1024;

let configured: { limits: Partial<ResolutionLimits>; requestMaxBytes?: number } = { limits: {} };

/**
 * The limits a new budget takes. The values are tunable; this is the one place they are set. Tests
 * lower them so a refusal is reached without allocating anything large; `null` restores the defaults.
 */
export function setResolutionLimits(next: { limits?: Partial<ResolutionLimits>; requestMaxBytes?: number } | null): void {
  configured = next ? { limits: { ...(next.limits ?? {}) }, requestMaxBytes: next.requestMaxBytes } : { limits: {} };
}

export function currentRequestMaxBytes(): number {
  return configured.requestMaxBytes ?? DEFAULT_REQUEST_MAX_BYTES;
}

export const CONTENT_RESOLUTION_LIMIT_EXCEEDED = 'CONTENT_RESOLUTION_LIMIT_EXCEEDED';

const LIMIT_TEXT: Record<ResolutionLimit, string> = {
  bytes: 'the size limit',
  expansions: 'the include limit',
  lookups: 'the lookup limit',
  loaded: 'the loaded-text limit',
  steps: 'the template work limit',
  requestBytes: 'the per-request size limit',
};

/**
 * Where a refusal is shown, which decides its remedy (#40). A read (MCP, GraphQL)
 * can ask for the stored text with `raw: true`; an export has no such option.
 */
export type ResolutionSurface = 'read' | 'export';

/** The refusal's fixed text for `limit` on `surface`: it names the limit and a remedy, never a node, target, tag or size. */
export function resolutionLimitMessage(limit: ResolutionLimit, surface: ResolutionSurface = 'read'): string {
  const remedy = surface === 'export'
    ? 'Export it after shortening the content, or read the stored text instead.'
    : limit === 'requestBytes'
      ? 'Split the work into smaller requests, or read it with raw: true to get the stored text.'
      : 'Read it with raw: true to get the stored text.';
  return `This content could not be resolved: it exceeds ${LIMIT_TEXT[limit]} for a resolved read. `
    + `Nothing partial was returned. ${remedy}`;
}

/** The limit's phrase as the refusal names it ("the size limit"), for a surface that lists several refusals. */
export function resolutionLimitPhrase(limit: ResolutionLimit): string {
  return LIMIT_TEXT[limit];
}

/**
 * The one refusal for a read over a resolution limit. Fixed text per surface: it names the limit and
 * the remedy, never a node, target, tag or size.
 */
export class ContentResolutionLimitError extends GraphQLError {
  readonly limit: ResolutionLimit;
  constructor(limit: ResolutionLimit, surface: ResolutionSurface = 'read') {
    super(resolutionLimitMessage(limit, surface), { extensions: { code: CONTENT_RESOLUTION_LIMIT_EXCEEDED, limit } });
    this.name = 'ContentResolutionLimitError';
    this.limit = limit;
  }

  /** The same refusal worded for an export, which has no raw read. */
  forExport(): ContentResolutionLimitError {
    return new ContentResolutionLimitError(this.limit, 'export');
  }
}

export function isContentResolutionLimitError(e: unknown): e is ContentResolutionLimitError {
  return e instanceof ContentResolutionLimitError;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Resolved bytes served across one request. Owned by the request's Context (never global, never
 * shared across principals or requests). Charges are synchronous, so concurrent field resolvers
 * of one request account exactly; which of them is refused first may vary, and each refusal is loud.
 */
export class RequestResolutionBudget {
  private served = 0;
  constructor(readonly maxBytes: number = currentRequestMaxBytes()) {}
  /**
   * Checked before it is committed: a refused read serves nothing, so it consumes none of the
   * allowance and a smaller sibling read that fits is still served (#40).
   */
  chargeServed(text: string): void {
    const next = this.served + utf8Bytes(text);
    if (next > this.maxBytes) throw new ContentResolutionLimitError('requestBytes');
    this.served = next;
  }
}

/** One resolution's counters. Create one per resolved read; a direct caller that passes none gets the defaults. */
export class ResolutionBudget {
  readonly limits: ResolutionLimits;
  private splicedBytes = 0;
  private renderedBytes = 0;
  private expansions = 0;
  private lookups = 0;
  private loadedBytes = 0;
  private steps = 0;

  constructor(limits: Partial<ResolutionLimits> = {}) {
    this.limits = { ...DEFAULT_RESOLUTION_LIMITS, ...configured.limits, ...limits };
  }

  /** Text appended to the spliced output (what the template parse will see). */
  chargeSpliced(text: string): void {
    if (text.length === 0) return;
    this.splicedBytes += utf8Bytes(text);
    if (this.splicedBytes > this.limits.maxBytes) throw new ContentResolutionLimitError('bytes');
  }

  /** Text written by the render, after escaping. */
  chargeRendered(text: string): void {
    if (text.length === 0) return;
    this.renderedBytes += utf8Bytes(text);
    if (this.renderedBytes > this.limits.maxBytes) throw new ContentResolutionLimitError('bytes');
  }

  /** Expansions still allowed; a parse materializes at most this many tags before it refuses. */
  remainingExpansions(): number {
    return Math.max(0, this.limits.maxExpansions - this.expansions);
  }

  /** One include tag expanded. Charged first, before the depth, cycle or any lookup. */
  chargeExpansion(): void {
    if (++this.expansions > this.limits.maxExpansions) throw new ContentResolutionLimitError('expansions');
  }

  /** One database lookup, charged before it runs and whatever it finds. */
  chargeLookup(count = 1): void {
    this.lookups += count;
    if (this.lookups > this.limits.maxLookups) throw new ContentResolutionLimitError('lookups');
  }

  /** Text of an authorized row or revision just loaded. Never called for a row the reader may not read. */
  chargeLoaded(text: string | null | undefined): void {
    if (!text) return;
    this.loadedBytes += utf8Bytes(text);
    if (this.loadedBytes > this.limits.maxLoadedBytes) throw new ContentResolutionLimitError('loaded');
  }

  chargeStep(count = 1): void {
    this.steps += count;
    if (this.steps > this.limits.maxRenderSteps) throw new ContentResolutionLimitError('steps');
  }
}
