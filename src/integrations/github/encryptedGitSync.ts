/**
 * R206 (cor:sec:040:05, cor:int:010:01): an encrypted memory never syncs to or
 * from Git in either direction, whatever key a request, session or cache holds.
 * One code and one message so every refusing surface reports the same typed
 * reason; explicit sync/push throw it, a post-commit mirror logs it and skips
 * (the committed database mutation is never failed or rolled back).
 */
export const ENCRYPTED_GIT_SYNC_UNAVAILABLE = 'ENCRYPTED_GIT_SYNC_UNAVAILABLE' as const;

export const ENCRYPTED_GIT_SYNC_MESSAGE =
  'Git sync cannot read or write an encrypted memory, with or without its data key.';

/** Observable typed skip for a mirror path that was attempted on an encrypted memory. */
export function logEncryptedGitSyncRefusal(path: string, memoryId: string): void {
  console.warn(`[git-mirror] ${ENCRYPTED_GIT_SYNC_UNAVAILABLE}: refusing ${path} for encrypted memory ${memoryId}`);
}
