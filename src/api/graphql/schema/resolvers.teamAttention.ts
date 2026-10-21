/** #1353 — internal-pilot GraphQL surface for worker-owned attention. */

import type { Context } from './resolvers.helpers.js';
import {
  confirmTeamAttentionSwitchover,
  getTeamAttention,
  markOwnTeamChatRead,
  previewTeamAttentionSwitchover,
  teamAttentionPage as teamAttentionPageLib,
  teamAttentionPreviewPage as teamAttentionPreviewPageLib,
} from '../../../lib/teamAttention.js';

export const teamAttentionQueries = {
  teamAttention: async (
    _: unknown,
    { appRef, since }: { appRef: string; since?: string | null },
    ctx: Context,
  ) => getTeamAttention(ctx, appRef, since),

  teamAttentionPage: async (
    _: unknown,
    { appRef, since, page, limit, scanLimit }: { appRef: string; since?: string | null; page?: string | null; limit?: number | null; scanLimit?: number | null },
    ctx: Context,
  ) => teamAttentionPageLib(ctx, appRef, { since, page, limit, scanLimit }),

  teamAttentionPreviewPage: async (
    _: unknown,
    { appRef, page, limit, scanLimit }: { appRef: string; page?: string | null; limit?: number | null; scanLimit?: number | null },
    ctx: Context,
  ) => teamAttentionPreviewPageLib(ctx, appRef, { page, limit, scanLimit }),

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
      expectedIncarnation,
    }: { appRef: string; sessionRef: string; channelRef: string; seq: number; expectedIncarnation?: number | null },
    ctx: Context,
  ) => markOwnTeamChatRead(ctx, { appRef, sessionRef, channelRef, seq, expectedIncarnation }),

  confirmTeamAttentionSwitchover: async (
    _: unknown,
    { appRef, proof }: { appRef: string; proof: string },
    ctx: Context,
  ) => confirmTeamAttentionSwitchover(ctx, appRef, proof),
};
