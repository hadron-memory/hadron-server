export {
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
  refreshAccessToken,
  fetchMicrosoftProfile,
  decodeIdToken,
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
  createDraftReply,
  sendDraft,
  updateDraft,
  deleteDraft,
  listDraftMessages,
  flagMessage,
  categorizeMessage,
  setMessageReadStatus,
  createWebhookSubscription,
  renewWebhookSubscription,
  deleteWebhookSubscription,
} from './client.js';
export type { GraphMessage, GraphFolder, ListMessagesOptions, WebhookSubscription, GraphCallResult, MessageFlag } from './client.js';
