/** #2025 / cor:agt:080:05,:19 — delivery settings; ticker floor remains the sole cadence/window dial. */
import type { Context } from './resolvers.helpers.js';
import { resolveParticipatedApp } from './resolvers.agentTask.js';
import type { ActInstruction } from '../../../lib/auth/instructedAct.js';
import { writeAppSettings, writeTeamPause } from './resolvers.ticker.js';
import { loadDeliverySettings } from '../../../lib/tickers/deliverySettings.js';

export const deliverySettingsQueries = {
  appDeliverySettings: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    const { app } = await resolveParticipatedApp(ctx, appRef);
    return loadDeliverySettings(ctx.db, app.id);
  },
};
export const deliverySettingsMutations = {
  setAppDeliverySettings: async (_: unknown, { appRef, input, instruction }: { appRef: string; input: unknown; instruction?: ActInstruction | null }, ctx: Context) =>
    (await writeAppSettings(ctx, appRef, {}, input === undefined ? null : input, instruction)).delivery,
  setTeamPause: async (_: unknown, { appRef, paused, instruction }: { appRef: string; paused: boolean; instruction?: ActInstruction | null }, ctx: Context) =>
    writeTeamPause(ctx, appRef, paused, instruction),
};
