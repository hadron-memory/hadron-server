/**
 * #3957 (cor:dmo:050:10) — an App's chats may pin one of the App's OWN AI configs by id.
 *
 * The one exception to "consumers reference a config by name only". Three pieces share this file so the write
 * checks and the read-time order cannot drift:
 *
 *  - {@link normalizeChatAiConfigChoice}: a chat's stored choice is `default` (a marker, not a config id) or one
 *    of the chat App's own config ids. Anything else — another App's config, a deleted one, one that never
 *    existed, or any id on a chat with no App — is refused with ONE answer, so the refusal reveals nothing about
 *    existence. A disabled own config is ACCEPTED (it is skipped at turn time until enabled again).
 *  - {@link pinnedConfigFor}: the order at turn time. The chat's stored choice, else `App.chatbotAiConfigId`,
 *    else nothing (the caller then walks `default` exactly as before). `default` stored on the chat skips the
 *    App's chatbot config. A pin counts only while its config exists, belongs to the chat's App and is enabled;
 *    otherwise it is skipped as if unset, so a disabled config never wins here either.
 *  - {@link listChatAiConfigChoices}: what a member may choose from. Never a key, key preview or endpoint.
 */
import type { Prisma, PrismaClient, AiServiceConfig } from '../generated/prisma/index.js';
import { AiServiceConfigNotFoundError } from './aiConfig.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** The marker a chat stores to mean "resolve `default` through the walk" — never a config id. */
export const CHAT_AI_CONFIG_DEFAULT_CHOICE = 'default';

/** Longest choice accepted before any lookup; config ids are far shorter. */
const MAX_CHOICE_LENGTH = 128;

/**
 * Validate a chat's choice against the chat's App. Returns the value to store: the marker or a config id of the
 * App. Every other input is the same refusal as a missing config.
 */
export async function normalizeChatAiConfigChoice(db: Db, appId: string | null, choice: string): Promise<string> {
  if (choice === CHAT_AI_CONFIG_DEFAULT_CHOICE) return choice;
  const refuse = (): never => { throw new AiServiceConfigNotFoundError(choice.slice(0, MAX_CHOICE_LENGTH)); };
  if (!appId || choice.length === 0 || choice.length > MAX_CHOICE_LENGTH) return refuse();
  const owned = await db.aiServiceConfig.findFirst({ where: { id: choice, appId }, select: { id: true } });
  return owned ? owned.id : refuse();
}

/**
 * The config a chat turn is pinned to, or null when the turn takes today's `default` walk unchanged.
 * `storedChoice` is the value kept with the chat (`default`, a config id, or absent).
 */
export async function pinnedConfigFor(db: Db, appId: string | null, storedChoice: unknown): Promise<AiServiceConfig | null> {
  if (!appId) return null;
  if (storedChoice === CHAT_AI_CONFIG_DEFAULT_CHOICE) return null;
  const usable = async (id: string): Promise<AiServiceConfig | null> =>
    db.aiServiceConfig.findFirst({ where: { id, appId, enabled: true } });
  if (typeof storedChoice === 'string' && storedChoice.length > 0) {
    const chosen = await usable(storedChoice);
    if (chosen) return chosen;
  }
  const app = await db.app.findUnique({ where: { id: appId }, select: { chatbotAiConfigId: true } });
  return app?.chatbotAiConfigId ? usable(app.chatbotAiConfigId) : null;
}

export interface ChatAiConfigChoice {
  /** `default` for the walk entry, else the config id: the value to send back as a choice. */
  value: string;
  name: string;
  provider: string | null;
  model: string | null;
  isDefault: boolean;
  isAppChatbotConfig: boolean;
}

/**
 * The App's own ENABLED configs plus the one `default` entry. A disabled config is not offered as usable. The
 * projection is chosen field by field: no key, key preview, params or endpoint can reach it.
 */
export async function listChatAiConfigChoices(db: Db, appId: string): Promise<ChatAiConfigChoice[]> {
  const [app, own] = await Promise.all([
    db.app.findUnique({ where: { id: appId }, select: { chatbotAiConfigId: true } }),
    db.aiServiceConfig.findMany({
      where: { appId, enabled: true },
      select: { id: true, name: true, provider: true, model: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  ]);
  return [
    { value: CHAT_AI_CONFIG_DEFAULT_CHOICE, name: CHAT_AI_CONFIG_DEFAULT_CHOICE, provider: null, model: null, isDefault: true, isAppChatbotConfig: false },
    ...own.map((c) => ({
      value: c.id, name: c.name, provider: c.provider, model: c.model, isDefault: false,
      isAppChatbotConfig: c.id === app?.chatbotAiConfigId,
    })),
  ];
}
