/**
 * #1677 / DAP: compare worker names without rewriting their permanent spelling.
 * NFKC, then UTS #39's Unicode 16 skeleton (rev 28 §4):
 * NFD, remove default ignorables, map prototypes, NFD. This is the traditional
 * code-point skeleton, not a bidi-display profile or a charset restriction.
 * https://www.unicode.org/reports/tr39/tr39-28.html#Confusable_Detection
 * Tables are pinned; upgrades require review of naming-equivalence changes.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { CASE_FOLD, CONFUSABLES } from './unicode/workerNameData.js';

export function workerNameSkeleton(name: string): string {
  const decomposed = name.trim().normalize('NFKC').normalize('NFD')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  return Array.from(decomposed, (c) => CONFUSABLES.get(c.codePointAt(0)!) ?? c)
    .join('').normalize('NFD');
}

function caseFold(name: string): string {
  return Array.from(name.trim().normalize('NFKC'), (c) => CASE_FOLD.get(c.codePointAt(0)!) ?? c).join('');
}

// Keep the original-case skeleton as well as the caseless one: folding first
// alone loses real uppercase confusables (Greek Μ → Latin M, but μ ≠ m).
// The third key folds the skeleton's prototype, so a lookalike of ANY case
// variant collides: `Μira` → `Mira` → `mira` meets a stored lowercase `mira`.
export function workerNameComparisonKeys(name: string): readonly string[] {
  const skeleton = workerNameSkeleton(name);
  return [...new Set([skeleton, workerNameSkeleton(caseFold(name)), workerNameSkeleton(caseFold(skeleton))])];
}

export function findConfusableWorker<T extends { name: string }>(name: string, workers: readonly T[]): T | undefined {
  const keys = new Set(workerNameComparisonKeys(name));
  return workers.find((worker) => workerNameComparisonKeys(worker.name).some((key) => keys.has(key)));
}

/** Serialize naming with insertion; call inside the SAME transaction as the cast/apply. */
export async function lockWorkerNames(tx: Prisma.TransactionClient, appId: string): Promise<void> {
  // NO KEY UPDATE permits the cast's own App FK checks, and shares the normal
  // App-first ordering with team apply. No new persistent identity is minted.
  await tx.$queryRaw`SELECT id FROM apps WHERE id = ${appId} FOR NO KEY UPDATE`;
}

/** Caller must authorize staffing before revealing collision details. Retired names count. */
export async function assertWorkerNameNotConfusable(
  db: Pick<Prisma.TransactionClient, 'worker'>, appId: string, name: string,
): Promise<void> {
  const workers = await db.worker.findMany({ where: { appId }, orderBy: { id: 'asc' }, select: { id: true, name: true } });
  const collision = findConfusableWorker(name, workers);
  if (collision) {
    throw new GraphQLError(`Worker name ${JSON.stringify(name)} is confusable with ${JSON.stringify(collision.name)} in this App. Pick a distinct name.`, {
      extensions: { code: 'WORKER_NAME_CONFUSABLE', appId, name, collidingName: collision.name, workerId: collision.id },
    });
  }
}
