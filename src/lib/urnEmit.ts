/**
 * Grammar-v2 URN EMISSION helpers (#697 Stage 2 — the emission flip).
 *
 * The platform now EMITS flat v2 URNs (`hrn:mem:<root>:<slug>`, single colon,
 * `mem` type word) instead of the v1 canonical form (`hrn:memory:<org>::<slug>`,
 * `::` hierarchy). Input parsing stays Postel-liberal — every v1 spelling is
 * still accepted (#239) and resolves via the urn-lib `mem`→`memory` alias
 * (Stage 1) and the stored alias map (Task A).
 *
 * Emission composes from a row's STORED bare urn (already the flat v2 body after
 * the Task A backfill — `<root>:<slug>`), stripping a legacy `@` owner sigil and
 * collapsing any residual `::` first, then routing through `composeUrnV2`. A
 * stored form that can't compose (corrupt / not-yet-minted-v2) is the caller's
 * problem to fall back on (see `safeCanonicalUrn`).
 *
 * NODE/EDGE caveat — the memory MUST be a single slug atom. A still-COMPOUND
 * memory urn (`<root>:<agent>:app-user:<id>`, minted before the Stage-3 minting
 * flip) emits a flat node URN whose memory boundary can't be recovered by
 * `splitNodeUrn` (it takes the first two atoms as the memory). This is NOT a
 * regression — the pre-flip v1 `::` form mis-split identically — and it self-
 * heals once Stage 3 makes every memory single-atom. Simple memories (all
 * migrated + org-owned) round-trip cleanly.
 */

import { composeUrnV2, normalizeUrnForLookup } from './urn.js';

/** v1/`CanonicalUrnType` type word → its v2 spelling (only `memory` renames). */
const V2_TYPE_WORD: Record<string, string> = {
  memory: 'mem',
  mem: 'mem',
  org: 'org',
  agent: 'agent',
  app: 'app',
};

/**
 * Decompose a stored bare urn into its flat v2 atoms: strip a leading `@`
 * (the retired spec-047 owner sigil — v2 roots carry no sigil), collapse any
 * canonical `::` to single `:`, and split. `@holger:notes` → `['holger','notes']`.
 */
function bareAtoms(bareUrn: string): [root: string, ...segments: string[]] {
  const stripped = bareUrn.startsWith('@') ? bareUrn.slice(1) : bareUrn;
  const [root, ...segments] = normalizeUrnForLookup(stripped).split(':');
  if (!root) throw new Error(`urnEmit: empty root in "${bareUrn}"`);
  return [root, ...segments];
}

/**
 * Emit the flat v2 URN for a root-level entity (memory / agent / app / org) from
 * its stored bare urn. `memory` emits with the `mem` type word; the rest keep
 * their type word. Throws `UrnParseError` on an un-v2-able stored form.
 */
export function emitEntityUrnV2(type: 'memory' | 'mem' | 'org' | 'agent' | 'app', bareUrn: string): string {
  const v2type = V2_TYPE_WORD[type];
  if (!v2type) throw new Error(`emitEntityUrnV2: unsupported type "${type}"`);
  return composeUrnV2(v2type, ...bareAtoms(bareUrn));
}

/** Emit `hrn:node:<root>:<mem>:<loc…>` from a memory's bare urn + a node loc. */
export function emitNodeUrnV2(memBareUrn: string, loc: string): string {
  const [root, ...mem] = bareAtoms(memBareUrn);
  return composeUrnV2('node', root, ...mem, ...loc.split(':'));
}

/** Emit `hrn:edge:<root>:<mem>:<loc…>` from a memory's bare urn + an edge loc. */
export function emitEdgeUrnV2(memBareUrn: string, loc: string): string {
  const [root, ...mem] = bareAtoms(memBareUrn);
  return composeUrnV2('edge', root, ...mem, ...loc.split(':'));
}

/**
 * Emit `hrn:asset:<root>:<mem>:assets:<asset-id>` from a memory's bare urn + an
 * asset id (the v2 `asset` shape, `cor:urn:010:01`).
 */
export function emitAssetUrnV2(memBareUrn: string, assetId: string): string {
  const [root, ...mem] = bareAtoms(memBareUrn);
  return composeUrnV2('asset', root, ...mem, 'assets', assetId);
}

/**
 * Emit the v2 URN for an installed agent. Per D10 an installed agent stays
 * AUTHOR-ROOTED forever — there is no install-chain form in v2 — so this is just
 * the agent's own author-rooted v2 URN (the v1 `<org>::<app>::<author>:<slug>`
 * R2 shape is retired).
 */
export function emitInstalledAgentUrnV2(agentBareUrn: string): string {
  return emitEntityUrnV2('agent', agentBareUrn);
}
