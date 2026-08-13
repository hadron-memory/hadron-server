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

/**
 * Best-effort flat-v2 fallback for a node/edge URN — used ONLY on a catch path
 * when the strict `emit{Node,Edge}UrnV2` throws (a corrupt or not-yet-v2-minted
 * stored memory urn). Unlike the strict emitters it does NOT validate atom
 * charset, so it can never throw; it just strips a legacy `@` owner sigil and
 * collapses any residual `::` so the result stays single-colon, `hrn:`-prefixed
 * v2-SHAPED (matching the emission grammar) instead of reverting to a v1 `::`
 * form. Keeps the non-null `.urn` fields serve-and-log rather than crash-the-query.
 */
export function bestEffortFlatNodeUrn(type: 'node' | 'edge', memBareUrn: string, loc: string): string {
  const mem = (memBareUrn.startsWith('@') ? memBareUrn.slice(1) : memBareUrn).replace(/::/g, ':');
  return `hrn:${type}:${mem}:${loc}`;
}

export interface SafeUrnEmission {
  urn: string;
  /**
   * `true` when strict emission failed and `urn` is the UNVALIDATED best-effort
   * join. Such a URN may contain anything the stored loc did — including `/`,
   * `?`, and `#`, which change the structure of a URL it is interpolated into.
   * Callers that put a URN somewhere structural (a link, a redirect) must check
   * this and degrade; callers that only display it can ignore it.
   */
  fellBack: boolean;
}

/**
 * Shared strict-then-fallback emit. Logs enough to locate the offending ROW —
 * the strict error names the composed URN, never the stored `loc`/memory that
 * produced it, which is what makes this corruption class so hard to trace.
 */
function safeEmit(type: 'node' | 'edge', memBareUrn: string, loc: string): SafeUrnEmission {
  try {
    const urn = type === 'node' ? emitNodeUrnV2(memBareUrn, loc) : emitEdgeUrnV2(memBareUrn, loc);
    return { urn, fellBack: false };
  } catch (err) {
    console.warn(
      `[safeUrnEmit] stored ${type} loc ${JSON.stringify(loc)} in memory "${memBareUrn}" is not ` +
        'emittable as a v2 URN; serving a best-effort form. The STORED value needs repair — ' +
        'this is not a malformed caller request:',
      err,
    );
    return { urn: bestEffortFlatNodeUrn(type, memBareUrn, loc), fellBack: true };
  }
}

/** {@link safeNodeUrnV2}, but reporting whether the value is the unvalidated fallback. */
export function safeNodeUrnV2Result(memBareUrn: string, loc: string): SafeUrnEmission {
  return safeEmit('node', memBareUrn, loc);
}

/**
 * Read-path node-URN emission that CANNOT throw. Byte-identical to
 * {@link emitNodeUrnV2} for well-formed data; on a stored form the strict
 * emitter rejects it logs the offending row and returns the best-effort flat
 * join instead.
 *
 * Why this exists: a render path composes a URN for the subject node AND every
 * edge neighbour, so ONE malformed stored `loc` anywhere in the graph would
 * otherwise throw and fail the WHOLE response. The thrown reason is
 * `invalid-segment-shape` ("wrong number of ':'-separated parts"), which reads
 * as if the CALLER's URN were malformed — so the failure gets misdiagnosed as a
 * URN-grammar bug. The commonest trigger is a `loc` carrying an EMPTY atom (a
 * leading, trailing, or doubled `:`), which `validateLoc` rejects today but
 * older rows and non-`upsertNode` write paths can still contain.
 *
 * Same failure class and same remedy as `safeCanonicalUrn` (#298): serve the
 * row, log the corruption, repair the data separately.
 *
 * A fallback URN is NOT safe to interpolate into a URL — use
 * {@link safeNodeUrnV2Result} and check `fellBack` when the value becomes a link.
 */
export function safeNodeUrnV2(memBareUrn: string, loc: string): string {
  return safeEmit('node', memBareUrn, loc).urn;
}

/** Read-path edge-URN emission that cannot throw. See {@link safeNodeUrnV2}. */
export function safeEdgeUrnV2(memBareUrn: string, loc: string): string {
  return safeEmit('edge', memBareUrn, loc).urn;
}
