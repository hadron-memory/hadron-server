/**
 * #1353 — the explicit own-worker mark-read mutation (the attention poll/page and
 * the switchover that shared this file were retired by #2027 S11; renamed by #4509 from its
 * pre-S11 name). Everything else the wake/mark path needs lives in
 * `lib/ownWorkerSessions.js` (the resume rules, the read-cursor advance, the fence).
 */
import type { Context } from './resolvers.helpers.js';
import { markOwnTeamChatRead } from '../../../lib/ownWorkerSessions.js';

export const ownWorkerSessionsMutations = {
  markOwnTeamChatRead: async (
    _: unknown,
    {
      appRef,
      sessionRef,
      channelRef,
      seq,
      expectedIncarnation,
    }: { appRef: string; sessionRef: string; channelRef: string; seq: number; expectedIncarnation?: number | null },
    ctx: Context,
  ) => markOwnTeamChatRead(ctx, { appRef, sessionRef, channelRef, seq, expectedIncarnation }),
};
