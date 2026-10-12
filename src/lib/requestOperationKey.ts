/**
 * #1796: key supply for App operations whose target is being provisioned or
 * promoted. Unlike memory unlock, no encrypted target exists at header time.
 * The existing operation gates decide authority and verify any existing key.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { timingSafeEqual } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { parseDataKey, type EncryptionKey } from './crypto.js';

export const OPERATION_KEY_HEADER = 'x-hadron-operation-key';
export const requestOperationKeyStorage = new AsyncLocalStorage<{ key?: EncryptionKey }>();

export function getRequestOperationKey(): EncryptionKey | null {
  return requestOperationKeyStorage.getStore()?.key ?? null;
}

/** Authenticate before parsing; never put this secret in Context or a global cache. */
export function stageRequestOperationKey(
  header: string | string[] | undefined,
  principal: { appId?: string | null; userId?: string | null; impersonation?: unknown },
): void {
  if (header === undefined) return;
  if (!principal.appId) {
    throw new GraphQLError('Operation key supply requires an authenticated App context.', {
      extensions: { code: principal.userId ? 'FORBIDDEN' : 'UNAUTHENTICATED' },
    });
  }
  if (principal.impersonation) {
    throw new GraphQLError('Operation key supply is unavailable under impersonation.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
  // Canonical base64 for exactly 32 bytes. Bound input before decoding and
  // refuse duplicates/malformed input without echoing any caller value.
  if (typeof header !== 'string' || header.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(header)) {
    throw new GraphQLError('Operation key must be one base64-encoded 32-byte key.', {
      extensions: { code: 'BAD_UNLOCK_INPUT' },
    });
  }
  const key = parseDataKey(header);
  if (key.raw.toString('base64') !== header) {
    throw new GraphQLError('Operation key must be one base64-encoded 32-byte key.', {
      extensions: { code: 'BAD_UNLOCK_INPUT' },
    });
  }
  const store = requestOperationKeyStorage.getStore();
  if (!store) throw new Error('Operation key staging requires a request scope.');
  store.key = key;
}


/** The temporary legacy path has the same caller gates; dual supply must agree. */
export function resolveRequestOperationKey(dataKey?: string | null): EncryptionKey | null {
  const supplied = getRequestOperationKey();
  if (!supplied) return dataKey ? parseDataKey(dataKey) : null;
  if (dataKey == null) return supplied;
  let legacy: EncryptionKey;
  try {
    legacy = parseDataKey(dataKey);
  } catch {
    throw new GraphQLError('Supplied operation keys must agree.', {
      extensions: { code: 'BAD_UNLOCK_INPUT' },
    });
  }
  if (!timingSafeEqual(supplied.raw, legacy.raw)) {
    throw new GraphQLError('Supplied operation keys must agree.', {
      extensions: { code: 'BAD_UNLOCK_INPUT' },
    });
  }
  return supplied;
}
