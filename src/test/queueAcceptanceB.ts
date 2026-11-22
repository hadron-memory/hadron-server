// Throwaway for the #4819 merge-queue acceptance: a new caller of the helper's OLD name. Green alone, breaks tsc with PR A.
import { describeLockHolders } from './lockWait.js';
export const queueAcceptanceB = describeLockHolders;
