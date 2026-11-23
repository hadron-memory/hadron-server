/**
 * Telegram-connection write surface (#597). The bot is APP-owned (decision 2 of the Telegram decision record): the
 * org comes from the App, never from the caller. Registration forwards the bot token ONCE to the tool, which validates
 * it live and stores it encrypted; core keeps the identity only. The token is never stored, returned or logged here.
 */
import { GraphQLError } from 'graphql';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AmbiguousLegacyUrnError, AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { createTelegramToolConnection, deleteTelegramToolConnection } from '../../../lib/telegramClient.js';
import { dispatchChatToolTeardown, recordChatToolTeardown } from '../../../lib/chatToolTeardown.js';
import type { Context } from './resolvers.helpers.js';
import { isOrgMemberOrAdmin, requireOrgRole } from './resolvers.helpers.js';

const ALREADY_CONNECTED = 'This App already has a Telegram connection.';
const BOT_ALREADY_CONNECTED = 'This bot is already connected.';

export const telegramMutations = {
  /**
   * Register a bot for an App: ADMIN/OWNER of the App's org. A caller who may not (a member, a revoked member, another
   * org's admin) and an App that does not exist, is in no org, or is not found all get the ONE refusal, so the
   * mutation is no existence oracle for Apps. One active connection per App, judged before the tool is called (the
   * token goes nowhere for a request that was going to be refused) and again by the partial unique under a race.
   */
  createTelegramConnection: async (
    _: unknown,
    { appRef, botToken }: { appRef: string; botToken: string },
    ctx: Context,
  ) => {
    let appId: string;
    try {
      appId = (await resolveAppRef(ctx.db, appRef)).id;
    } catch (err) {
      // An ambiguous legacy URN names two Apps: another org's admin must not tell it apart from an unknown App.
      if (err instanceof AppNotFoundError || err instanceof AmbiguousLegacyUrnError) throw authorizationDenied();
      throw err;
    }
    const app = await ctx.db.app.findUnique({ where: { id: appId }, select: { organizationId: true } });
    if (!app?.organizationId) throw authorizationDenied(); // a user-owned App has no org to hold the role
    const organizationId = app.organizationId;
    await requireOrgRole(ctx, organizationId, 'ADMIN');

    const existing = await ctx.db.telegramConnection.findFirst({ where: { appId, deletedAt: null }, select: { id: true } });
    if (existing) throw new GraphQLError(ALREADY_CONNECTED, { extensions: { code: 'BAD_USER_INPUT' } });

    // The tool validates the token live and derives the bot identity; the token goes no further than this call.
    const identity = await createTelegramToolConnection('telegram', { botToken, appId });

    // App and org deletion DO tear the tool row down (#4828, src/lib/chatToolTeardown.ts, shared with Slack). A lost
    // registration response (#4829) is covered by the registrationKey sent above: the retry re-derives it and a tool
    // that supports it returns the same connection.
    // EVERY failure past this point tears the tool row down, or the tool would hold an encrypted token and a poll
    // loop with no core row and no GraphQL handle to delete them.
    try {
      return await ctx.db.telegramConnection.create({
        data: {
          organizationId,
          appId,
          toolConnectionId: identity.id,
          botId: identity.botId,
          botUsername: identity.botUsername,
          displayName: identity.displayName,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });
    } catch (err) {
      // Tear the tool row down only if no live core row already holds that tool id: if the tool ever handed back an
      // id the winner owns, deleting it would kill the winner's bot. (The tool today refuses a duplicate bot with a
      // 400 and never returns an existing id; this guard does not depend on that.) A failed lookup skips the teardown.
      const heldByCore = await ctx.db.telegramConnection
        .count({ where: { toolConnectionId: identity.id, deletedAt: null } })
        .then((n) => n > 0, () => true);
      if (!heldByCore) void deleteTelegramToolConnection('telegram', identity.id);
      // A concurrent duplicate meets the PARTIAL unique (telegram_connections_app_active_uniq): same answer as the pre-check.
      // Two partial uniques can refuse the write: one ACTIVE connection per App and one per bot. Do not read the driver's
      // target spelling; ask the database which one holds: the App has a live row, or the bot is taken elsewhere.
      if ((err as { code?: string } | null)?.code === 'P2002') {
        const appTaken = await ctx.db.telegramConnection.findFirst({ where: { appId, deletedAt: null }, select: { id: true } });
        throw new GraphQLError(appTaken ? ALREADY_CONNECTED : BOT_ALREADY_CONNECTED, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      throw err;
    }
  },

  /** Soft-delete + best-effort tool teardown. Missing, other-org and revoked-member answer identically (NOT_FOUND). */
  deleteTelegramConnection: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const connection = await ctx.db.telegramConnection.findFirst({ where: { id: ref, deletedAt: null } });
    if (!connection || !(await isOrgMemberOrAdmin(ctx, connection.organizationId))) {
      throw new GraphQLError('Telegram connection not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    await requireOrgRole(ctx, connection.organizationId, 'ADMIN');
    // App and org deletion tear their connections down through the shared path in src/lib/chatToolTeardown.ts (#4828); this is the single-connection door.
    // The guarded soft delete and the teardown INTENT are one transaction (#4847): a concurrent double delete records and asks the tool once,
    // and a call that fails or is lost is retried by the sweep. A deleted row stays NOT_FOUND to an admin: no door reaches it (cor:dmo:080:04).
    const torn = await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.telegramConnection.updateMany({
        where: { id: connection.id, deletedAt: null },
        data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
      });
      if (count !== 1) return null;
      return recordChatToolTeardown(tx, { kind: 'telegram', id: connection.id, provider: connection.provider, toolConnectionId: connection.toolConnectionId });
    });
    if (torn) dispatchChatToolTeardown([torn]);
    return true;
  },
};
