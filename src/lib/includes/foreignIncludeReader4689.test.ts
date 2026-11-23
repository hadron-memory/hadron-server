/**
 * #4689 (cor:dmo:150:04, :05; cor:api:060:05; Holger's ruling A): a run render follows a foreign full-URN include
 * under the reader's own read access, and an EXECUTED run reads as its run principal, judged as adoption judges a
 * partial (readable by the principal, plaintext, same organization). Anything else is the one notice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { runAuthContext } from '../auth/runPrincipal.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { generateDataKey } from '../crypto.js';
import { encryptNodeFields } from '../nodeCrypto.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const READABLE = 'READABLE-FOREIGN-TEXT';
const OTHER_ORG = 'OTHER-ORG-TEXT';
const PRIVATE = 'PRIVATE-OF-ANOTHER-USER';
const NOTICE = '[Include unavailable]';

let orgId: string;
let appId: string;
let ownerId: string;
let home: { id: string; urn: string };
const memory = async (name: string, data: Record<string, unknown>) => {
  const m = await db.memory.create({ data: { id: generateId(), name, urn: `${name}-${generateId().slice(-6)}`, ...data } as never });
  if (data.class === 'group') await db.memoryMember.create({ data: { memoryId: m.id, userId: ownerId, role: 'writer' } });
  return m;
};
const node = (memoryId: string, loc: string, content: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, nodeType: 'info', content, tags: [], ...extra } as never });

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'fi-org', urn: 'fi-org' } })).id;
  ownerId = (await db.user.create({ data: { githubId: 468901, githubUsername: `fi-${generateId()}`, roles: [] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: ownerId, role: 'ADMIN' } });
  appId = (await createDbAppWithKey(db, 'fi-app', orgId)).app.id;
  home = await memory('fi-org:home', { class: 'group', visibility: 'GROUP', organizationId: orgId });
});

const runCtx = (userId: string | null = ownerId) =>
  ({ db, ...runAuthContext({ id: generateId(), appId, userId, organizationId: orgId }) }) as unknown as Context;
const userCtx = () => ({ db, userId: ownerId, roles: [], clientId: `user:${ownerId}` }) as unknown as Context;
const render = (ctx: Context, loc: string) =>
  resolvers.Mutation.runTask({}, { nodeRef: `hrn:node:${home.urn}:${loc}` }, ctx) as Promise<string>;
const preview = (ctx: Context, loc: string) =>
  (resolvers.Query as any).renderRunNode({}, { nodeRef: `hrn:node:${home.urn}:${loc}` }, ctx) as Promise<string>;
const task = (urn: string, loc: string) =>
  node(home.id, 'tasks:t', `A [{{> hrn:node:${urn}:${loc}}}] B`, { isRunnable: true });

describe('#4689: the reader of a foreign URN include', () => {
  it('an encrypted memory is never followed by a run, even with its session key cached (adoption refuses it as a partial)', async () => {
    const m = await memory('fi-org:enc', { class: 'group', visibility: 'GROUP', organizationId: orgId, isEncrypted: true });
    const key = generateDataKey();
    sessionKeyCache.set(generateId(), m.id, key);
    try {
      const info = { id: m.id, isEncrypted: true };
      await node(m.id, 'snip', encryptNodeFields({ content: 'ENCRYPTED-TEXT' }, info).content as string);
      await task(m.urn, 'snip');
      const text = await render(runCtx(), 'tasks:t');
      expect(text).not.toContain('ENCRYPTED-TEXT');
      expect(text).toContain(`A [${NOTICE}] B`);
      // The same target, read by a caller who holds the key, resolves: the run's refusal is the adoption rule, not a read fault.
      expect(await render(userCtx(), 'tasks:t')).toContain('A [ENCRYPTED-TEXT] B');
    } finally { sessionKeyCache.clear(); }
  });

  it('a readable memory of the same organization is spliced in, for a caller and for the run principal', async () => {
    const m = await memory('fi-org:shared', { class: 'group', visibility: 'GROUP', organizationId: orgId });
    await node(m.id, 'snip', READABLE);
    await task(m.urn, 'snip');
    for (const ctx of [userCtx(), runCtx()]) expect(await render(ctx, 'tasks:t')).toContain(`A [${READABLE}] B`);
  });

  it('an encrypted foreign memory whose key is not cached is the notice, for a caller and for the run principal (F2)', async () => {
    const m = await memory('fi-org:encnk', { class: 'group', visibility: 'GROUP', organizationId: orgId, isEncrypted: true });
    await node(m.id, 'snip', 'KEYLESS-ENCRYPTED-TEXT');
    await task(m.urn, 'snip');
    for (const ctx of [userCtx(), runCtx()]) {
      const text = await render(ctx, 'tasks:t');
      expect(text).not.toContain('KEYLESS-ENCRYPTED-TEXT');
      expect(text).toContain(`A [${NOTICE}] B`);
    }
  });

  it('a soft-deleted foreign memory is the same notice as a missing one, for a caller and for the run principal (F7)', async () => {
    const m = await memory('fi-org:deleted', { class: 'group', visibility: 'GROUP', organizationId: orgId });
    await node(m.id, 'snip', 'DELETED-MEMORY-TEXT');
    await db.memory.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
    await task(m.urn, 'snip');
    for (const ctx of [userCtx(), runCtx()]) {
      const text = await render(ctx, 'tasks:t');
      expect(text).not.toContain('DELETED-MEMORY-TEXT');
      expect(text).toContain(`A [${NOTICE}] B`);
    }
  });

  it('the run principal never reads wider than itself: another organization, an encrypted memory and a stranger\'s private memory are the notice', async () => {
    const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'fi-other', urn: 'fi-other' } });
    await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: ownerId, role: 'ADMIN' } });
    const foreign = await memory('fi-other:m', { class: 'group', visibility: 'GROUP', organizationId: otherOrg.id });
    await node(foreign.id, 'snip', OTHER_ORG);
    const stranger = await db.user.create({ data: { githubId: 468902, githubUsername: `fi-s-${generateId()}`, roles: [] } });
    const priv = await memory('fi-org:priv', { class: 'private', userId: stranger.id, ownerUserId: stranger.id });
    await node(priv.id, 'snip', PRIVATE);
    for (const [urn, secret] of [[foreign.urn, OTHER_ORG], [priv.urn, PRIVATE]] as const) {
      await db.node.deleteMany({ where: { memoryId: home.id } });
      await task(urn, 'snip');
      const text = await render(runCtx(), 'tasks:t');
      expect(text).not.toContain(secret);
      expect(text).toContain(`A [${NOTICE}] B`);
    }
  });

  it('an unreadable, a missing and an out-of-reach target answer byte-identically (no existence oracle)', async () => {
    const stranger = await db.user.create({ data: { githubId: 468903, githubUsername: `fi-s-${generateId()}`, roles: [] } });
    const priv = await memory('fi-org:priv2', { class: 'private', userId: stranger.id, ownerUserId: stranger.id });
    await node(priv.id, 'snip', PRIVATE);
    const shared = await memory('fi-org:shared2', { class: 'group', visibility: 'GROUP', organizationId: orgId });
    const out: string[] = [];
    for (const [urn, loc] of [[priv.urn, 'snip'], [priv.urn, 'nope'], [shared.urn, 'nope']] as const) {
      await db.node.deleteMany({ where: { memoryId: home.id } });
      await task(urn, loc);
      out.push(await render(runCtx(), 'tasks:t'), await render(userCtx(), 'tasks:t'));
    }
    expect(new Set(out).size).toBe(1);
    expect(out[0]).toContain(`A [${NOTICE}] B`);
  });

  it('a readable include that itself names an unreadable third memory is the notice at that level only', async () => {
    const stranger = await db.user.create({ data: { githubId: 468904, githubUsername: `fi-s-${generateId()}`, roles: [] } });
    const priv = await memory('fi-org:priv3', { class: 'private', userId: stranger.id, ownerUserId: stranger.id });
    await node(priv.id, 'snip', PRIVATE);
    const m = await memory('fi-org:shared3', { class: 'group', visibility: 'GROUP', organizationId: orgId });
    await node(m.id, 'outer', `before {{> hrn:node:${priv.urn}:snip}} after`);
    await task(m.urn, 'outer');
    const text = await render(runCtx(), 'tasks:t');
    expect(text).toContain(`A [before ${NOTICE} after] B`);
    expect(text).not.toContain(PRIVATE);
  });

  it('the GraphQL renderRunNode preview equals the executed render', async () => {
    const m = await memory('fi-org:shared4', { class: 'group', visibility: 'GROUP', organizationId: orgId });
    await node(m.id, 'snip', READABLE);
    await task(m.urn, 'snip');
    expect(await preview(userCtx(), 'tasks:t')).toBe(await render(userCtx(), 'tasks:t'));
    expect(await preview(userCtx(), 'tasks:t')).toContain(READABLE);
  });
});
