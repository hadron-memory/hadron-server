/**
 * Policy chain — the SHAPE of cor:acl:040 (spec 040, D-2026-07-04-A).
 *
 * v1 deliberately builds the interface, not the rule language: an action
 * vocabulary, allow-lists as the minimal rule representation, and strict
 * conjunctive evaluation (org → user → app → run — every present layer can
 * only restrict; cor:acl:040:02's delegation ceiling). The full declarative
 * language grows inside `allows()` without touching call sites.
 *
 * Semantics (plan §4, PR-492 review):
 *   - An ABSENT layer (null/undefined link) contributes no additional
 *     restriction — it is simply not part of the conjunction. The base
 *     layer (memory class gates ∩ App scope) is enforced by the code paths
 *     themselves and is always present.
 *   - A PRESENT link is default-deny over its allow-list: the action must
 *     match an entry (exact, `prefix.*`, or `*`).
 */

/** v1 action vocabulary (plan §4). `tool.<name>` is reserved. */
export type PolicyAction =
  | 'run.execute'
  | 'llm.invoke'
  | 'memory.read'
  | 'memory.write'
  | 'comm.outbound'
  | `tool.${string}`;

export interface PolicyLink {
  /** Allowed actions: exact (`memory.write`), prefix (`memory.*`), or `*`. */
  allow: string[];
}

/** Parse an untrusted JSON policy column into a link (null = absent layer). */
export function parsePolicyLink(raw: unknown): PolicyLink | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allow = (raw as { allow?: unknown }).allow;
  if (!Array.isArray(allow) || !allow.every((a) => typeof a === 'string')) return null;
  return { allow };
}

export function allows(link: PolicyLink, action: PolicyAction): boolean {
  return link.allow.some((entry) => {
    if (entry === '*') return true;
    if (entry.endsWith('.*')) return action.startsWith(entry.slice(0, -1));
    return entry === action;
  });
}

/**
 * Strict conjunction over the PRESENT links of the chain, ordered
 * org → user → app → run by convention (order does not affect the result —
 * conjunction is commutative — but keeps failure reporting stable).
 */
export function evaluatePolicyChain(
  action: PolicyAction,
  links: Array<PolicyLink | null | undefined>,
): boolean {
  return links.every((l) => l == null || allows(l, action));
}
