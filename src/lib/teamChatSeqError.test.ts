import { expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/index.js';
import { withTeamChatSeqRefusal } from './teamChatSeqError.js';

it('translates only the private SQLSTATE and drops all connector diagnostics', async () => {
  const raw = new Prisma.PrismaClientUnknownRequestError(
    'Invalid invocation with private-row\nError occurred during query execution:\nConnectorError(PostgresError { code: "P0992", message: "TEAM_CHAT_SEQ_CONFLICT", severity: "ERROR", detail: None, column: None, hint: None })',
    { clientVersion: 'test' },
  );
  const result = await withTeamChatSeqRefusal(() => Promise.reject(raw)).catch((e) => e);
  expect(result.extensions.code).toBe('TEAM_CHAT_SEQ_CONFLICT');
  expect(result.cause).toBeUndefined();
  expect(result.originalError).toBeUndefined();
  expect(result.stack).not.toMatch(/private-row|P0992|PostgresError/);
  const known = new Prisma.PrismaClientKnownRequestError('private raw SQL', { code: 'P2010', clientVersion: 'test', meta: { code: 'P0992' } });
  await expect(withTeamChatSeqRefusal(() => Promise.reject(known))).rejects.toMatchObject({ extensions: { code: 'TEAM_CHAT_SEQ_CONFLICT' } });
});

it('preserves unrelated failures and ignores markers in caller-controlled invocation text', async () => {
  const other = new Prisma.PrismaClientUnknownRequestError(
    'caller text: PostgresError { code: "P0992", message: "TEAM_CHAT_SEQ_CONFLICT", severity: "ERROR", detail: None, column: None, hint: None }\nError occurred during query execution:\nconnection refused',
    { clientVersion: 'test' },
  );
  await expect(withTeamChatSeqRefusal(() => Promise.reject(other))).rejects.toBe(other);
  const plain = new Error('TEAM_CHAT_SEQ_CONFLICT P0992');
  await expect(withTeamChatSeqRefusal(() => Promise.reject(plain))).rejects.toBe(plain);
});
