/**
 * #1218 — OWNING OPERATIONS and the governed signals they must carry.
 *
 * ## The ruling
 *
 * @Holger, 2026-09-19: `extractParentNodeGraph`, `cloneMemory` and git sync are
 * all **owning operations**. One answer to a question #1205, #1210 and #1213
 * were each asking separately.
 *
 * The governed-role gate (#1201/#1203, `governedRole.ts`) refuses any caller
 * that would PRODUCE a governed node — except the operation that owns that kind
 * (`if (entry.kind === owns) continue`). Declaring these three owning means they
 * carry the governed signals across rather than dropping them, and the gate does
 * not refuse them for doing so.
 *
 * ## Why this module exists rather than three field additions
 *
 * The naive fix is `role: n.role` at three sites. `protectedLoc.ts` already
 * names why that is not enough — *a gate a caller can omit*: if every site keeps
 * its own copy, the FOURTH subtree-copying operation added next year forgets,
 * and the failure is silent. A governed node arrives ungoverned, which is
 * exactly today's bug wearing a later date.
 *
 * So the set of signals is named ONCE, here, and **derived from the register**
 * rather than hand-listed. A fourth governed kind keyed on a new column extends
 * this set automatically; a hand-written list would not, and its drift would be
 * invisible for the same reason the current one was.
 *
 * ## Preserve vs mint — they are NOT the same operation
 *
 * - **extract / clone COPY.** They preserve whatever the source row carried and
 *   must never mint a signal the source lacked. A copy that invents governance
 *   is as wrong as one that drops it.
 * - **git sync SETS**, because for a mirrored memory the repo is the source of
 *   truth. A principal with repo write can therefore set `role: 'review'` by
 *   committing a file. That is not new exposure — they already author node
 *   content wholesale — but it becomes true the moment the signal crosses the
 *   mirror, so it is written down here rather than discovered later.
 *
 * ## The trap in the sync direction, measured
 *
 * Git sync does **not** currently un-govern anything, contrary to the framing
 * in #1218: its update payload omits both signals, and a Prisma `update` that
 * omits a field PRESERVES it (driven against a real row — a node written with
 * `role: 'review'` survives the sync-shaped update unchanged). The defect there
 * is narrower and is #1205 on the tin: the signals cannot be EXPRESSED in the
 * repo, so they do not round-trip and a memory rebuilt from its mirror loses
 * them.
 *
 * Which makes the obvious fix actively dangerous: adding `role: node.role ??
 * null` to that payload would set `role` → NULL on every sync for every file on
 * disk, because no existing mirrored file carries the key. That is
 * un-governing on a schedule, with nothing refused, INTRODUCED by the fix for
 * it. Hence `governedSignalsFromMirror`: absent ⇒ omit the key ⇒ preserve.
 */

import { GOVERNED_KINDS } from './governedRole.js';

/**
 * The node columns the governed-kind gate keys on, derived from the register so
 * the two cannot drift. Today: `isRunnable` (task) and `role` (review, spec).
 */
export const GOVERNED_SIGNAL_FIELDS = [
  ...new Set(GOVERNED_KINDS.map((e) => e.signal.field)),
] as readonly GovernedSignalField[];

/** Every column the register keys on, as a union taken FROM the register. */
export type GovernedSignalField = (typeof GOVERNED_KINDS)[number]['signal']['field'];

/** A node row's governed signals, as a copy operation sees them. */
export interface GovernedSignals {
  role: string | null;
  isRunnable: boolean | null;
}

/**
 * The derivation above is only worth having if the HELPERS move with it
 * (@copilot, PR #1221 — and the finding is sharp: deriving the field list while
 * the functions below hard-code two keys makes the promise "a fourth governed
 * kind extends the carry automatically" FALSE, which is a claim outrunning its
 * evidence in the one place that claims to prevent drift).
 *
 * This is that promise made structural: if a register entry ever keys on a
 * column `GovernedSignals` does not declare, the next line stops compiling and
 * names it. A test asserting the two agree would catch the same thing one run
 * later; a type error catches it before the code exists.
 */
type UnhandledSignalField = Exclude<GovernedSignalField, keyof GovernedSignals>;
const _everySignalFieldIsHandled: UnhandledSignalField extends never ? true : never = true;
void _everySignalFieldIsHandled;

/**
 * What an OWNING COPY (extract, clone) must carry from source row to new row.
 *
 * Preserves, never mints: every field comes from `source` and nothing is
 * defaulted to a governed value. Spread into the row literal so a reader sees
 * the signals arrive as one named act rather than as two fields among twenty —
 * which is how `role` came to be missing while `isRunnable` was present.
 */
export function carryGovernedSignals(source: {
  role?: string | null;
  isRunnable?: boolean | null;
}): GovernedSignals {
  // ITERATES the derived set rather than naming two keys (@copilot round 3,
  // PR #1221). The type-level exhaustiveness check above catches a register
  // entry `GovernedSignals` does not DECLARE; it cannot catch one this
  // function does not MAP. Walking `GOVERNED_SIGNAL_FIELDS` closes that half,
  // so the module's promise holds in the body as well as the type.
  const out: Record<string, unknown> = {};
  for (const field of GOVERNED_SIGNAL_FIELDS) {
    out[field] = (source as Record<string, unknown>)[field] ?? null;
  }
  return out as unknown as GovernedSignals;
}

/**
 * What a MIRROR IMPORT (git sync) should write, given the parsed frontmatter.
 *
 * Returns a PARTIAL on purpose, and the partiality is the whole point: a key
 * absent from the file is omitted from the result, so a Prisma `update` leaves
 * the stored value alone. Three cases, and the middle one is the one every
 * naive implementation gets wrong:
 *
 * | frontmatter | result | effect on an existing row |
 * |---|---|---|
 * | `role: review` | `{ role: 'review' }` | set — the repo speaking as source of truth |
 * | *(key absent)* | `{}` | **preserved** — no opinion is not an instruction to clear |
 * | `role: null` | `{ role: null }` | cleared — an explicit, deliberate un-govern |
 *
 * On the CREATE path the same partial yields a row with the column at its
 * default (null), which is correct: a new node whose file declares no signal
 * has none.
 */
export function governedSignalsFromMirror(parsed: {
  role?: string | null;
  isRunnable?: boolean | null;
}): Partial<GovernedSignals> {
  // Same iteration as the carry, for the same reason — a new register field
  // must not be silently unmapped here while the type check passes.
  const src = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of GOVERNED_SIGNAL_FIELDS) {
    if (field in src && src[field] !== undefined) out[field] = src[field] ?? null;
  }
  return out as Partial<GovernedSignals>;
}
