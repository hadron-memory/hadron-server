import 'isomorphic-fetch';
import { Client } from '@microsoft/microsoft-graph-client';
import { refreshAccessToken } from './auth.js';

export interface ListMessagesOptions {
  top?: number;
  skip?: number;
  filter?: string;
  select?: string[];
  orderby?: string;
}

export interface GraphMessage {
  id: string;
  subject: string | null;
  from: { emailAddress: { name: string; address: string } } | null;
  receivedDateTime: string;
  isRead: boolean;
  bodyPreview: string;
  body: { contentType: string; content: string } | null;
  hasAttachments: boolean;
}

export interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

function createGraphClient(accessToken: string): Client {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });
}

/** Extract a human-readable message from Graph/MSAL errors. */
export function extractErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  if (err instanceof Error) {
    const graphErr = err as any;
    if (graphErr.body) {
      try {
        const body = typeof graphErr.body === 'string' ? JSON.parse(graphErr.body) : graphErr.body;
        if (body?.error?.message) return body.error.message;
      } catch { /* ignore parse errors */ }
    }
    if (graphErr.code) return `${graphErr.code}: ${graphErr.message}`;
    return graphErr.message || String(err);
  }
  return String(err);
}

/**
 * Result of a token-refreshing Graph API call.
 * If the refresh token was rotated, newRefreshToken is set.
 */
export interface GraphCallResult<T> {
  data: T;
  newRefreshToken?: string;
}

/**
 * Execute a Graph API call using a refresh token.
 * Handles 401 retry by re-acquiring a fresh access token.
 * Uses /me endpoints (delegated permissions — acts as the signed-in user).
 */
async function withToken<T>(
  refreshToken: string,
  fn: (client: Client) => Promise<T>,
): Promise<GraphCallResult<T>> {
  const tokenRes = await refreshAccessToken(refreshToken);
  const client = createGraphClient(tokenRes.access_token);
  try {
    const data = await fn(client);
    return {
      data,
      // If Microsoft rotated the refresh token, pass it back for storage
      newRefreshToken: tokenRes.refresh_token !== refreshToken ? tokenRes.refresh_token : undefined,
    };
  } catch (err: any) {
    // 429 → respect Retry-After header
    if (err?.statusCode === 429) {
      const retryAfter = parseInt(err?.headers?.get?.('Retry-After') ?? '5', 10);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      const data = await fn(client);
      return { data };
    }
    throw err;
  }
}

// ── Mail operations (all use /me — delegated, acts as the user) ─────────

export async function listInboxMessages(
  refreshToken: string,
  options: ListMessagesOptions = {},
): Promise<GraphCallResult<GraphMessage[]>> {
  return withToken(refreshToken, async (client) => {
    let request = client
      .api('/me/mailFolders/inbox/messages')
      .top(options.top ?? 25)
      .orderby(options.orderby ?? 'receivedDateTime DESC');

    if (options.skip) request = request.skip(options.skip);
    if (options.filter) request = request.filter(options.filter);
    if (options.select) request = request.select(options.select);

    const response = await request.get();
    return response.value as GraphMessage[];
  });
}

export async function getMessage(
  refreshToken: string,
  messageId: string,
): Promise<GraphCallResult<GraphMessage>> {
  return withToken(refreshToken, async (client) => {
    return client.api(`/me/messages/${messageId}`).get();
  });
}

export async function replyToMessage(
  refreshToken: string,
  messageId: string,
  body: string,
): Promise<GraphCallResult<void>> {
  return withToken(refreshToken, async (client) => {
    await client.api(`/me/messages/${messageId}/reply`).post({
      comment: body,
    });
  });
}

export async function moveMessage(
  refreshToken: string,
  messageId: string,
  destinationFolderId: string,
): Promise<GraphCallResult<void>> {
  return withToken(refreshToken, async (client) => {
    await client.api(`/me/messages/${messageId}/move`).post({
      destinationId: destinationFolderId,
    });
  });
}

export async function listFolders(
  refreshToken: string,
): Promise<GraphCallResult<GraphFolder[]>> {
  return withToken(refreshToken, async (client) => {
    const response = await client.api('/me/mailFolders').get();
    return response.value as GraphFolder[];
  });
}

export async function createFolder(
  refreshToken: string,
  displayName: string,
): Promise<GraphCallResult<GraphFolder>> {
  return withToken(refreshToken, async (client) => {
    return client.api('/me/mailFolders').post({ displayName });
  });
}

// ── Webhook subscription management ────────────────────────────────────

export interface WebhookSubscription {
  id: string;
  expirationDateTime: string;
}

export async function createWebhookSubscription(
  refreshToken: string,
  notificationUrl: string,
  clientState: string,
): Promise<GraphCallResult<WebhookSubscription>> {
  const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60000);

  return withToken(refreshToken, async (client) => {
    return client.api('/subscriptions').post({
      changeType: 'created',
      notificationUrl,
      resource: '/me/mailFolders/inbox/messages',
      expirationDateTime: expiry.toISOString(),
      clientState,
    });
  });
}

export async function renewWebhookSubscription(
  refreshToken: string,
  subscriptionId: string,
): Promise<GraphCallResult<WebhookSubscription>> {
  const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60000);

  return withToken(refreshToken, async (client) => {
    return client.api(`/subscriptions/${subscriptionId}`).patch({
      expirationDateTime: expiry.toISOString(),
    });
  });
}

export async function deleteWebhookSubscription(
  refreshToken: string,
  subscriptionId: string,
): Promise<GraphCallResult<void>> {
  return withToken(refreshToken, async (client) => {
    await client.api(`/subscriptions/${subscriptionId}`).delete();
  });
}
