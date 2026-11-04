/** #3361: shared wire claim for both automation-grant families; admission remains in the server protocol. */
import { z } from 'zod';
export const AUTOMATION_GRANT_INSTRUCTION = z.object({
  kind: z.enum(['TEAM_CHAT_MESSAGE', 'TASK', 'LIVE_CHAT']), ref: z.string().min(1),
}).nullish().describe('Holder instruction reference, never prose. A held worker may revoke/list within its own App; no instruction-enabled give.');
