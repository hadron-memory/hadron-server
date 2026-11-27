// Worker slug minting — #991 (cor:dmo:050:11, cor:agt:020:02).
//
// A Worker's URN is `hrn:worker:<root>:<app-slug>:<slug>`, and `slug` is a
// stored column DERIVED from the worker's name at cast time. The name itself
// cannot be the URN atom: cor:agt:020:02 leaves names unconstrained (any
// display string is castable), and PR #979 deliberately allows two names to
// slugify to one token ("Mary Jane" / "Mary-Jane" -> `mary-jane`). A
// name-derived URN would therefore stop resolving to exactly one worker, which
// cor:urn:010:02 forbids.
//
// The rule that keeps this from becoming a second ALLOCATION layer — which
// cor:agt:020:02 does forbid, and which is why the mention-token unique was
// reverted in PR #979 — is that minting NEVER REFUSES. It advances to `-2`,
// `-3`, … until it finds a free atom. A caller can only ever observe one
// allocation failure, WORKER_NAME_TAKEN, exactly as before this existed.

import { deriveSlugFromName } from './urn.js';
import { derivedSlugCandidate, isReservedSlug } from './derivedSlug.js';

/**
 * The fallback base for a name that slugifies to nothing ("!!!", "ミ"). Such a
 * name is legal — cor:agt:020:02 constrains nothing but blankness — so it must
 * stay castable; the iteration then yields `worker`, `worker-2`, …
 */
export const WORKER_SLUG_FALLBACK = 'worker';

/**
 * Slugify a worker name into its base atom, with the fallback for names that
 * leave nothing usable. Pure — no uniqueness applied.
 */
export function workerSlugBase(name: string): string {
  try {
    return deriveSlugFromName(name);
  } catch {
    // `empty-derived-slug` — nothing in the charset survived.
    return WORKER_SLUG_FALLBACK;
  }
}

/**
 * The `n`th slug candidate for `base` (1-indexed: n=1 IS the bare base), capped at the 64-char atom limit. The one
 * implementation lives in `derivedSlug.ts` (#5203 S3), shared by every door that derives a slug from a name.
 */
export const workerSlugCandidate = derivedSlugCandidate;

/** The slice of Prisma this module needs — keeps it trivially unit-testable. */
type WorkerSlugDb = {
  worker: {
    findMany: (args: {
      where: { appId: string; OR: { slug: string | { startsWith: string } }[] };
      select: { slug: true };
    }) => Promise<{ slug: string }[]>;
  };
};

/**
 * The first slug atom free for `name` within `appId`.
 *
 * Advisory, not authoritative: `workers_app_slug_uniq` is what actually
 * arbitrates, and two concurrent casts deriving one base can both read the same
 * free candidate. The caller re-runs this on the resulting P2002 (see
 * `castWorker`), which is why this never needs a lock — it is the same
 * constraint-is-the-primitive shape the name allocation uses, minus the refusal.
 *
 * Retired workers hold their slug forever (the index is unfiltered), so they are
 * counted here too.
 */
export async function nextFreeWorkerSlug(
  db: WorkerSlugDb,
  appId: string,
  name: string,
): Promise<string> {
  const base = workerSlugBase(name);
  // One query, not one per candidate: everything that could collide starts with
  // the base. `startsWith` over-matches (`iris-team` for base `iris`), which
  // only ever makes the taken set larger — never wrong.
  const rows = await db.worker.findMany({
    where: { appId, OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }] },
    select: { slug: true },
  });
  const taken = new Set(rows.map((r) => r.slug));
  // Terminates: `taken` is finite, and only a bare base can be a reserved word (a suffixed candidate ends in `-<n>`,
  // which no reserved word does), so some n yields an unseen, unreserved candidate.
  for (let n = 1; ; n++) {
    const candidate = workerSlugCandidate(base, n);
    // #5203 S3: a reserved word is skipped like a taken slug (cor:urn:010:01), case-insensitively.
    if (!taken.has(candidate) && !isReservedSlug(candidate)) return candidate;
  }
}
