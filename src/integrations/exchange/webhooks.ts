/**
 * Exchange webhook subscription lifecycle management.
 *
 * - Creates subscriptions when a new Exchange connection is made
 *   (inbox for new-email notifications, sentItems for learning from edits)
 * - Renews subscriptions before they expire (Graph has 3-day max TTL)
 * - Cleans up stale subscriptions
 */

import { createDecipheriv } from 'crypto';
import { db } from '../db/client.js';
import {
  createWebhookSubscription,
  renewWebhookSubscription,
  deleteWebhookSubscription,
} from './client.js';

function decryptToken(ciphertext: string): string {
  const keyBuf = Buffer.from(process.env.HADRON_ENCRYPTION_KEY ?? '', 'hex');
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function getWebhookUrl(): string {
  const url = process.env.EXCHANGE_WEBHOOK_URL;
  if (!url) {
    const base = process.env.BASE_URL || 'http://localhost:4000';
    return `${base}/exchange/webhook`;
  }
  return url;
}

/**
 * Create webhook subscriptions for an Exchange connection.
 * Registers both inbox (new emails) and sentItems (for learning from edits).
 * Called after OAuth completes.
 */
export async function registerWebhook(connectionId: string): Promise<void> {
  const connection = await db.exchangeConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.deletedAt) return;

  const refreshToken = decryptToken(connection.refreshTokenEncrypted);
  const notificationUrl = getWebhookUrl();

  // Register inbox webhook
  if (!connection.webhookSubscriptionId) {
    try {
      const { data: subscription } = await createWebhookSubscription(
        refreshToken,
        notificationUrl,
        connectionId,
        '/me/mailFolders/inbox/messages',
      );

      await db.exchangeConnection.update({
        where: { id: connectionId },
        data: {
          webhookSubscriptionId: subscription.id,
          webhookExpiresAt: new Date(subscription.expirationDateTime),
        },
      });

      console.log(`[exchange-webhook] Inbox subscription created for ${connection.mailboxEmail} (expires: ${subscription.expirationDateTime})`);
    } catch (err) {
      console.error(`[exchange-webhook] Failed to create inbox subscription for ${connection.mailboxEmail}:`, err);
    }
  }

  // Register sentItems webhook (for learning from professor edits)
  if (!connection.sentWebhookSubscriptionId) {
    try {
      // Use a prefixed clientState so the handler can distinguish inbox vs sentItems
      const { data: subscription } = await createWebhookSubscription(
        refreshToken,
        notificationUrl,
        `sent:${connectionId}`,
        '/me/mailFolders/sentItems/messages',
      );

      await db.exchangeConnection.update({
        where: { id: connectionId },
        data: {
          sentWebhookSubscriptionId: subscription.id,
          sentWebhookExpiresAt: new Date(subscription.expirationDateTime),
        },
      });

      console.log(`[exchange-webhook] SentItems subscription created for ${connection.mailboxEmail} (expires: ${subscription.expirationDateTime})`);
    } catch (err) {
      console.error(`[exchange-webhook] Failed to create sentItems subscription for ${connection.mailboxEmail}:`, err);
    }
  }
}

/**
 * Renew all webhook subscriptions that expire within the next 12 hours.
 * Call this on a timer (e.g. every 6 hours).
 */
export async function renewExpiringWebhooks(): Promise<void> {
  const cutoff = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours from now

  // Renew inbox webhooks
  const inboxConnections = await db.exchangeConnection.findMany({
    where: {
      deletedAt: null,
      syncEnabled: true,
      webhookSubscriptionId: { not: null },
      webhookExpiresAt: { lt: cutoff },
    },
  });

  console.log(`[exchange-webhook] Renewing ${inboxConnections.length} expiring inbox subscriptions`);

  for (const connection of inboxConnections) {
    try {
      const refreshToken = decryptToken(connection.refreshTokenEncrypted);
      const { data: renewed } = await renewWebhookSubscription(
        refreshToken,
        connection.webhookSubscriptionId!,
      );

      await db.exchangeConnection.update({
        where: { id: connection.id },
        data: { webhookExpiresAt: new Date(renewed.expirationDateTime) },
      });

      console.log(`[exchange-webhook] Renewed inbox subscription for ${connection.mailboxEmail}`);
    } catch (err) {
      console.error(`[exchange-webhook] Failed to renew inbox for ${connection.mailboxEmail}:`, err);

      // If renewal fails (subscription deleted/expired), re-register
      try {
        await db.exchangeConnection.update({
          where: { id: connection.id },
          data: { webhookSubscriptionId: null, webhookExpiresAt: null },
        });
        await registerWebhook(connection.id);
      } catch {
        console.error(`[exchange-webhook] Inbox re-registration also failed for ${connection.mailboxEmail}`);
      }
    }
  }

  // Renew sentItems webhooks
  const sentConnections = await db.exchangeConnection.findMany({
    where: {
      deletedAt: null,
      syncEnabled: true,
      sentWebhookSubscriptionId: { not: null },
      sentWebhookExpiresAt: { lt: cutoff },
    },
  });

  console.log(`[exchange-webhook] Renewing ${sentConnections.length} expiring sentItems subscriptions`);

  for (const connection of sentConnections) {
    try {
      const refreshToken = decryptToken(connection.refreshTokenEncrypted);
      const { data: renewed } = await renewWebhookSubscription(
        refreshToken,
        connection.sentWebhookSubscriptionId!,
      );

      await db.exchangeConnection.update({
        where: { id: connection.id },
        data: { sentWebhookExpiresAt: new Date(renewed.expirationDateTime) },
      });

      console.log(`[exchange-webhook] Renewed sentItems subscription for ${connection.mailboxEmail}`);
    } catch (err) {
      console.error(`[exchange-webhook] Failed to renew sentItems for ${connection.mailboxEmail}:`, err);

      try {
        await db.exchangeConnection.update({
          where: { id: connection.id },
          data: { sentWebhookSubscriptionId: null, sentWebhookExpiresAt: null },
        });
        await registerWebhook(connection.id);
      } catch {
        console.error(`[exchange-webhook] SentItems re-registration also failed for ${connection.mailboxEmail}`);
      }
    }
  }
}

/**
 * Ensure all active connections have webhook subscriptions (both inbox and sentItems).
 * Run at server startup.
 */
export async function ensureAllWebhooks(): Promise<void> {
  const connections = await db.exchangeConnection.findMany({
    where: {
      deletedAt: null,
      syncEnabled: true,
      OR: [
        { webhookSubscriptionId: null },
        { sentWebhookSubscriptionId: null },
      ],
    },
  });

  console.log(`[exchange-webhook] ${connections.length} connections missing webhooks, registering...`);

  for (const connection of connections) {
    await registerWebhook(connection.id);
  }
}

/**
 * Start the webhook renewal timer. Call once at server startup.
 * Renews every 6 hours and ensures new connections are covered.
 */
export function startWebhookLifecycle(): void {
  // Initial: ensure all connections have webhooks
  ensureAllWebhooks().catch((err) =>
    console.error('[exchange-webhook] Initial webhook setup failed:', err),
  );

  // Renew every 6 hours
  setInterval(() => {
    renewExpiringWebhooks().catch((err) =>
      console.error('[exchange-webhook] Renewal cycle failed:', err),
    );
  }, 6 * 60 * 60 * 1000);
}
