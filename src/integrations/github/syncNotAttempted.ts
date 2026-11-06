/** cor:int:010:01 / ruling 0201: configuration prevented an attempt; no sync state was written. */
export const SYNC_NOT_ATTEMPTED = 'SYNC_NOT_ATTEMPTED';
export type SyncNotAttemptedReason = 'NO_SOURCE' | 'NO_INSTALLATION';
export const syncNotAttemptedMessage = (reason: SyncNotAttemptedReason): string =>
  `Sync was not attempted: ${reason}. ${reason === 'NO_SOURCE'
    ? 'Configure a source repository before syncing.'
    : 'Install the GitHub App for this organization before syncing.'}`;
