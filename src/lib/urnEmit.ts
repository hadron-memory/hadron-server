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

import { composeActionUrnV2, composeUrnV2, normalizeUrnForLookup } from './urn.js';

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

/**
 * Read-path root-entity emission that CANNOT throw: byte-identical to
 * {@link emitEntityUrnV2} for well-formed data, and on an un-v2-able stored form
 * it logs the offending row and serves the RAW stored value instead.
 *
 * Same failure class and remedy as {@link safeNodeUrnV2} (#298): a single legacy
 * or corrupted row must not take down the whole query — serve it, log it, repair
 * the data separately. This is the one implementation of that fallback for root
 * entities; `safeCanonicalUrn` (the GraphQL field-resolver wrapper) delegates
 * here for exactly these four type words, so the two can't drift.
 *
 * Note the fallback differs from the node/edge one: a stored ENTITY urn is a bare
 * `<root>:<slug>` body with no `hrn:` prefix, so there is no "v2-shaped" join to
 * synthesize — the honest fallback is the stored value verbatim, which is what
 * every pre-#697 caller already emitted.
 */
export function safeEntityUrnV2(
  type: 'memory' | 'mem' | 'org' | 'agent' | 'app',
  bareUrn: string,
): string {
  try {
    return emitEntityUrnV2(type, bareUrn);
  } catch (err) {
    console.warn(
      `[safeEntityUrnV2] stored ${type} urn ${JSON.stringify(bareUrn)} is not emittable as a v2 ` +
        'URN; serving the raw stored value. The STORED value needs repair — this is not a ' +
        'malformed caller request:',
      err,
    );
    return bareUrn;
  }
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
 * Emit `hrn:action:<root>:<agent-slug>:<code>` — the #2610 action-register
 * address (cor:urn:010:01, Proposed) — from the HOLDING Agent's bare urn + a
 * register-entry code. The root and slug are the Agent's own (`hrn:agent:
 * <root>:<slug>`), so a child Agent's override entry addresses under its own
 * slug; the leaf is the code, a permanent authored atom that must satisfy the
 * slug charset and the 64-character bound (`task.finish.open-children` is
 * valid). Composition REFUSES an invalid code by throwing: the caller is about
 * to write or serve an address, and an atom the grammar rejects can never
 * resolve back. Read paths that must not throw catch and null (never a
 * best-effort string — a wrong action URN is worse than none).
 */
export function emitActionUrnV2(agentBareUrn: string, code: string): string {
  const [root, ...segments] = bareAtoms(agentBareUrn);
  // The container is ONE slug — the grammar has no ownership chain, and an
  // agent urn that isn't `<root>:<slug>` cannot key an action address.
  if (segments.length !== 1) {
    throw new Error(`urnEmit: agent urn "${agentBareUrn}" is not a single-slug root form`);
  }
  return composeActionUrnV2(root, segments[0]!, code);
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
 * A memory's ROOT node carries `loc === ''`. That is a SUPPORTED shape, not
 * corruption: git-sync maps it to the repo-root `README.md`
 * (`src/integrations/github/nodeFrontmatter.ts` — "the empty-loc root node maps
 * to the repo-root README.md"), and every memory has one.
 *
 * The v2 grammar has no URN for it — `''.split(':')` is a single EMPTY atom, and
 * `composeUrnV2` rejects that — so strict emission throws. That is a gap in the
 * grammar, not a bad row, and it must not be reported as one: there are as many
 * of these as there are memories, so logging each read as corruption is both
 * wrong and loud, and it invites someone to "repair" a root node's loc, which
 * would break the README mapping.
 *
 * What a root node's canonical URN SHOULD be is a grammar question for
 * `cor:urn:010:01`, deliberately not decided here. Until it is, the best-effort
 * form (`hrn:node:<root>:<mem>:`) is served and flagged as a fallback, so it
 * still never becomes a link.
 */
function isExpectedRootNodeEmission(type: 'node' | 'edge', memBareUrn: string, loc: string): boolean {
  // NODES only. An EDGE loc is the edge's identity (spec 037) and is always
  // derived non-empty by `deriveEdgeLoc`, so an empty edge loc is real
  // corruption and must stay loud.
  if (type !== 'node' || loc !== '') return false;
  // The throw must be attributable to the empty LOC and nothing else. Re-emit
  // with a minimal valid loc atom: if that succeeds, the memory portion is
  // sound and the empty loc was the only problem. If it still throws, the
  // stored MEMORY urn is corrupt or still compound (see the NODE/EDGE caveat
  // above) — a genuine defect that happens to be sitting under a root node,
  // and exactly the case a blanket `loc === ''` check would have hidden.
  try {
    emitNodeUrnV2(memBareUrn, ROOT_PROBE_ATOM);
    return true;
  } catch {
    return false;
  }
}

/** Minimal valid atom used to prove a memory urn emits independently of the loc. */
const ROOT_PROBE_ATOM = 'x';

/**
 * Shared strict-then-fallback emit. Logs enough to locate the offending ROW —
 * the strict error names the composed URN, never the stored `loc`/memory that
 * produced it, which is what makes a genuinely bad row so hard to trace.
 *
 * The try/catch (rather than an up-front `isRootNodeLoc` branch) is deliberate:
 * behaviour stays driven by what the emitter can actually do, so if the grammar
 * later gains a root-node URN this starts emitting it with no change here.
 */
function safeEmit(type: 'node' | 'edge', memBareUrn: string, loc: string): SafeUrnEmission {
  try {
    const urn = type === 'node' ? emitNodeUrnV2(memBareUrn, loc) : emitEdgeUrnV2(memBareUrn, loc);
    return { urn, fellBack: false };
  } catch (err) {
    // Known-shape root node on a sound memory: fall back silently, it is not a
    // defect. Everything else — including an empty EDGE loc, and a root node
    // whose memory urn is itself un-emittable — still warns.
    if (!isExpectedRootNodeEmission(type, memBareUrn, loc)) {
      console.warn(
        `[safeUrnEmit] stored ${type} loc ${JSON.stringify(loc)} in memory "${memBareUrn}" is not ` +
          'emittable as a v2 URN; serving a best-effort form. The STORED value needs repair — ' +
          'this is not a malformed caller request:',
        err,
      );
    }
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

/**
 * Whether the node URN emitted for `(memBareUrn, loc)` can be SPLIT BACK into
 * that same memory and that same loc — i.e. whether it round-trips through
 * `resolveNodeRef`, and is therefore safe to hand a client as an ADDRESS.
 *
 * **It performs the round trip; it does not reason about the shape** (Codex +
 * Copilot on PR #1172, round 3). An atom-count predicate looked sufficient and
 * was not: it says yes to a stored `@holger:notes` (the sigil is stripped on
 * emission but is part of the stored `urn` the resolver matches on) and to a
 * malformed loc (`safeEmit` serves an unvalidated best-effort join, which the
 * resolver need not accept). Both were false positives on exactly the promise
 * this predicate exists to keep. Emitting and re-splitting catches those, the
 * compound-memory case, and any later divergence between the two halves,
 * because the check IS the claim rather than a proxy for it.
 *
 * What it rejects, all for one reason — the emitted string does not name this
 * row back:
 *
 *   - a stored PRE-v2 COMPOUND memory urn — the legacy team space
 *     `<org>:<app>:<agent>:shared` (`resolveAppTeamSpaceMemoryIds`), a
 *     per-user `<org>:<agent>:app-user:<id>` — since the v2 grammar gives a
 *     memory ONE atom under its root and the resolver splits on the same
 *     assumption, so `hrn:node:org:app:agent:shared:chats:team` reads as
 *     memory `org:app` plus loc `agent:shared:chats:team`;
 *   - a stored `@`-sigil urn, which emission strips and lookup does not;
 *   - anything `safeEmit` had to fall back on (a corrupt loc or atom).
 *
 * A stored CANONICAL `<root>::<slug>` passes: it normalizes to the same flat
 * pair, and `resolveNodeRef` tries both spellings against the `urn` column.
 *
 * Emission is NOT wrong to flatten — that is the v2 shape, and #697 exists to
 * flatten the stored urns. This is the narrower question to ask before
 * PROMISING a URN back: emit nothing rather than something the server rejects
 * (`findings:graphql-urn-canonical-on-read`,
 * `findings:compound-app-mem-node-addressing`).
 *
 * The re-split mirrors `resolveNodeRef`'s single-colon path deliberately, and
 * a differential test pins the two together over a table of stored shapes — if
 * that resolver's splitting rule changes, the test fails here.
 */
export function nodeUrnRoundTrips(memBareUrn: string, loc: string): boolean {
  const emitted = safeEmit('node', memBareUrn, loc);
  // The fallback is an unvalidated join by construction — never an address.
  if (emitted.fellBack) return false;
  const body = emitted.urn.startsWith('hrn:node:') ? emitted.urn.slice('hrn:node:'.length) : null;
  if (body === null) return false;
  const parts = body.split(':');
  if (parts.length < 3) return false;
  // resolveNodeRef's single-colon path: two atoms of memory, the rest is loc.
  const memoryCandidate = `${parts[0]}:${parts[1]}`;
  const locCandidate = parts.slice(2).join(':');
  let stored: string;
  try {
    stored = normalizeUrnForLookup(memBareUrn);
  } catch {
    return false;
  }
  return memoryCandidate === stored && locCandidate === loc;
}
