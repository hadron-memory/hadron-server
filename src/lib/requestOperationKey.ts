/**
 * #1796: key supply for App operations whose target is being provisioned or
 * promoted. Unlike memory unlock, no encrypted target exists at header time.
 * The existing operation gates decide authority and verify any existing key.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { GraphQLError } from 'graphql';
import { parseDataKey, type EncryptionKey } from './crypto.js';

export const OPERATION_KEY_HEADER = 'x-hadron-operation-key';
export const requestOperationKeyStorage = new AsyncLocalStorage<{ key?: EncryptionKey; consumed?: boolean }>();

/** Presence checks do not consume; they are only for the session mode gate. */
export function hasRequestOperationKey(): boolean {
  return requestOperationKeyStorage.getStore()?.key !== undefined;
}

/** Claim the staged key once, before an operation can perform any writes. */
export function getRequestOperationKey(): EncryptionKey | null {
  const store = requestOperationKeyStorage.getStore();
  if (!store?.key) return null;
  if (store.consumed) {
    throw new GraphQLError('An operation key may be consumed only once per request.', {
      extensions: { code: 'BAD_UNLOCK_INPUT' },
    });
  }
  // Claim even a failed attempt: retaining the staged key and its consumed
  // flag ensures a later consuming field refuses before its own writes.
  store.consumed = true;
  return store.key;
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
