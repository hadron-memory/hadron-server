/**
 * #723 — the PRE-#723 string key of an App's `shared` app-class memory, and the
 * matching rules for adopting a row that still carries it.
 *
 * Until #723 the memory was IDENTIFIED by its urn (`<app-urn>:<agent-slug>:shared`);
 * identity now lives in `Memory.sharedMemoryOfAgentId`. Rows written before the
 * flip have to be adopted off that string ONCE, in three places — the
 * `20260813120000_shared_memory_agent_key` migration (bulk), `adoptSharedMemories`
 * (the reporting sweep), and `findOrCreateAppClassMemory` (lazily, on the
 * pairing's next touch). This module is the ONE definition those paths share, so
 * they cannot drift into matching different sets of rows.
 *
 * Matching is EQUALITY on parsed atoms, never a SQL pattern: a slug may legally
 * contain `_`, which is a single-character wildcard in `LIKE` — and Prisma's
 * `endsWith`/`contains` filters compile to `LIKE`. So `sales_bot` would match a
 * `salesXbot` row and adopt another Agent's team space. Candidate rows are
 * narrowed by indexed columns (`appId` + `class` + the null key) and compared in
 * memory; an App holds a handful of app-class memories, so the scan is trivial.
 */

import { normalizeUrnForLookup } from './urn.js';

/** The pieces of an Agent row the legacy key can be derived from. */
export interface AgentSlugSource {
  urn: string;
  /** #697 alias map — the pre-v2 urn, when the Task-A sweep re-slugged the Agent. */
  legacyUrn?: string | null;
}

/** The pieces of a Memory row that can carry the legacy string key. */
export interface LegacyKeyedMemory {
  urn: string;
  /** #697 alias map — where the Task-A sweep parks the compound form. */
  legacyUrn?: string | null;
}

/**
 * The agent slug embedded in a pre-#723 shared-memory urn: the penultimate atom
 * of `<root>:<app>:<agent-slug>:shared`. Returns null unless the urn really has
 * that shape — at least three atoms and a `:shared` terminal — so a flat
 * `<root>:shared` can never be read as `<agent>:shared`.
 */
export function sharedUrnAgentSlug(urn: string | null | undefined): string | null {
  if (!urn) return null;
  const atoms = normalizeUrnForLookup(urn).split(':');
  if (atoms.length < 3) return null;
  if (atoms[atoms.length - 1] !== 'shared') return null;
  const slug = atoms[atoms.length - 2]!;
  if (slug.length === 0) return null;
  // `…:<agent>:app-mem:<name>` is a NAME-addressable createMemoryInApp memory
  // that happens to be called "shared" — the marker sits where the agent slug
  // would be, so exclude it rather than report a phantom "no Agent slugged
  // app-mem" every run.
  if (slug === 'app-mem') return null;
  return slug;
}

/**
 * The slugs an Agent could have contributed to that key: everything after the
 * first atom of its urn (the rule `findOrCreateAppClassMemory` minted with).
 * BOTH the current and the pre-#697 urn count — the Task-A sweep can have
 * re-slugged the Agent since the memory urn was written, and matching only the
 * current one would miss that Agent's own memory and provision a duplicate.
 */
export function agentSlugCandidates(agent: AgentSlugSource): string[] {
  const slugs = [agent.urn, agent.legacyUrn ?? null]
    .filter((u): u is string => !!u)
    .map((u) => normalizeUrnForLookup(u).split(':').slice(1).join(':'))
    .filter((s) => s.length > 0);
  return Array.from(new Set(slugs));
}

/**
 * Does this memory row carry the legacy string key of one of `agentSlugs`?
 * Checks `urn` and `legacyUrn` (the #697 sweep moves the compound form to the
 * latter), by parsed-atom equality.
 */
export function memoryCarriesLegacyKeyFor(
  memory: LegacyKeyedMemory,
  agentSlugs: readonly string[],
): boolean {
  const slug = sharedUrnAgentSlug(memory.urn) ?? sharedUrnAgentSlug(memory.legacyUrn);
  return slug !== null && agentSlugs.includes(slug);
}

/** True when the row's ADDRESS is still compound — its node URNs cannot round-trip. */
export function hasCompoundUrn(urn: string): boolean {
  return normalizeUrnForLookup(urn).split(':').length > 2;
}
