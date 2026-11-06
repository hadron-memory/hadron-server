/** cor:int:010:01 / ruling 0201: configuration prevented an attempt; no sync state was written. */
export const SYNC_NOT_ATTEMPTED = 'SYNC_NOT_ATTEMPTED';
export type SyncNotAttemptedReason = 'NO_SOURCE' | 'NO_INSTALLATION';
export const syncNotAttemptedMessage = (reason: SyncNotAttemptedReason): string =>
  `Sync was not attempted: ${reason}.`;
