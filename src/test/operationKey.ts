import { requestOperationKeyStorage, stageRequestOperationKey } from '../lib/requestOperationKey.js';

/** Give direct resolver fixtures the same per-request key staging as HTTP. */
export function withTestOperationKey<F extends () => unknown>(key: string | undefined, appId: string | null | undefined, call: F): ReturnType<F> {
  return requestOperationKeyStorage.run({}, () => {
    stageRequestOperationKey(key, { appId });
    return call() as ReturnType<F>;
  });
}
