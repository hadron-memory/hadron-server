import { requestFirstEncryptionStorage, type FirstEncryptionEntry } from '../lib/requestKeys.js';
import { resolveMemoryRef } from '../lib/entityRef/memoryRef.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import type { Context } from '../api/graphql/schema/resolvers.js';

/**
 * #1796 step 2: `encryptMemory` takes no secret argument, so a direct resolver fixture hands its
 * secret over the way `x-hadron-memory-keys` does over HTTP: as the request's first-encryption
 * entry, which the resolver claims once and judges with the same gates (owner, class, verifier on a
 * completion). `secret` is exactly the old `dataKey` / `passphrase` pair; with neither, the call
 * carries no entry, as a request that sent no header entry would.
 *
 * The channel itself (header parsing, staging, scrubbing) is pinned over real HTTP in
 * `resolvers.encryptMemoryHeader1796.test.ts`; fixtures that only need a memory encrypted use this.
 */
export async function encryptWithSecret(
  root: unknown,
  args: { memoryRef: string; dataKey?: string | null; passphrase?: string | null },
  ctx: Context,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the resolver answered `any` before; call sites read fields off it
): Promise<any> {
  const { memoryRef, dataKey, passphrase } = args;
  const entry: FirstEncryptionEntry = {};
  if (dataKey) entry.dataKey = dataKey;
  if (passphrase) entry.passphrase = passphrase;
  const store = new Map<string, FirstEncryptionEntry>();
  if (entry.dataKey || entry.passphrase) {
    const { id } = await resolveMemoryRef(ctx.db, memoryRef);
    store.set(id, entry);
  }
  return requestFirstEncryptionStorage.run(store, () =>
    (resolvers.Mutation as { encryptMemory: (r: unknown, a: { memoryRef: string }, c: Context) => Promise<any> })
      .encryptMemory(root, { memoryRef }, ctx));
}
