/**
 * Exchange webhook subscription lifecycle management.
 *
 * - Creates subscriptions when a new Exchange connection is made
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
 * Create a webhook subscription for an Exchange connection.
 * Called after OAuth completes.
 */
export async function registerWebhook(connectionId: string): Promise<void> {
  const connection = await db.exchangeConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.deletedAt) return;

  const refreshToken = decryptToken(connection.refreshTokenEncrypted);
  const notificationUrl = getWebhookUrl();

  try {
    // clientState carries the connectionId so the handler can look it up
    const { data: subscription } = await createWebhookSubscription(
      refreshToken,
      notificationUrl,
      connectionId,
    );

    await db.exchangeConnection.update({
      where: { id: connectionId },
      data: {
        webhookSubscriptionId: subscription.id,
        webhookExpiresAt: new Date(subscription.expirationDateTime),
      },
    });

    console.log(`[exchange-webhook] Subscription created for ${connection.mailboxEmail} (expires: ${subscription.expirationDateTime})`);
  } catch (err) {
    console.error(`[exchange-webhook] Failed to create subscription for ${connection.mailboxEmail}:`, err);
  }
}

/**
 * Renew all webhook subscriptions that expire within the next 12 hours.
 * Call this on a timer (e.g. every 6 hours).
 */
export async function renewExpiringWebhooks(): Promise<void> {
  const cutoff = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours from now

  const connections = await db.exchangeConnection.findMany({
    where: {
      deletedAt: null,
      syncEnabled: true,
      webhookSubscriptionId: { not: null },
      webhookExpiresAt: { lt: cutoff },
    },
  });

  console.log(`[exchange-webhook] Renewing ${connections.length} expiring subscriptions`);

  for (const connection of connections) {
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

      console.log(`[exchange-webhook] Renewed subscription for ${connection.mailboxEmail}`);
    } catch (err) {
      console.error(`[exchange-webhook] Failed to renew for ${connection.mailboxEmail}:`, err);

      // If renewal fails (subscription deleted/expired), re-register
      try {
        await registerWebhook(connection.id);
      } catch {
        console.error(`[exchange-webhook] Re-registration also failed for ${connection.mailboxEmail}`);
      }
    }
  }
}

/**
 * Ensure all active connections have webhook subscriptions.
 * Run at server startup.
 */
export async function ensureAllWebhooks(): Promise<void> {
  const connections = await db.exchangeConnection.findMany({
    where: {
      deletedAt: null,
      syncEnabled: true,
      webhookSubscriptionId: null,
    },
  });

  console.log(`[exchange-webhook] ${connections.length} connections without webhooks, registering...`);

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
