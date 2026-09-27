/** #1353 — internal-pilot GraphQL surface for worker-owned attention. */

import type { Context } from './resolvers.helpers.js';
import {
  confirmTeamAttentionSwitchover,
  getTeamAttention,
  markOwnTeamChatRead,
  previewTeamAttentionSwitchover,
} from '../../../lib/teamAttention.js';

export const teamAttentionQueries = {
  teamAttention: async (
    _: unknown,
    { appRef, since }: { appRef: string; since?: string | null },
    ctx: Context,
  ) => getTeamAttention(ctx, appRef, since),

  teamAttentionSwitchoverPreview: async (
    _: unknown,
    { appRef }: { appRef: string },
    ctx: Context,
  ) => previewTeamAttentionSwitchover(ctx, appRef),
};

export const teamAttentionMutations = {
  markOwnTeamChatRead: async (
    _: unknown,
    {
      appRef,
      sessionRef,
      channelRef,
      seq,
    }: { appRef: string; sessionRef: string; channelRef: string; seq: number },
    ctx: Context,
  ) => markOwnTeamChatRead(ctx, { appRef, sessionRef, channelRef, seq }),

  confirmTeamAttentionSwitchover: async (
    _: unknown,
    { appRef, proof }: { appRef: string; proof: string },
    ctx: Context,
  ) => confirmTeamAttentionSwitchover(ctx, appRef, proof),
};
