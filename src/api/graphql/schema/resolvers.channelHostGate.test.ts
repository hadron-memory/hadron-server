import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #1196 — chat participation is DERIVED from the host memory, for read AND for
 * write, on a Channel hosted in a memory of any class.
 *
 * Holger's #1193 ruling opened Channel hosting to every class. That ruling is
 * only safe because of what is pinned here: before this change the chat
 * surfaces decided on APP membership, and `hostMemoryReadable` short-circuited
 * `true` for anything carrying a `userId` — so a Channel in someone's
 * `personal` memory was readable AND postable by every AppMember of whichever
 * App happened to be in context. That is the first row of #1196's table, and
 * these tests fail loudly against the pre-#1196 gates.
 *
 * `cor:acl:030:01`: *"A chat has no access layer of its own — for reading or for
 * writing. Both are decided entirely by the memory that hosts it."*
 *
 * The write side is deliberately NOT one rule, because `cor:acl:010:01` is not:
 * an app-class host writes through the surface's own participation gate
 * (*"membership confers READ, not write … the team space receives writes
 * through surfaces that run their own participant gates"*), everything else
 * through that memory's per-class write rules. Both arms are exercised.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
/** The memory's owner. */
let owner: { id: string };
/** An AppMember + org CONTRIBUTOR who has no business in the owner's memory. */
let colleague: { id: string };
let app: { id: string };
let personal: { id: string; urn: string };
let personalChannel: { id: string };

const ctx = (userId?: string, extra: Partial<Context> = {}): Context =>
  ({ db, userId, roles: ['READER'], ...extra }) as Context;
/** A platform operator — the principal `chatHistory`'s old gate never refused. */
const adminCtx = (userId: string): Context =>
  ({ db, userId, roles: ['ADMIN'] }) as Context;

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ extensions: { code } });
}

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'hg', urn: `hg-${t}` } });
  const mk = (n: number, tag: string) =>
    db.user.create({
      data: { id: generateId(), githubId: 71200 + n, githubUsername: `hg-${tag}-${t}`, handle: `hg-${tag}-${t}` },
    });
  owner = await mk(1, 'owner');
  colleague = await mk(2, 'colleague');

  // The colleague is as privileged as anyone can be WITHOUT being the owner:
  // org CONTRIBUTOR and an AppMember. Under the pre-#1196 gates that was enough
  // to read and post into the owner's personal chat.
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: colleague.id, role: 'CONTRIBUTOR' } });

  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, name: 'agent', urn: `${org.urn}:agent`, visibility: 'ORGANIZATION' },
  });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'admin' } });
  await db.appMember.create({ data: { appId: app.id, userId: colleague.id, role: 'admin' } });

  // A free-standing PERSONAL memory (spec 034): owner-only, `app_id` and agent
  // both NULL. `organizationId` is set to satisfy `chk_memory_owner_xor` —
  // ownership for this class rides `Memory.userId`, not the org column.
  personal = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${org.urn}:owner-notes`,
      name: 'owner-notes',
      class: 'personal',
      userId: owner.id,
      visibility: null,
    },
  });
  personalChannel = (
    await ensureChannelWithRoot(db, { memoryId: personal.id, loc: 'chats:journal', name: 'journal', createdBy: owner.id })
  ).channel;
});

describe('a Channel in a personal memory is the OWNER\'s', () => {
  it('the owner reads and posts', async () => {
    const msg = await M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'mine' }, ctx(owner.id));
    expect(msg).toMatchObject({ seq: 1, authorUserId: owner.id });
    const page = await Q.channelMessages({}, { channelRef: personalChannel.id }, ctx(owner.id));
    expect(page.total).toBe(1);
  });

  it('an AppMember + org CONTRIBUTOR can neither read nor post — the leak the class gate was hiding', async () => {
    await M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'mine' }, ctx(owner.id));

    // Read is "no match", not FORBIDDEN: a Channel you may not read must be
    // indistinguishable from one that does not exist (§8.6).
    await expectCode(Q.channelMessages({}, { channelRef: personalChannel.id }, ctx(colleague.id)), 'CHANNEL_NOT_FOUND');
    await expectCode(
      M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'intruding' }, ctx(colleague.id)),
      'CHANNEL_NOT_FOUND',
    );
  });

  it('a platform ADMIN can neither read nor post — strict ownership has no bypass', async () => {
    // cor:acl:010:02: the ADMIN/OWNER bypass does not reach personal/private.
    // The pre-#1196 `hostMemoryReadable` returned true for ANY userId, so this
    // was open to every principal, operator or not.
    await M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'mine' }, ctx(owner.id));
    await expectCode(Q.channelMessages({}, { channelRef: personalChannel.id }, adminCtx(colleague.id)), 'CHANNEL_NOT_FOUND');
  });

  it('an impersonated support session cannot reach it', async () => {
    // An App-hosted Channel has `requireTeamChatAccess`'s bounded impersonation
    // read; a host with NO App has no such gate, so the memory gate decides —
    // and denies. `ctx.userId` is the TARGET here, which is exactly the #876
    // shape that fails open if the gate is left to compare it to `memory.userId`.
    await M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'mine' }, ctx(owner.id));
    const imp = ctx(owner.id, { impersonation: { orgId: org.id } } as Partial<Context>);
    await expectCode(Q.channelMessages({}, { channelRef: personalChannel.id }, imp), 'CHANNEL_NOT_FOUND');
  });
});

describe('MemoryShare splits read from write — the escalation #1196 names', () => {
  it('a READER grantee reads but may NOT post', async () => {
    // Posting was gated on a READ check, and MemoryShare has a `reader` role,
    // so before this change a reader-grantee could append. Splitting the gates
    // is what fixes it: read passes, post is FORBIDDEN — and FORBIDDEN rather
    // than "no match", because the Channel is known to them.
    await db.memoryShare.create({
      data: { memoryId: personal.id, granteeId: colleague.id, grantorId: owner.id, role: 'reader', createdBy: owner.id },
    });
    await M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'mine' }, ctx(owner.id));

    const page = await Q.channelMessages({}, { channelRef: personalChannel.id }, ctx(colleague.id));
    expect(page.total).toBe(1);
    await expect(
      M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'appending' }, ctx(colleague.id)),
    ).rejects.toThrow(/Forbidden/);
  });

  it('a WRITER grantee reads and posts', async () => {
    await db.memoryShare.create({
      data: { memoryId: personal.id, granteeId: colleague.id, grantorId: owner.id, role: 'writer', createdBy: owner.id },
    });
    const msg = await M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'joint' }, ctx(colleague.id));
    expect(msg).toMatchObject({ seq: 1, authorUserId: colleague.id });
  });
});

describe('a host with no App is no longer refused', () => {
  it('CHANNEL_HOST_NOT_APP is retired — the owner simply reads and posts', async () => {
    // The refusal was thrown BEFORE the read gate, so a Channel id distinguished
    // "inaccessible" from "missing" (the existence oracle, #1196 item 4). It is
    // removed rather than reordered: no refusal, no oracle.
    const knowledge = await db.memory.create({
      data: {
        id: generateId(),
        urn: `${org.urn}:free`,
        name: 'free',
        class: 'knowledge',
        organizationId: org.id,
        visibility: 'ORGANIZATION',
      },
    });
    const ch = (
      await ensureChannelWithRoot(db, { memoryId: knowledge.id, loc: 'chats:open', name: 'open', createdBy: owner.id })
    ).channel;

    const msg = await M.createChannelMessage({}, { channelRef: ch.id, body: 'hello' }, ctx(owner.id));
    expect(msg).toMatchObject({ seq: 1 });
    // An org member reads it — the memory's own ORGANIZATION visibility, which
    // is the entire gate now.
    expect((await Q.channelMessages({}, { channelRef: ch.id }, ctx(colleague.id))).total).toBe(1);
  });

  it('a non-reader gets the same CHANNEL_NOT_FOUND as for a nonexistent id', async () => {
    const outsiderOrg = await db.organization.create({
      data: { id: generateId(), name: 'out', urn: `out-${Date.now()}` },
    });
    const outsider = await db.user.create({ data: { id: generateId(), githubId: 71299, githubUsername: `out-${Date.now()}` } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: outsiderOrg.id, userId: outsider.id, role: 'ADMIN' } });

    const real = await Q.channelMessages({}, { channelRef: personalChannel.id }, ctx(outsider.id)).catch((e: any) => e);
    const fake = await Q.channelMessages({}, { channelRef: generateId() }, ctx(outsider.id)).catch((e: any) => e);
    expect(real.extensions.code).toBe('CHANNEL_NOT_FOUND');
    expect(fake.extensions.code).toBe(real.extensions.code);
    expect(fake.message.replace(/"[^"]*"/, '"X"')).toBe(real.message.replace(/"[^"]*"/, '"X"'));
  });
});

describe('the App-hosted arm keeps the participation write audience', () => {
  it('an EXTERNAL AppMember with no org role still posts', async () => {
    // The arm #1196's "write => requireMemoryWriteAccess" shorthand would have
    // broken: that gate's user path grants an app-class write to an org
    // CONTRIBUTOR+ and nobody else, so the supported B2C shape — an AppMember
    // who is not in the org at all — would have been refused. cor:acl:010:01
    // routes app-class chat writes through the surface's participation gate on
    // purpose, and this pins that they still do.
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const appMem = await db.memory.create({
      data: {
        id: generateId(),
        urn: `${org.urn}:a-shared`,
        name: 'a-shared',
        class: 'app',
        organizationId: org.id,
        appId: app.id,
        sharedMemoryOfAgentId: agent.id,
      },
    });
    const ch = (
      await ensureChannelWithRoot(db, { memoryId: appMem.id, loc: 'chats:team', name: 'team', createdBy: owner.id, asDefaultOfAppId: app.id })
    ).channel;

    const external = await db.user.create({
      data: { id: generateId(), githubId: 71298, githubUsername: `ext-${Date.now()}`, handle: `ext-${Date.now()}` },
    });
    await db.appMember.create({ data: { appId: app.id, userId: external.id, role: 'member' } });

    const msg = await M.createChannelMessage({}, { channelRef: ch.id, body: 'from outside the org' }, ctx(external.id));
    expect(msg).toMatchObject({ seq: 1, authorUserId: external.id });
  });
});

describe('a Channel is not a cor:cht conversation — the chatbot surfaces cannot reach one', () => {
  /**
   * `chatLocFilter` and `myChats` both excluded the team chat by LOC
   * (`isTeamChatLoc` / `excludeTeamChat`). That was sufficient only while a
   * Channel WAS `chats:team`; a Channel at any other address passed both.
   * #1196 keys the rule on the Channel ROW instead — and keeps the loc rule,
   * which additionally covers a root whose row has not been created yet.
   */
  it('chatHistory refuses a Channel root at a non-team address', async () => {
    await M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'mine' }, ctx(owner.id));
    // `chats:journal` — a perfectly ordinary-looking agent-chat loc. Even the
    // OWNER, who may read the memory, gets "not found": the refusal is about
    // what the node is, not about who is asking.
    await expect(Q.chatHistory({}, { chatId: 'chats:journal' }, ctx(owner.id))).rejects.toThrow(/not found/i);
  });

  it('myChats does not list a Channel root', async () => {
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    // A per-user agent holding memory, so myChats has something to scan, plus
    // an ordinary agent chat in it that MUST still list.
    const holding = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:holding`,
        name: 'holding',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
        userMemoryOfAgentId: agent.id,
        createdBy: owner.id,
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: holding.id, loc: 'chats:abc', name: 'a chat', nodeType: 'record', data: { scope: 'private' } },
    });
    await ensureChannelWithRoot(db, { memoryId: holding.id, loc: 'chats:standup', name: 'standup', createdBy: owner.id });

    const listed = await Q.myChats({}, { agentRef: agent.id }, ctx(owner.id));
    expect(listed.map((c: { loc: string }) => c.loc)).toEqual(['chats:abc']);
  });
});

describe('app_id is not app-CLASS — the four row shapes (@codex P1 on PR #1207)', () => {
  /**
   * `cor:acl:010:01`: "`app` is a tenancy bucket, not an audience." The first
   * draft of `resolveChannelTarget` keyed the App branch on `appId != null`,
   * but `chk_memory_class_app_id` makes `app_id` REQUIRED for `class='app'` and
   * merely OPTIONAL for knowledge/group/personal/private (034, #653) — verified
   * against the live constraint. So an APP-SCOPED personal memory, the ordinary
   * `(app_id, user_id)` pivot, was being treated as a team space: it got the
   * participation WRITE gate and the impersonation READ shortcut.
   *
   * The whole first round of these tests missed it because every fixture used a
   * FREE-STANDING personal memory (`app_id` NULL) — the shape where the two
   * predicates agree.
   */
  async function appScoped(cls: 'personal' | 'knowledge') {
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:scoped-${cls}`,
        name: `scoped-${cls}`,
        class: cls,
        appId: app.id, // ← app-SCOPED, not app-CLASS
        createdBy: owner.id,
        // `chk_memory_personal_agent_id`: personal/private carrying an app_id
        // MUST name the agent. This is the ordinary (app_id, user_id) pivot —
        // the shape the first round of these tests never built, which is
        // exactly why the appId-vs-class bug survived them.
        ...(cls === 'personal'
          ? { userId: owner.id, userMemoryOfAgentId: agent.id, visibility: null }
          : { visibility: 'ORGANIZATION' as never }),
      },
    });
    const ch = (
      await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:scoped', name: 'scoped', createdBy: owner.id })
    ).channel;
    return { mem, ch };
  }

  it('an app-scoped PERSONAL host stays owner-only — an AppMember cannot read or post', async () => {
    const { ch } = await appScoped('personal');
    await M.createChannelMessage({}, { channelRef: ch.id, body: 'mine' }, ctx(owner.id));

    // The colleague is an AppMember of this very App. Keyed on appId, they were
    // a "participant" of a memory that is strictly the owner's.
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, ctx(colleague.id)), 'CHANNEL_NOT_FOUND');
    await expectCode(
      M.createChannelMessage({}, { channelRef: ch.id, body: 'intruding' }, ctx(colleague.id)),
      'CHANNEL_NOT_FOUND',
    );
  });

  it('an app-scoped PERSONAL host is not reachable by an impersonated session', async () => {
    // The impersonation shortcut in `hostMemoryReadable` is conditioned on
    // `app`, so misclassifying the host handed a support session someone's
    // private chat.
    const { ch } = await appScoped('personal');
    await M.createChannelMessage({}, { channelRef: ch.id, body: 'mine' }, ctx(owner.id));
    const imp = ctx(owner.id, { impersonation: { orgId: org.id } } as Partial<Context>);
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, imp), 'CHANNEL_NOT_FOUND');
  });

  it('an app-scoped KNOWLEDGE host is App-INTERNAL, not a team space', async () => {
    // Measured, and it corrected my first draft of this test: I expected the
    // colleague to READ it (ORGANIZATION visibility) and be refused the write.
    // They cannot read it either — #653 makes an app-scoped knowledge memory
    // App-internal, so `getOrgReadableMemoryIds` excludes it (`appId: null`)
    // and only the agent-attach path reaches it. Being an AppMember buys
    // nothing here.
    //
    // Which is the sharper version of the P1: keyed on `appId`, this host would
    // have taken the participation branch and admitted every AppMember to both
    // reading and posting. It takes the memory's own gates instead, and they
    // say no.
    const { ch } = await appScoped('knowledge');
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, ctx(colleague.id)), 'CHANNEL_NOT_FOUND');
    await expectCode(
      M.createChannelMessage({}, { channelRef: ch.id, body: 'appending' }, ctx(colleague.id)),
      'CHANNEL_NOT_FOUND',
    );
  });
});

describe('class=app is STILL four row shapes (@copilot round 2 on PR #1207)', () => {
  /**
   * `cor:acl:010:01`: "`appId + class='app'` selects all four roles and must be
   * narrowed." Round 1 narrowed `appId` → `class === 'app'` and stopped one
   * step short: a Worker's casting memory and a per-user/session memory are
   * both `class='app'` and both answer to a narrower audience than
   * participation. `getAppTeamSpaceAccess` excludes them, so the memory gate
   * already refused an ordinary caller — but `hostMemoryReadable`'s
   * impersonation shortcut keys on `app` alone, so a support session could read
   * a Channel in an end-user's session memory.
   */
  async function appClassRow(kind: 'worker' | 'session') {
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:appclass-${kind}`,
        name: `appclass-${kind}`,
        class: 'app',
        appId: app.id,
        createdBy: owner.id,
        ...(kind === 'session' ? { userMemoryOfAgentId: agent.id } : {}),
      },
    });
    if (kind === 'worker') {
      await db.worker.create({
        data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', memoryId: mem.id },
      });
    }
    const ch = (
      await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:scoped', name: 'scoped', createdBy: owner.id })
    ).channel;
    return { mem, ch };
  }

  it('a Channel in a SESSION memory is not reachable by an impersonated support session', async () => {
    const { ch } = await appClassRow('session');
    const imp = ctx(owner.id, { impersonation: { orgId: org.id } } as Partial<Context>);
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, imp), 'CHANNEL_NOT_FOUND');
  });

  it('a Channel in a WORKER casting memory is not reachable by an impersonated support session', async () => {
    const { ch } = await appClassRow('worker');
    const imp = ctx(owner.id, { impersonation: { orgId: org.id } } as Partial<Context>);
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, imp), 'CHANNEL_NOT_FOUND');
  });

  it('an ordinary AppMember is refused both too — the memory gate, unchanged', async () => {
    const { ch } = await appClassRow('session');
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, ctx(colleague.id)), 'CHANNEL_NOT_FOUND');
  });
});

describe('the Channel is its SUBTREE, and the admin branch is not a bypass (@copilot round 3)', () => {
  it('a Channel\'s :messages container is not reachable as an agent chat', async () => {
    // `channel: null` uses the `ChannelRoot` back-relation, so it excludes the
    // ROOT only. The `:messages` container has no such relation, and this
    // filter matches an exact caller-supplied loc — so a Channel at
    // `chats:journal` was still reachable as `chats:journal:messages`, where
    // `deleteChat` would soft-delete the transcript container of a chat the
    // chatbot surfaces cannot otherwise see.
    await M.createChannelMessage({}, { channelRef: personalChannel.id, body: 'mine' }, ctx(owner.id));
    const container = await db.node.findFirstOrThrow({
      where: { memoryId: personal.id, loc: 'chats:journal:messages' },
    });

    await expect(
      M.deleteChat({}, { chatId: 'chats:journal:messages' }, ctx(owner.id)),
    ).rejects.toThrow(/not found/i);
    // Still live — the refusal is real, not a message about a row that went
    // anyway.
    expect((await db.node.findUniqueOrThrow({ where: { id: container.id } })).deletedAt).toBeNull();
  });

  it('a platform ADMIN gets "not found", not "Forbidden", for a chat in another user\'s personal memory', async () => {
    // The existence oracle: `chatLocFilter`'s admin branch skipped entitlement
    // narrowing, the site gate then refused (cor:acl:010:02 gives no bypass
    // into personal/private), and the difference between "Forbidden" and "not
    // found" told the admin the chat exists. Both answers must be identical.
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const holding = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:owner-private`,
        name: 'owner-private',
        class: 'private',
        userId: owner.id,
        createdBy: owner.id,
        userMemoryOfAgentId: agent.id,
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: holding.id, loc: 'chats:secret', name: 'secret', nodeType: 'record', data: { scope: 'private' } },
    });

    const real = await Q.chatHistory({}, { chatId: 'chats:secret' }, adminCtx(colleague.id)).catch((e: Error) => e);
    const fake = await Q.chatHistory({}, { chatId: 'chats:nothing-here' }, adminCtx(colleague.id)).catch((e: Error) => e);
    expect(real.message.replace(/"[^"]*"/, '"X"')).toBe(fake.message.replace(/"[^"]*"/, '"X"'));
    expect(real.message).toMatch(/not found/i);
  });

  it('...and for a USER-OWNED memory of an ordinary class — the second strict axis', async () => {
    // Strict ownership has TWO orthogonal axes (@copilot round 4). The 034 one
    // is `class IN (personal, private)` keyed on `Memory.userId`; spec 047
    // added `ownerUserId`, under which a user-owned memory of ANY class is
    // owner-only with no platform bypass. Covering only the first left the
    // oracle alive here — a `knowledge` memory owned by a user.
    const other = await db.user.create({
      data: { id: generateId(), githubId: 71297, githubUsername: `owned-${Date.now()}` },
    });
    const userOwned = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: other.id,
        urn: `u-${other.id}:notes`,
        name: 'notes',
        class: 'knowledge',
        visibility: 'ORGANIZATION' as never,
        createdBy: other.id,
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: userOwned.id, loc: 'chats:owned', name: 'owned', nodeType: 'record', data: { scope: 'private' } },
    });

    const real = await Q.chatHistory({}, { chatId: 'chats:owned' }, adminCtx(colleague.id)).catch((e: Error) => e);
    const fake = await Q.chatHistory({}, { chatId: 'chats:nothing-here' }, adminCtx(colleague.id)).catch((e: Error) => e);
    expect(real.message.replace(/"[^"]*"/, '"X"')).toBe(fake.message.replace(/"[^"]*"/, '"X"'));
  });
});

describe('the team-space narrowing applies to EVERY site that classifies one (@copilot round 5)', () => {
  /**
   * Round 2 narrowed `resolveChannelTarget` and stopped. Three siblings kept
   * classifying a team space as `class='app' + appId` — the trap
   * `cor:acl:010:01` names — so the same misclassification stayed reachable by
   * a different route each time. All four now share ONE predicate
   * (`src/lib/auth/teamSpace.ts`); these pin the routes.
   */
  /**
   * The reachable shape, and the first draft of these tests got it wrong: a
   * USER-OWNED APP is blocked by `isAppParticipant` for an unrelated reason
   * (spec 047 admits only its owner), so a fixture built on one proves nothing
   * about `isTeamSpaceRow`. What IS reachable is an ORG-owned App holding a
   * USER-OWNED app-class memory — `chk_memory_owner_xor` permits it, the App
   * gate passes for any org participant, and `hostMemoryReadable`'s
   * impersonation shortcut then keys on `app` alone.
   */
  async function orgAppUserOwnedSpace() {
    const other = await db.user.create({
      data: { id: generateId(), githubId: 71296, githubUsername: `uo-${Date.now()}` },
    });
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: other.id,
        urn: `u-${other.id}:uo-shared`,
        name: 'uo-shared',
        class: 'app',
        appId: app.id, // org-owned App
        createdBy: other.id,
      },
    });
    const ch = (
      await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:owned', name: 'owned', createdBy: other.id })
    ).channel;
    return { other, mem, ch };
  }

  it('a USER-OWNED app-class row is not a team space — even for an impersonated participant', async () => {
    // The fourth discriminator (spec 047), missed in round 2.
    // `getAppTeamSpaceAccess` excludes a user-owned row from anyone but its
    // owner; `isTeamSpaceRow` did not, so the row read as a team space and the
    // impersonation shortcut served it.
    const { ch } = await orgAppUserOwnedSpace();
    const imp = ctx(colleague.id, { impersonation: { orgId: org.id } } as Partial<Context>);
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, imp), 'CHANNEL_NOT_FOUND');
  });

  it("teamChatMessages does not serve a chats:team root in a WORKER's memory", async () => {
    // `locateTeamChatRoot` filtered only `class='app' + appId`, so it could
    // return a worker-scoped root — and the App-ref convenience then applies the
    // participation gate and the impersonation shortcut to it. Asserted through
    // an IMPERSONATED reader, because for an ordinary one the memory gate
    // catches it independently and the test would pass either way.
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const workerMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:iris-mem`,
        name: 'iris-mem',
        class: 'app',
        appId: app.id,
        createdBy: owner.id,
      },
    });
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', memoryId: workerMem.id },
    });
    const wch = (
      await ensureChannelWithRoot(db, { memoryId: workerMem.id, loc: 'chats:team', name: 'team', createdBy: owner.id })
    ).channel;
    // A real message, so an empty page is EVIDENCE rather than the trivial
    // answer — the first draft asserted `{ items: [], total: 0 }` against a
    // channel with nothing in it, which passes whether the locator is narrowed
    // or not.
    // Seeded as a platform ADMIN: a worker memory is in nobody's App-derived
    // reach, so an ordinary principal cannot even post here — which is itself
    // the gate working.
    await M.createChannelMessage({}, { channelRef: wch.id, body: 'worker-internal' }, adminCtx(owner.id));
    expect((await Q.channelMessages({}, { channelRef: wch.id }, adminCtx(owner.id))).total).toBe(1);

    const imp = ctx(colleague.id, { impersonation: { orgId: org.id } } as Partial<Context>);
    expect(await Q.teamChatMessages({}, { appRef: app.id }, imp)).toEqual({ items: [], total: 0 });
  });

  it('chatLocFilter does not reach an agent chat in another user\'s SESSION memory', async () => {
    // The participation arms widened the app-class clause into per-user session
    // memories — and `saveChatSummary` writes through this filter with no
    // node-memory write gate of its own.
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const sessionMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        urn: `${org.urn}:enduser-session`,
        name: 'enduser-session',
        class: 'app',
        appId: app.id,
        userMemoryOfAgentId: agent.id,
        createdBy: owner.id,
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: sessionMem.id, loc: 'chats:enduser', name: 'end user', nodeType: 'record', data: { scope: 'private' } },
    });

    // The colleague is an org CONTRIBUTOR and an AppMember — a participant of
    // the App, and no part of this end user's session.
    await expect(
      Q.chatHistory({}, { chatId: 'chats:enduser' }, ctx(colleague.id)),
    ).rejects.toThrow(/not found/i);
  });
});

describe('the ownership discriminator is the APP\'s, not the caller\'s (@copilot round 6)', () => {
  /**
   * `isTeamSpaceRow` took `callerUserId` as the ownership discriminator. But
   * "is this row the App's team space?" is a question about the APP — so a
   * user-owned app-class memory attached to an ORG-owned App classified as that
   * App's team space for whoever owned it, and under impersonation `ctx.userId`
   * is the TARGET, so a row owned by the target took the participation path and
   * `hostMemoryReadable` returned true on `app` alone.
   */
  async function orgAppOwnedByCaller(ownerId: string) {
    const mem = await db.memory.create({
      data: {
        id: generateId(),
        ownerUserId: ownerId,
        urn: `u-${ownerId}:caller-owned-${Date.now()}`,
        name: 'caller-owned',
        class: 'app',
        appId: app.id, // ORG-owned App
        createdBy: ownerId,
      },
    });
    return (
      await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:mine', name: 'mine', createdBy: ownerId })
    ).channel;
  }

  it('an org-owned App\'s team space must be org-owned — a caller-owned row is not one', async () => {
    // The owner still reaches it (it is their memory), but via the MEMORY gate,
    // not via App participation — so a co-member does not come with them.
    const ch = await orgAppOwnedByCaller(owner.id);
    await M.createChannelMessage({}, { channelRef: ch.id, body: 'mine' }, ctx(owner.id));
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, ctx(colleague.id)), 'CHANNEL_NOT_FOUND');
  });

  it('an impersonated session cannot reach a row owned by its TARGET', async () => {
    // `ctx.userId` is the target, so a caller-keyed discriminator classified
    // the target's own memory as a team space and served it.
    const ch = await orgAppOwnedByCaller(owner.id);
    await M.createChannelMessage({}, { channelRef: ch.id, body: 'mine' }, ctx(owner.id));
    const imp = ctx(owner.id, { impersonation: { orgId: org.id } } as Partial<Context>);
    await expectCode(Q.channelMessages({}, { channelRef: ch.id }, imp), 'CHANNEL_NOT_FOUND');
  });

  it('myChats does not list chats in another user\'s SESSION memory', async () => {
    const agent = await db.agent.findFirstOrThrow({ where: { organizationId: org.id } });
    const holding = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:h-${Date.now()}`, name: 'h',
        class: 'knowledge', visibility: 'ORGANIZATION' as never, userMemoryOfAgentId: agent.id, createdBy: colleague.id,
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: holding.id, loc: 'chats:own', name: 'own', nodeType: 'record', data: { scope: 'private' } },
    });
    // Another user's SESSION memory under the same App — the row myChats used
    // to sweep in via `class: 'app'` alone.
    const sessionMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:sess-${Date.now()}`, name: 'sess',
        class: 'app', appId: app.id, userMemoryOfAgentId: agent.id, createdBy: owner.id,
      },
    });
    await db.node.create({
      data: { id: generateId(), memoryId: sessionMem.id, loc: 'chats:theirs', name: 'theirs', nodeType: 'record', data: { scope: 'private' } },
    });

    const listed = await Q.myChats({}, { agentRef: agent.id }, ctx(colleague.id));
    expect(listed.map((c: { loc: string }) => c.loc)).toEqual(['chats:own']);
  });
});
