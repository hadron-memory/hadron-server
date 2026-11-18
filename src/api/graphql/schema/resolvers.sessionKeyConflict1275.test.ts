/**
 * #1275 (R207, option A): the post-commit `sessionKeyCache.set` in
 * `startAgentSession` cannot throw `Session key conflict`, and these tests pin
 * why. `set` conflicts only when the memory already has a cached entry holding
 * a DIFFERENT key than the one being registered. But the key reaching `set` has
 * just passed `verifyDataKey` against the memory's stored verifier inside the
 * transaction, so it IS the memory's data key; an entry for the same memory can
 * therefore only hold that same key, unless the verifier itself changed while an
 * entry stayed resident. Two places write `keyVerifier`, and neither can do that
 * (see the writer inventory below).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withTestOperationKey } from '../../../test/operationKey.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey, parseDataKey } from '../../../lib/crypto.js';
import { verifyDataKey } from '../../../lib/memoryUnlock.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgId: string;
let agentId: string;
let secretAppId: string;
let plainAppId: string;

const ctx = (appId: string): Context => ({ db, appId, roles: [], organizationId: orgId });
const start = (key: string, externalUserId = 'u1') =>
  withTestOperationKey(key, secretAppId, () =>
    resolvers.Mutation.startAgentSession({}, { agentId, externalUserId }, ctx(secretAppId)));

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  const org = await db.organization.create({ data: { id: generateId(), name: 'org-a', urn: 'org-a' } });
  orgId = org.id;
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: orgId, urn: 'org-a:juno', name: 'juno', type: 'CHATBOT', surfaces: ['api'] },
  });
  agentId = agent.id;
  const mkApp = (urn: string, identifyUserMethod: 'SECRET' | 'USER_ID') => db.app.create({
    data: { id: generateId(), organizationId: orgId, name: urn, urn, createUserPermission: 'IMPLICIT', identifyUserMethod },
  });
  secretAppId = (await mkApp('org-a:secret-app', 'SECRET')).id;
  plainAppId = (await mkApp('org-a:user-id-app', 'USER_ID')).id;
  await db.appAgent.create({ data: { appId: secretAppId, agentId } });
  await db.appAgent.create({ data: { appId: plainAppId, agentId } });
});

describe('startAgentSession post-commit key registration (#1275)', () => {
  it('a key that passes the verifier is the cached key, so the second session shares the entry', async () => {
    const key = generateDataKey().raw.toString('base64');
    const s1 = await start(key);
    const s2 = await start(key);
    const mem = await db.memory.findUniqueOrThrow({ where: { id: s1.memoryId! } });
    const cached = sessionKeyCache.getByMemoryId(s1.memoryId!)!;
    expect(verifyDataKey(mem.keyVerifier!, cached)).toBe(true);
    expect(cached.raw.equals(parseDataKey(key).raw)).toBe(true);
    expect(sessionKeyCache.refCount(s1.memoryId!)).toBe(2);
    expect(s2.memoryId).toBe(s1.memoryId);
  });

  it('a different key meets the verifier BEFORE any row or cache write: no orphan, resident key untouched', async () => {
    const key = generateDataKey().raw.toString('base64');
    const other = generateDataKey().raw.toString('base64');
    const s1 = await start(key);
    const before = await db.session.count({ where: { memoryId: s1.memoryId! } });

    await expect(start(other)).rejects.toMatchObject({ extensions: { code: 'WRONG_KEY' } });

    expect(await db.session.count({ where: { memoryId: s1.memoryId! } })).toBe(before);
    expect(sessionKeyCache.refCount(s1.memoryId!)).toBe(1);
    expect(sessionKeyCache.getByMemoryId(s1.memoryId!)!.raw.equals(parseDataKey(key).raw)).toBe(true);
  });

  it('attribution comes from the committed row (createdBy = app, userId carried), not from the cache', async () => {
    const s = await start(generateDataKey().raw.toString('base64'));
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.createdBy).toBe(secretAppId);
    expect(row.appId).toBe(secretAppId);
    expect(row.endedAt).toBeNull();
  });

  it('the non-encrypted path never calls set: no key is cached', async () => {
    const s = await resolvers.Mutation.startAgentSession({}, { agentId, externalUserId: 'plain' }, ctx(plainAppId));
    expect(s.memoryId).toBeTruthy();
    expect(sessionKeyCache.getByMemoryId(s.memoryId!)).toBeNull();
    expect(sessionKeyCache.refCount(s.memoryId!)).toBe(0);
  });
});

describe('keyVerifier writer inventory (#1275 unreachability premise)', () => {
  // The argument that `set` cannot conflict needs a memory's verifier never to
  // change under a resident cache entry. It holds because every writer installs
  // a verifier only on a memory that is NOT yet encrypted (is_encrypted = false,
  // verifier absent), and a key is cached only for an encrypted memory, so no
  // entry can predate the write. The three writers:
  //   1. SECRET user-memory birth (session.ts): a brand-new memory id.
  //   2. Anonymous-memory promotion (memory.ts linkMemoryToUser, RAW SQL
  //      `key_verifier = ...`): its claim statement requires
  //      `is_encrypted = false AND key_verifier IS NULL`, so it is set-once.
  //   3. Encryption enable (memory.ts encryptMemory, Prisma updateMany on
  //      `isEncrypted: false`).
  // A fourth writer, in either spelling, or a rekey, voids the premise: add it
  // here deliberately and re-argue the conflict. Both the Prisma property and
  // the SQL column are scanned, because a raw-SQL write does not spell the
  // property name (Dorian, LOCAL review of #2397).
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === 'generated' ? [] : sources(p);
      return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
    });
  }
  const readSources = () => sources('src').map((p) => [p, readFileSync(p, 'utf8')] as const);

  it('only birth, promotion and encryption enable assign a verifier (Prisma property or SQL column)', () => {
    const prismaWrite = /\bkeyVerifier\s*:\s*(makeKeyVerifier\(|null\b|parsedKey)/;
    const sqlWrite = /\bkey_verifier\s*=(?!=)/;
    const hits = readSources().flatMap(([p, text]) => text.split('\n')
      .filter((l) => prismaWrite.test(l) || sqlWrite.test(l))
      .map((l) => `${p}: ${l.trim().replace(/\s+/g, ' ')}`));
    expect(hits.sort()).toEqual([
      'src/api/graphql/schema/resolvers.mutation.memory.ts: keyVerifier: makeKeyVerifier(key),',
      'src/api/graphql/schema/resolvers.mutation.memory.ts: key_verifier = ${makeKeyVerifier(key)}, class = \'private\', user_id = ${user.id},',
      'src/api/graphql/schema/resolvers.mutation.session.ts: keyVerifier: parsedKey ? makeKeyVerifier(parsedKey) : null,',
    ]);
  });

  it('the raw-SQL promotion writer is set-once: its claim requires no existing verifier and no encryption', () => {
    const text = readFileSync('src/api/graphql/schema/resolvers.mutation.memory.ts', 'utf8');
    const start = text.indexOf('key_verifier = ${makeKeyVerifier(key)}');
    expect(start).toBeGreaterThan(0);
    const stmt = text.slice(start, text.indexOf('`;', start));
    expect(stmt).toContain('is_encrypted = false AND key_verifier IS NULL');
  });
});
