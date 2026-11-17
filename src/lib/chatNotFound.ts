import { GraphQLError } from 'graphql';

/** #3582 / cor:api:140:03: a missing or concealed chat echoes only the caller's selector, never a resolved identity. */
export function chatNotFoundError(chatId: string): GraphQLError {
  return new GraphQLError(`Chat "${chatId}" not found`, { extensions: { code: 'CHAT_NOT_FOUND' } });
}
