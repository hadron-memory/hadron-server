/** Direct-resolver tests supply the same request scope as the HTTP middleware. */
import { parseDataKey } from '../lib/crypto.js';
import { requestOperationKeyStorage } from '../lib/requestOperationKey.js';

export async function withOperationKey<T>(dataKey: string | undefined, run: () => T): Promise<Awaited<T>> {
  return await requestOperationKeyStorage.run({ key: dataKey ? parseDataKey(dataKey) : undefined }, run);
}
