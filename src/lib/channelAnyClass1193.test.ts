/**
 * Issue #1193 — a Channel may be hosted in a memory of ANY class.
 *
 * Holger's ruling, 2026-09-17:
 *
 *   "I see no disadvantage to hosting a channel in any class memory. The
 *    choice will affect access, but that's the owner's problem. Why close
 *    doors? Say the owner wants a channel in a private memory where only the
 *    owner has access to. Why not? Have two personal agents chat there."
 *
 * This replaces the pending four-class chat-host typology (spec 028) as the
 * answer to *which memories may host a chat*. No typology is needed: the
 * MEMORY is the boundary, which is `cor:acl:030:01`'s durable rule already.
 *
 * Two things are pinned here, and the second is the one the issue asked to be
 * TESTED rather than reasoned about (#921 gap 6: *"a chat stored anywhere else
 * is invisible"*) — **a Channel that can be created and not listed is worse
 * than one that is refused**, because the refusal at least told you.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { ensureChannelWithRoot } from './channels.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let adminId: string;
let appId: string;

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` });

/** A memory of an arbitrary class, created directly so the class is exact. */
async function memoryOfClass(
  cls: 'app' | 'knowledge' | 'personal' | 'group' | 'private',
  opts: { appId?: string; userId?: string; orgId?: string | null } = {},
) {
  return db.memory.create({
    data: {
      id: generateId(),
      name: `mem-${cls}-${Math.random().toString(36).slice(2, 8)}`,
      urn: `p1193.test:${cls}-${Math.random().toString(36).slice(2, 8)}`,
      class: cls,
      organizationId: opts.orgId === null ? null : (opts.orgId ?? orgId),
      // chk_memory_class_app_id: app_id is REQUIRED for class='app', optional
      // for knowledge/group/personal/private.
      appId: opts.appId ?? (cls === 'app' ? appId : null),
      // chk_personal_visibility_user: personal/private REQUIRE an owner.
      userId: cls === 'personal' || cls === 'private' ? (opts.userId ?? adminId) : null,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'p1193-org', urn: 'p1193-org.test' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { id: generateId(), githubId: 11930, githubUsername: 'p1193-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  const app = await db.app.create({
    data: {
      id: generateId(),
      name: 'p1193-app',
      urn: 'p1193-org.test:p1193-app',
      organizationId: orgId,
    },
  });
  appId = app.id;
});

describe('a Channel may be hosted in any memory class (#1193)', () => {
  // `group` and `private` are the two the old chat-scope validator rejected
  // OUTRIGHT as chat-root hosts ("do not hold chat-roots"), so they are the
  // sharpest cases, not the edge ones.
  for (const cls of ['app', 'knowledge', 'personal', 'group', 'private'] as const) {
    it(`creates a Channel in a ${cls}-class memory`, async () => {
      const mem = await memoryOfClass(cls);
      const { channel, rootId } = await ensureChannelWithRoot(db, {
        memoryId: mem.id,
        loc: 'chats:team',
        name: 'team',
        createdBy: adminId,
      });

      expect(channel.memoryId).toBe(mem.id);
      const root = await db.node.findUniqueOrThrow({ where: { id: rootId } });
      expect(root.loc).toBe('chats:team');
      // D-2026-08-10-005 — no scope marker, in any class.
      expect((root.data as Record<string, unknown>) ?? {}).not.toHaveProperty('scope');
    });
  }

  it('an App-less Channel leaves asDefaultOfAppId null rather than inventing one', async () => {
    // Flagged in the issue as a decision to make deliberately rather than by
    // omission: a Channel in a free-standing memory has no App to be the
    // default of, and null is the honest answer.
    // Org-owned but App-less — appId null is what makes it App-less, not the org.
    const mem = await memoryOfClass('knowledge');
    const { channel } = await ensureChannelWithRoot(db, {
      memoryId: mem.id,
      loc: 'chats:team',
      name: 'team',
      createdBy: adminId,
    });

    const apps = await db.app.findMany({ where: { defaultChannelId: channel.id } });
    expect(apps).toEqual([]);
  });
});

describe('the read surfaces FIND a Channel outside an app-class host (#1193)', () => {
  // #921 gap 6 says chat listing is agent-scoped and "a chat stored anywhere
  // else is invisible". Creating a Channel that cannot then be listed would be
  // worse than refusing it, so this is measured rather than assumed.

  it('channels(filter: memoryRef) lists a knowledge-hosted Channel', async () => {
    const mem = await memoryOfClass('knowledge');
    await ensureChannelWithRoot(db, {
      memoryId: mem.id,
      loc: 'chats:team',
      name: 'team',
      createdBy: adminId,
    });

    const page = await resolvers.Query.channels(
      {},
      { filter: { memoryRef: mem.urn }, orgId: null, limit: null, offset: null },
      ctx(),
    );
    expect(page.total).toBe(1);
    expect(page.items[0]?.loc).toBe('chats:team');
  });

  it('channel(ref:) resolves one in a PRIVATE memory for its owner', async () => {
    const mem = await memoryOfClass('private');
    const { channel } = await ensureChannelWithRoot(db, {
      memoryId: mem.id,
      loc: 'chats:team',
      name: 'team',
      createdBy: adminId,
    });

    const got = await resolvers.Query.channel({}, { ref: channel.id }, ctx());
    expect(got?.id).toBe(channel.id);
  });

  it('MESSAGING still requires an APP, whatever the class — the boundary this PR does NOT move', async () => {
    // Found by a prose sweep, not by the tests above — which is the point.
    // `resolveChannelTarget` (resolvers.teamChat.ts) requires
    // `channel.memory.appId` and refuses CHANNEL_HOST_NOT_APP otherwise, then
    // gates on `requireTeamChatAccess(ctx, app, …)`, an App-shaped predicate
    // (impersonation vs app.organizationId, App-key vs app.id,
    // isAppParticipant).
    //
    // So this PR's ruling moves the CLASS axis and not the APP axis, and those
    // are different axes: a knowledge memory WITH an appId can be messaged; a
    // knowledge memory without one cannot. Creating a Channel you cannot post
    // to is the "created but unusable" failure the issue warned about, so it is
    // pinned here rather than left for someone to hit.
    //
    // Closing it means a memory-based access gate for App-less hosts — real
    // access-control design, filed separately rather than smuggled in here.
    const appLess = await memoryOfClass('knowledge');
    const { channel: appLessChannel } = await ensureChannelWithRoot(db, {
      memoryId: appLess.id,
      loc: 'chats:team',
      name: 'team',
      createdBy: adminId,
    });

    await expect(
      resolvers.Mutation.createChannelMessage(
        {},
        { channelRef: appLessChannel.id, body: 'hello' } as never,
        ctx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'CHANNEL_HOST_NOT_APP' } });

    // ...and the same class WITH an App is fine, which locates the boundary on
    // App-ness rather than on class.
    const withApp = await memoryOfClass('knowledge', { appId });
    const { channel: appChannel } = await ensureChannelWithRoot(db, {
      memoryId: withApp.id,
      loc: 'chats:team',
      name: 'team',
      createdBy: adminId,
    });
    const posted = await resolvers.Mutation.createChannelMessage(
      {},
      { channelRef: appChannel.id, body: 'hello' } as never,
      ctx(),
    );
    expect(posted).toBeTruthy();
  });

  it('an unfiltered list finds Channels across every class at once', async () => {
    // The listing path a human actually hits. If any class were silently
    // dropped, the per-class creation tests above would still pass — which is
    // exactly the "created but invisible" failure this describes.
    const classes = ['app', 'knowledge', 'personal', 'group', 'private'] as const;
    for (const cls of classes) {
      const mem = await memoryOfClass(cls);
      await ensureChannelWithRoot(db, {
        memoryId: mem.id,
        loc: 'chats:team',
        name: `team-${cls}`,
        createdBy: adminId,
      });
    }

    const page = await resolvers.Query.channels(
      {},
      { filter: null, orgId: null, limit: null, offset: null },
      ctx(),
    );
    expect(page.total).toBe(classes.length);
    expect(page.items.map((c) => c.name).sort()).toEqual(
      classes.map((c) => `team-${c}`).sort(),
    );
  });
});
