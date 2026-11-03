/**
 * #3016 — deleteUser: a SUPPLIED but blank userRef is refused, never read as "me".
 *
 * Only an omitted (or null) userRef means the caller's own account
 * (cor:aut:020:03). A ref that is present but empty after JS `.trim()`
 * names nobody: it is refused with BAD_USER_INPUT before any principal check
 * or target resolution, so every caller (platform admin or not) gets the same
 * answer and the caller's account is untouched. Blank shapes pinned: '', ' ',
 * a lone U+FEFF BOM (JS trim strips it, Go TrimSpace keeps it — the
 * hadron-cli#1488 probe), and ideographic space + tab.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const BLANK_REFS: Array<[string, string]> = [
  ['empty string', ''],
  ['single space', ' '],
  ['lone U+FEFF BOM', '﻿'],
  ['space + ideographic space + tab', ' 　\t'],
];

let seq = 0;

async function makeUser(roles: ('ADMIN' | 'OWNER' | 'READER')[] = ['READER']) {
  seq += 1;
  const tag = `${Date.now()}-${seq}`;
  return db.user.create({
    data: {
      id: generateId(),
      handle: `blank-ref-${tag}`,
      name: `Blank Ref ${tag}`,
      email: `blank-ref-${tag}@example.com`,
      roles,
    },
  });
}

function userCtx(user: { id: string; roles: string[] }): Context {
  return { db, userId: user.id, roles: user.roles as Context['roles'] };
}

type DeleteArgs = { userRef?: string | null; reason?: string | null };
const deleteUser = (
  resolvers.Mutation as unknown as {
    deleteUser: (p: unknown, a: DeleteArgs, c: Context) => Promise<boolean>;
  }
).deleteUser;

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(GraphQLError);
    return (error as GraphQLError).extensions?.code as string | undefined;
  }
  return 'NO_ERROR';
}

async function isLive(userId: string): Promise<boolean> {
  const row = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true } });
  return row !== null && row.deletedAt === null;
}

beforeEach(async () => {
  await cleanDb(db);
});

describe('#3016 deleteUser — supplied blank userRef is BAD_USER_INPUT, never self', () => {
  for (const [label, ref] of BLANK_REFS) {
    it(`non-admin caller, ${label}: refused, account intact`, async () => {
      const me = await makeUser(['READER']);
      expect(await codeOf(deleteUser(undefined, { userRef: ref }, userCtx(me)))).toBe('BAD_USER_INPUT');
      expect(await isLive(me.id)).toBe(true);
    });

    it(`platform admin caller, ${label}: same refusal, account intact`, async () => {
      const admin = await makeUser(['ADMIN']);
      expect(
        await codeOf(deleteUser(undefined, { userRef: ref, reason: 'cleanup' }, userCtx(admin))),
      ).toBe('BAD_USER_INPUT');
      expect(await isLive(admin.id)).toBe(true);
    });
  }
});

describe('#3016 deleteUser — omitted and null userRef still delete self', () => {
  it('omitted userRef deletes the caller', async () => {
    const me = await makeUser(['READER']);
    expect(await deleteUser(undefined, {}, userCtx(me))).toBe(true);
    expect(await isLive(me.id)).toBe(false);
  });

  it('null userRef deletes the caller', async () => {
    const me = await makeUser(['READER']);
    expect(await deleteUser(undefined, { userRef: null }, userCtx(me))).toBe(true);
    expect(await isLive(me.id)).toBe(false);
  });
});
