export {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  refreshAccessToken,
  fetchMicrosoftProfile,
} from './auth.js';
export type { TokenResponse, MicrosoftProfile } from './auth.js';
export {
  extractErrorMessage,
  listInboxMessages,
  getMessage,
  replyToMessage,
  moveMessage,
  listFolders,
  createFolder,
  createWebhookSubscription,
  renewWebhookSubscription,
  deleteWebhookSubscription,
} from './client.js';
export type { GraphMessage, GraphFolder, ListMessagesOptions, WebhookSubscription, GraphCallResult } from './client.js';
