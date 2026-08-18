/**
 * Chat-loc resolution within the caller's entitled set (#829).
 *
 * The regression this file exists for: `loc` is unique per MEMORY, so an
 * attacker who learns a chat id can create a node at that loc in a memory they
 * can write. Two earlier attempts both failed —
 *
 *   - scoping with the shared read gate broke shared app chats
 *     (`getAccessibleMemoryIds` is NARROWER than the spec-017 chat gate); and
 *   - detecting ambiguity before authorizing turned that plant into a
 *     permanent, attacker-triggered denial of service.
 *
 * So the filter runs FIRST and is the UNION of every chat surface's gate. The
 * planted node fails it and drops out — it can neither be picked nor block the
 * read — while every legitimate entitlement still resolves.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { chatLocFilter, pickChatNode } from './chatLoc.js';
import { TEAM_CHAT_LOC, TEAM_CHAT_MESSAGES_LOC, isTeamChatLoc } from './teamChatLoc.js';

const CHAT_LOC = 'chats:202607281200-deadbeef-shared';

let org: { id: string };
let victim: { id: string };
let attacker: { id: string };
let appMember: { id: string };
let appId: string;
let appMem: { id: string };
let victimMem: { id: string };
let attackerMem: { id: string };
let victimChatId: string;
let plantedId: string;

/** What every call site does: filter to the entitled set, oldest first, pick. */
async function resolve(principal: { userId?: string; roles?: string[] }, loc = CHAT_LOC) {
  const rows = await db.node.findMany({
    where: await chatLocFilter(db, loc, principal),
    select: { id: true, memoryId: true },
    orderBy: { createdAt: 'asc' as const },
    take: 2,
  });
  return pickChatNode(rows, loc);
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'cl-org', urn: `cl-org-${generateId()}` },
  });
  victim = await db.user.create({ data: { githubId: 7001, githubUsername: 'cl-victim', roles: ['READER'] } });
  attacker = await db.user.create({ data: { githubId: 7002, githubUsername: 'cl-attacker', roles: ['READER'] } });
  appMember = await db.user.create({ data: { githubId: 7003, githubUsername: 'cl-appmem', roles: ['READER'] } });

  const made = await createDbAppWithKey(db, 'cl-app', org.id);
  appId = made.app.id;

  // The victim's own chat, in their per-user holding memory.
  victimMem = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `cl-victim-mem-${generateId()}`,
      name: 'victim-mem', class: 'knowledge', createdBy: victim.id,
      userMemoryOfAgentId: null,
    },
  });
  const vChat = await db.node.create({
    data: { id: generateId(), memoryId: victimMem.id, loc: CHAT_LOC, name: 'chat', createdBy: victim.id },
  });
  victimChatId = vChat.id;

  // The attacker plants a node at the SAME loc in a memory they own.
  attackerMem = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `cl-attacker-mem-${generateId()}`,
      name: 'attacker-mem', class: 'knowledge', createdBy: attacker.id,
    },
  });
  const planted = await db.node.create({
    data: { id: generateId(), memoryId: attackerMem.id, loc: CHAT_LOC, name: 'planted', createdBy: attacker.id },
  });
  plantedId = planted.id;

  // A shared app-class chat memory — the case the shared read gate excludes.
  appMem = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `cl-app-mem-${generateId()}`,
      name: 'app-mem', class: 'app', appId, createdBy: victim.id,
    },
  });
  await db.appMember.create({ data: { appId, userId: appMember.id, role: 'member' } });
});

describe('chatLocFilter — the planted-node DoS is closed', () => {
  it("the victim still resolves their own chat, not the attacker's", async () => {
    const node = await resolve({ userId: victim.id, roles: ['READER'] });
    expect(node?.id).toBe(victimChatId);
    expect(node?.memoryId).toBe(victimMem.id);
  });

  it('does NOT throw ambiguous — the plant never enters the candidate set', async () => {
    // This is the exact failure the previous attempt introduced: two rows share
    // the loc, so a pre-authorization uniqueness check threw for the victim.
    await expect(resolve({ userId: victim.id, roles: ['READER'] })).resolves.toBeTruthy();
  });

  it("the attacker cannot reach the victim's chat with the same loc", async () => {
    const node = await resolve({ userId: attacker.id, roles: ['READER'] });
    expect(node?.id).toBe(plantedId); // only their own
    expect(node?.memoryId).toBe(attackerMem.id);
  });

  it('a stranger with no entitlement resolves nothing', async () => {
    const stranger = await db.user.create({ data: { githubId: 7004, githubUsername: 'cl-stranger', roles: ['READER'] } });
    expect(await resolve({ userId: stranger.id, roles: ['READER'] })).toBeNull();
  });

  it('a CO-MEMBER plant cannot break the read either (PR #830 review)', async () => {
    // The entitlement filter alone did not close this: a co-member of one of
    // the caller's Apps can write the loc into a SECOND app-class memory the
    // caller also belongs to, so both rows survive the filter. Erroring on that
    // recreated the DoS; the ordering is what actually settles it.
    const appB = await createDbAppWithKey(db, 'cl-app-b', org.id);
    await db.appMember.create({ data: { appId: appB.app.id, userId: victim.id, role: 'member' } });
    await db.appMember.create({ data: { appId: appB.app.id, userId: attacker.id, role: 'member' } });
    const appBMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `cl-appb-mem-${generateId()}`,
        name: 'appb-mem', class: 'app', appId: appB.app.id, createdBy: attacker.id,
      },
    });
    // Victim's real chat lives in an app memory they belong to…
    const realChat = await db.node.create({
      data: { id: generateId(), memoryId: appMem.id, loc: 'chats:co-member-target', name: 'real', createdBy: victim.id },
    });
    await db.appMember.create({ data: { appId, userId: victim.id, role: 'member' } });
    // …and the co-member plants the same loc in the other app memory.
    await db.node.create({
      data: { id: generateId(), memoryId: appBMem.id, loc: 'chats:co-member-target', name: 'plant', createdBy: attacker.id },
    });

    const node = await resolve({ userId: victim.id, roles: ['READER'] }, 'chats:co-member-target');
    expect(node?.id).toBe(realChat.id);
    expect(node?.memoryId).toBe(appMem.id);
  });

  it('planting MANY nodes cannot crowd the victim out of the capped fetch', async () => {
    // The filter runs in the DB, so `take: 2` sees only entitled rows —
    // an attacker cannot push the victim's own chat past the cap.
    for (let i = 0; i < 25; i++) {
      const m = await db.memory.create({
        data: {
          id: generateId(), organizationId: org.id, urn: `cl-flood-${i}-${generateId()}`,
          name: `flood-${i}`, class: 'knowledge', createdBy: attacker.id,
        },
      });
      await db.node.create({
        data: { id: generateId(), memoryId: m.id, loc: CHAT_LOC, name: 'flood', createdBy: attacker.id },
      });
    }
    const node = await resolve({ userId: victim.id, roles: ['READER'] });
    expect(node?.id).toBe(victimChatId);
  });
});

describe('chatLocFilter — entitlement is the UNION of the chat gates', () => {
  it('an AppMember reaches a shared app-class chat (the case the shared read gate excludes)', async () => {
    // getAccessibleMemoryIds covers class IN (knowledge, group) and reaches
    // app memories elsewhere — filtering with it here would break this.
    await db.node.create({
      data: { id: generateId(), memoryId: appMem.id, loc: 'chats:app-only', name: 'appchat', createdBy: victim.id },
    });
    const rows = await db.node.findMany({
      where: await chatLocFilter(db, 'chats:app-only', { userId: appMember.id, roles: ['READER'] }),
      take: 2,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].memoryId).toBe(appMem.id);
  });

  it('the memory owner reaches a chat they did not author', async () => {
    const other = await db.user.create({ data: { githubId: 7005, githubUsername: 'cl-other', roles: ['READER'] } });
    await db.node.create({
      data: { id: generateId(), memoryId: victimMem.id, loc: 'chats:by-other', name: 'c', createdBy: other.id },
    });
    const rows = await db.node.findMany({
      where: await chatLocFilter(db, 'chats:by-other', { userId: victim.id, roles: ['READER'] }),
      take: 2,
    });
    expect(rows).toHaveLength(1); // victim owns the holding memory
  });

  it('a platform admin sees across tenants but still gets the ORIGINAL, not the plant', async () => {
    // Admins are not entitlement-narrowed, so both rows are candidates. The
    // ordering still decides it, and the plant is newer.
    const node = await resolve({ userId: 'ops', roles: ['ADMIN'] });
    expect(node?.id).toBe(victimChatId);
  });

  it('a principal with no user identity matches nothing', async () => {
    expect(await resolve({ roles: ['READER'] })).toBeNull();
  });
});

describe('chatLocFilter — the team chat is not addressable as an agent chat (#1030)', () => {
  /**
   * Every agent-chat surface that names a chat by loc resolves it through this
   * filter — sendChatMessage, processChatResponse, saveChatSummary,
   * updateChatTitle, deleteChat, chatHistory, and their MCP twins. So refusing
   * `chats:team` here is what stops an LLM turn being appended to a team's
   * attribution record, and a `deleteChat` soft-deleting the root and every
   * message on it.
   */
  beforeEach(async () => {
    // The team chat as `createTeamChatMessage` bootstraps it: root + message
    // container in the App's app-class memory. `createdBy` is the human who
    // posted first (#914) — which is exactly what makes deleteChat's
    // author-only gate admit them today.
    await db.node.create({
      data: {
        id: generateId(), memoryId: appMem.id, loc: TEAM_CHAT_LOC,
        name: 'team', nodeType: 'chat', createdBy: appMember.id,
        data: { scope: 'shared', messageCount: 1 },
      },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: appMem.id, loc: TEAM_CHAT_MESSAGES_LOC,
        name: 'messages', nodeType: 'record', createdBy: appMember.id,
      },
    });
  });

  it('refuses the AppMember who bootstrapped it — the principal deleteChat would otherwise admit', async () => {
    expect(await resolve({ userId: appMember.id, roles: ['READER'] }, TEAM_CHAT_LOC)).toBeNull();
  });

  it('refuses the owner of the holding memory', async () => {
    expect(await resolve({ userId: victim.id, roles: ['READER'] }, TEAM_CHAT_LOC)).toBeNull();
  });

  it('refuses a PLATFORM ADMIN — the branch that skips entitlement narrowing', async () => {
    // The refusal sits above the admin early-return on purpose. An admin is
    // the one principal who reaches every tenant's chat root by loc alone, so
    // leaving them on the old path would leave the destructive route open to
    // exactly the account that can use it against any team.
    expect(await resolve({ userId: 'ops', roles: ['ADMIN'] }, TEAM_CHAT_LOC)).toBeNull();
  });

  it('refuses nodes BENEATH the team chat, not just the root', async () => {
    // chatLocFilter takes a chat-root loc, but nothing stops a caller passing
    // the message container: appending a turn under it corrupts the same
    // record by a longer route.
    expect(await resolve({ userId: appMember.id, roles: ['READER'] }, TEAM_CHAT_MESSAGES_LOC)).toBeNull();
  });

  it("does NOT refuse a user's own chat whose name merely starts with 'team'", async () => {
    // The trap this exclusion is written to avoid: a bare
    // startsWith('chats:team') swallows chats:team-retro, which is an ordinary
    // agent chat and none of the platform's business.
    const retro = await db.node.create({
      data: {
        id: generateId(), memoryId: victimMem.id, loc: 'chats:team-retro',
        name: 'team-retro', createdBy: victim.id,
      },
    });
    const node = await resolve({ userId: victim.id, roles: ['READER'] }, 'chats:team-retro');
    expect(node?.id).toBe(retro.id);
  });

  it('a node whose PK IS the old sentinel value does not slip through the refusal', async () => {
    // Codex P2 on PR #1042. The refusal used to be expressed as
    // `id: '__no_principal__'`, which reads unsatisfiable and is not:
    // `Node.id` is a forced primary key a caller supplies verbatim through
    // `CreateNodeInput.id`, so a row can simply BE that value. Planting one at
    // `chats:team` in a team memory you can write, then letting the first real
    // post adopt it as the root, put the agent-chat operations back on the
    // team's own record.
    const mem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `cl-sentinel-${generateId()}`,
        name: 'sentinel-mem', class: 'knowledge', createdBy: attacker.id,
      },
    });
    await db.node.create({
      data: {
        id: '__no_principal__', memoryId: mem.id, loc: TEAM_CHAT_LOC,
        name: 'planted', createdBy: attacker.id,
      },
    });
    // Its own author is the strongest case: every per-site gate downstream
    // (deleteChat and updateChatTitle are author-only) would admit them.
    expect(await resolve({ userId: attacker.id, roles: ['READER'] }, TEAM_CHAT_LOC)).toBeNull();
    expect(await resolve({ userId: 'ops', roles: ['ADMIN'] }, TEAM_CHAT_LOC)).toBeNull();
    // The no-identity branch shares the predicate, so it regained the same
    // property — assert it here rather than trusting that it did.
    expect(await resolve({ roles: ['READER'] }, TEAM_CHAT_LOC)).toBeNull();
  });

  it('isTeamChatLoc matches the root and its subtree, and nothing adjacent', () => {
    expect(isTeamChatLoc(TEAM_CHAT_LOC)).toBe(true);
    expect(isTeamChatLoc(TEAM_CHAT_MESSAGES_LOC)).toBe(true);
    expect(isTeamChatLoc(`${TEAM_CHAT_MESSAGES_LOC}:001-hello`)).toBe(true);
    expect(isTeamChatLoc('chats:team-retro')).toBe(false);
    expect(isTeamChatLoc('chats:teamwork')).toBe(false);
    expect(isTeamChatLoc('chats:202607281200-deadbeef-team')).toBe(false);
  });
});

describe('pickChatNode', () => {
  it('returns the first (oldest) row, or null for none', () => {
    expect(pickChatNode([{ id: 'a' }, { id: 'b' }], 'c')).toEqual({ id: 'a' });
    expect(pickChatNode([], 'c')).toBeNull();
  });

  it('NEVER throws on a collision — an error would hand the attacker the DoS', () => {
    // This is the #828/#830 lesson in one assertion: no rule may let someone
    // else's row decide whether your read succeeds.
    expect(() => pickChatNode([{ id: 'a' }, { id: 'b' }], 'chats:dup')).not.toThrow();
  });
});
