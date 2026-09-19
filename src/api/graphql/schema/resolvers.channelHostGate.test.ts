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
        data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris', memoryId: mem.id },
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
