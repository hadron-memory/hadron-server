import { requestFirstEncryptionStorage, type FirstEncryptionEntry } from '../lib/requestKeys.js';
import { resolveMemoryRef } from '../lib/entityRef/memoryRef.js';
import { db } from '../integrations/db/client.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import type { Context } from '../api/graphql/schema/resolvers.js';
import { withTestOperationKey } from './operationKey.js';

export type EncryptionSecret = { dataKey?: string | null; passphrase?: string | null };

/**
 * #1796 step 2: `encryptMemory` takes no secret argument, so a direct resolver fixture hands its
 * secret over the way a request does, beside the operation.
 *
 * NOT equivalent to the header parser: it skips `x-hadron-memory-keys` parsing (an empty string reads
 * as absent, and an entry may carry both a `dataKey` and a `passphrase`, which the resolver then
 * refuses). The channel itself (parsing, staging, scrubbing) is pinned over real HTTP in
 * `resolvers.encryptMemoryHeader1796.test.ts` (first encryption, owner completion, App completion,
 * refusals); fixtures that only need a memory encrypted use this.
 *
 * The secret goes as:
 *  - the request's first-encryption entry (what the header stages), for an owner or a plaintext memory;
 *  - `x-hadron-operation-key` (`withTestOperationKey`, the App's real channel) for an App key principal
 *    completing an already-encrypted memory with a `dataKey`.
 *
 * The memory is resolved with the unwrapped client, never `ctx.db`, so a fixture that proxies or spies
 * `ctx.db` (locked-recheck hooks, pass hooks) sees no extra read.
 */
export async function withEncryptionSecret<T>(
  memoryRef: string,
  secret: EncryptionSecret,
  ctx: Context,
  run: () => Promise<T>,
): Promise<T> {
  const entry: FirstEncryptionEntry = {};
  if (secret.dataKey) entry.dataKey = secret.dataKey;
  if (secret.passphrase) entry.passphrase = secret.passphrase;
  if (!entry.dataKey && !entry.passphrase) return requestFirstEncryptionStorage.run(new Map(), run);
  const { id } = await resolveMemoryRef(db, memoryRef);
  const appCompletion = ctx.userId == null && !ctx.impersonation && !!ctx.appId && !!entry.dataKey && !entry.passphrase;
  if (appCompletion) {
    const row = await db.memory.findUnique({ where: { id }, select: { isEncrypted: true } });
    if (row?.isEncrypted) {
      return requestFirstEncryptionStorage.run(new Map(), () => withTestOperationKey(entry.dataKey!, ctx.appId, run));
    }
  }
  return requestFirstEncryptionStorage.run(new Map([[id, entry]]), run);
}

export async function encryptWithSecret(
  root: unknown,
  args: { memoryRef: string } & EncryptionSecret,
  ctx: Context,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the resolver answered `any` before; call sites read fields off it
): Promise<any> {
  const { memoryRef, dataKey, passphrase } = args;
  return withEncryptionSecret(memoryRef, { dataKey, passphrase }, ctx, () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (resolvers.Mutation as { encryptMemory: (r: unknown, a: { memoryRef: string }, c: Context) => Promise<any> })
      .encryptMemory(root, { memoryRef }, ctx));
}
