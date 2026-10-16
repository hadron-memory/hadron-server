import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/index.js';

/**
 * #992: translate ONLY the private constraint's fixed SQLSTATE marker.
 * Raw connector diagnostics (including a colliding row) never reach callers.
 * Covers create/update/upsert/bulk/clone on the shared Prisma write seam.
 */
export async function withTeamChatSeqRefusal<T>(write: () => Promise<T>): Promise<T> {
  try { return await write(); }
  catch (error) {
    const unknown = error instanceof Prisma.PrismaClientUnknownRequestError
      ? error.message.slice(error.message.lastIndexOf('Error occurred during query execution:')) : '';
    const marker = /PostgresError \{ code: "P0992", message: "TEAM_CHAT_SEQ_CONFLICT", severity: "ERROR", detail: None, column: None, hint: None \}/;
    const matches = (error instanceof Prisma.PrismaClientKnownRequestError && error.meta?.code === 'P0992') ||
      (unknown.startsWith('Error occurred during query execution:') && marker.test(unknown));
    if (matches) {
      throw new GraphQLError('That sequence is already occupied in this team chat, including its deleted messages.', {
        extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' },
      });
    }
    throw error;
  }
}
