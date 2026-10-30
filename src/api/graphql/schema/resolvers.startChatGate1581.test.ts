/**
 * #1581: startChat reads an Agent's definition (it returns the system prompt)
 * and auto-provisions an AgentSubscription. Before this fix it did the
 * provisioning first, for a caller-supplied `userId`, with no Agent gate at
 * all: a stranger minted licenses to another org's private Agent for
 * themselves AND for any user they named, even when the chat then failed.
 *
 * Now (canChatWithAgent):
 * - the caller must reach the Agent: PUBLIC, own, an org READER, or an
 *   AppMember of an App with a live, licensed install (a pure App key: the
 *   Agent installed and licensed in its App); a refusal reads as "not found";
 * - only a pure App key may act on behalf of another user;
 * - the license is provisioned in the transaction that creates the chat, so
 *   a chat that fails leaves none.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { canChatWithAgent } from './agentChatAccess.js';
import { readFileSync } from 'node:fs';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let orgA: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let stranger: { id: string };
let victim: { id: string };
let endUser: { id: string };
let agent: { id: string; organizationId: string | null; ownerUserId: string | null; visibility: string | null; deletedAt: Date | null };
let app: { id: string };
let otherApp: { id: string };

const userCtx = (userId: string, extra: Partial<Context> = {}): Context =>
  ({ db, roles: ['READER'], userId, ...extra }) as Context;

const subsFor = (agentId: string) =>
  db.agentSubscription.findMany({ where: { agentId }, select: { userId: true } }).then((rows) => rows.map((r) => r.userId).sort());

async function seedConversations(systemMemoryId: string) {
  const nodes = [
    { loc: 'conversations', name: 'conversations' },
    { loc: 'conversations:research', name: 'research', data: { stageOrder: ['scope'], isSetup: false } },
    { loc: 'conversations:research:scope', name: 'scope', data: { promptRef: 'prompts:research:scope' } },
    { loc: 'prompts', name: 'prompts' },
    { loc: 'prompts:research', name: 'research' },
    { loc: 'prompts:research:scope', name: 'scope', content: 'Scope the research.' },
  ];
  for (const n of nodes) {
    await db.node.create({ data: {
      id: generateId(), memoryId: systemMemoryId, loc: n.loc, name: n.name, nodeType: 'system',
      data: ((n as { data?: object }).data ?? null) as never, content: (n as { content?: string }).content ?? null,
    } });
  }
}

beforeEach(async () => {
  await cleanDb(db);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'org-a', urn: 'org-a-1581' } });
  const mk = (n: number, roles: string[] = ['READER']) =>
    db.user.create({ data: { githubId: 158100 + n, githubUsername: `u1581-${n}`, roles: roles as never } });
  admin = await mk(1, ['ADMIN']);
  member = await mk(2);
  stranger = await mk(3);
  victim = await mk(4);
  endUser = await mk(5);
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: member.id, role: 'READER' } });

  const created = await M.createAgent({}, { orgId: orgA.id, name: 'secret-agent', visibility: 'ORGANIZATION' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context);
  await db.agent.update({ where: { id: created.id }, data: { systemPrompt: 'VENDOR-SECRET-PROMPT' } });
  agent = await db.agent.findUniqueOrThrow({
    where: { id: created.id },
    select: { id: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
  });
  await seedConversations(created.systemMemoryId!);

  app = await db.app.create({ data: {
    id: generateId(), name: 'research-app', urn: `${orgA.urn}:research-app`, organizationId: orgA.id,
    appAgents: { create: { agentId: agent.id } },
  } });
  otherApp = await db.app.create({ data: {
    id: generateId(), name: 'other-app', urn: `${orgA.urn}:other-app`, organizationId: orgA.id,
  } });
  // An App end user: a member of the App, NOT of the org.
  await db.appMember.create({ data: { appId: app.id, userId: endUser.id, role: 'member' } });
});

describe('#1581: startChat gates the Agent before reading or licensing anything', () => {
  it('a stranger is refused as "not found": no prompt, and no license minted', async () => {
    await expect(M.startChat(null, { agentId: agent.id }, userCtx(stranger.id)))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('a stranger naming a victim is refused, and the victim gets no license (the reproduced exploit)', async () => {
    await expect(M.startChat(null, { agentId: agent.id, userId: victim.id }, userCtx(stranger.id)))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('even a user who CAN reach the Agent may not start a chat on behalf of someone else', async () => {
    await expect(M.startChat(null, { agentId: agent.id, userId: victim.id }, userCtx(member.id)))
      .rejects.toThrow(/only an App key can start a chat on behalf of another user/);
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('CONTROL: an org READER starts the chat and is licensed', async () => {
    const out = await M.startChat(null, { agentId: agent.id }, userCtx(member.id));
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([member.id]);
  });

  it('CONTROL: an App end user (AppMember, not an org member) reaches the Agent through the live install', async () => {
    const out = await M.startChat(null, { agentId: agent.id }, userCtx(endUser.id));
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([endUser.id]);
  });

  it('the App end user loses the path when the App is uninstalled (the license must be live)', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expect(M.startChat(null, { agentId: agent.id }, userCtx(endUser.id)))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('CONTROL: a PUBLIC Agent is reachable by anyone signed in', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    const out = await M.startChat(null, { agentId: agent.id }, userCtx(stranger.id));
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([stranger.id]);
  });

  it('a chat that fails after the gate leaves no license (provisioned in the chat transaction)', async () => {
    // The Agent is reachable, but it has no conversation of this name.
    await expect(M.startChat(null, { agentId: agent.id, conversationName: 'nope' }, userCtx(member.id)))
      .rejects.toThrow();
    expect(await subsFor(agent.id)).toEqual([]);
  });
});

// #1581 review (Atilla, Copilot): real App-key contexts carry roles: [] and
// reach startChat itself. Ada's ruling (#6055): an App key acts only for a user
// with a live relationship to THAT App, and a session-bound key only for its
// session's own user; anything else reads as an unknown user.
describe('#1581: startChat through a pure App key (resolver level)', () => {
  async function appKeySessionFor(userId: string | null, appId = app.id, sessionAgentId = agent.id) {
    const mem = await db.memory.create({ data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:session-${generateId().slice(-8)}`,
      name: 'session memory', class: 'app', appId, userMemoryOfAgentId: sessionAgentId,
    } });
    const session = await db.session.create({ data: {
      id: generateId(), appId, userId, agentId: sessionAgentId, memoryId: mem.id, type: 'CHATBOT', startedAt: new Date(),
    } as never });
    return { db, appId, sessionId: session.id, roles: [] } as unknown as Context;
  }

  it('an App key starts a chat for its session user, an AppMember, and licenses them', async () => {
    const ctx = await appKeySessionFor(endUser.id);
    const out = await M.startChat(null, { agentId: agent.id, userId: endUser.id }, ctx);
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([endUser.id]);
  });

  it('an App key may NOT act for a user with no relationship to its App', async () => {
    const ctx = await appKeySessionFor(null);
    await expect(M.startChat(null, { agentId: agent.id, userId: stranger.id }, ctx))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('a session-bound App key may not license a DIFFERENT user than its session user, even an AppMember', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: victim.id, role: 'member' } });
    const ctx = await appKeySessionFor(endUser.id);
    await expect(M.startChat(null, { agentId: agent.id, userId: victim.id }, ctx))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('an App key may not act for a user licensed only through ANOTHER App (a subscription carries no App)', async () => {
    // appY installs the same Agent; `subUser` holds an active subscription to
    // the Agent (as if through some other App) but is no member of appY.
    const appY = await db.app.create({ data: {
      id: generateId(), name: 'app-y', urn: `${orgA.urn}:app-y`, organizationId: orgA.id,
      appAgents: { create: { agentId: agent.id } },
    } });
    const subUser = await db.user.create({ data: { githubId: 158190, githubUsername: 'sub-1581', roles: ['READER'] } });
    await db.agentSubscription.create({ data: { userId: subUser.id, agentId: agent.id, activatedAt: new Date() } });
    const ctx = await appKeySessionFor(subUser.id, appY.id);
    await expect(M.startChat(null, { agentId: agent.id, userId: subUser.id }, ctx))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
  });

  it('an anonymous session (no user) names nobody, not even an AppMember', async () => {
    const ctx = await appKeySessionFor(null);
    await expect(M.startChat(null, { agentId: agent.id, userId: endUser.id }, ctx))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it("a session-bound App key may chat only with its session's Agent", async () => {
    const otherAgent = await db.agent.create({ data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:other-agent`, name: 'other', type: 'CHATBOT', surfaces: ['api'],
    } as never });
    await db.appAgent.create({ data: { appId: app.id, agentId: otherAgent.id } });
    const ctx = await appKeySessionFor(endUser.id, app.id, otherAgent.id);
    await expect(M.startChat(null, { agentId: agent.id, userId: endUser.id }, ctx))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('an App key whose App does not install the Agent is refused as not found', async () => {
    const ctx = await appKeySessionFor(endUser.id, otherApp.id);
    await expect(M.startChat(null, { agentId: agent.id, userId: endUser.id }, ctx))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
  });
});

// Chip's #1583 QA + Ada #6098, through the PRODUCT mutations: createAppUser
// mints a user stamped with the App (externalAppId) but no AppMember row, and
// startAgentSession binds a session to that user. A session-bound key always
// acts as its session's user, and an App-minted user satisfies the gate.
describe('#1581: App-minted users through createAppUser + startAgentSession', () => {
  const appKey = (appId: string, sessionId?: string) =>
    ({ db, appId, roles: [], ...(sessionId ? { sessionId } : {}) }) as unknown as Context;

  /** Chat nodes startChat wrote into a session's memory. */
  async function chatNodesIn(sessionId: string) {
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { memoryId: true } });
    if (!session.memoryId) return 0;
    return db.node.count({ where: { memoryId: session.memoryId, loc: { startsWith: 'chats:' } } });
  }

  async function mintedSession(appId: string, externalId: string) {
    const user = await M.createAppUser({}, { externalId }, appKey(appId));
    const started = await M.startAgentSession({}, { agentId: agent.id, externalUserId: externalId }, appKey(appId));
    const sessionId: string = started.sessionId ?? started.session?.id ?? started.id;
    return { user, sessionId };
  }

  beforeEach(async () => {
    await db.app.update({ where: { id: app.id }, data: { createUserPermission: 'EXPLICIT' } });
  });

  it('a user THIS App minted chats with userId omitted; the chat and the license are theirs', async () => {
    const { user, sessionId } = await mintedSession(app.id, 'ext-own');
    const out = await M.startChat(null, { agentId: agent.id }, appKey(app.id, sessionId));
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([user.id]);
  });

  it('a supplied userId must equal the session user', async () => {
    const { sessionId } = await mintedSession(app.id, 'ext-own-2');
    await expect(M.startChat(null, { agentId: agent.id, userId: endUser.id }, appKey(app.id, sessionId)))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
  });

  it('a deleted minted user is refused, even with userId omitted (no anonymous bypass)', async () => {
    const { user, sessionId } = await mintedSession(app.id, 'ext-gone');
    await db.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    await expect(M.startChat(null, { agentId: agent.id }, appKey(app.id, sessionId)))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
    // startAgentSession may already have licensed the user; startChat wrote nothing.
    expect(await chatNodesIn(sessionId)).toBe(0);
  });

  it('a user minted by ANOTHER App is refused, even with userId omitted', async () => {
    // appZ installs the same Agent and mints a user; the session is then
    // re-bound to App A's key context, as a stolen session id would be.
    const appZ = await db.app.create({ data: {
      id: generateId(), name: 'app-z', urn: `${orgA.urn}:app-z`, organizationId: orgA.id,
      createUserPermission: 'EXPLICIT', appAgents: { create: { agentId: agent.id } },
    } as never });
    const { user } = await mintedSession(appZ.id, 'ext-foreign');
    const session = await db.session.create({ data: {
      id: generateId(), appId: app.id, userId: user.id, agentId: agent.id, type: 'CHATBOT', startedAt: new Date(),
    } as never });
    const before = await subsFor(agent.id);
    await expect(M.startChat(null, { agentId: agent.id }, appKey(app.id, session.id)))
      .rejects.toMatchObject({ name: 'UserNotFoundError' });
    expect(await subsFor(agent.id)).toEqual(before);
  });
});

describe('#1581 review: two concurrent first chats for the same user both complete', () => {
  it('neither chat transaction is aborted, and exactly one subscription exists', async () => {
    const results = await Promise.allSettled([
      M.startChat(null, { agentId: agent.id }, userCtx(member.id)),
      M.startChat(null, { agentId: agent.id }, userCtx(member.id)),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await subsFor(agent.id)).toEqual([member.id]);
  });
});

describe('#1581: canChatWithAgent for a pure App key', () => {
  it('allows the App the Agent is installed and licensed in, and refuses any other App', async () => {
    expect(await canChatWithAgent({ db, appId: app.id } as Context, agent)).toBe(true);
    expect(await canChatWithAgent({ db, appId: otherApp.id } as Context, agent)).toBe(false);
  });

  it('refuses an anonymous caller and a soft-deleted Agent', async () => {
    expect(await canChatWithAgent({ db } as Context, agent)).toBe(false);
    expect(await canChatWithAgent(userCtx(member.id), { ...agent, deletedAt: new Date() })).toBe(false);
  });
});

// #1573: the chat start's gate and license write commit under every
// authority anchor the gate can admit through. A revoker holding one of them
// exclusively cannot return while the license is about to commit, and after
// it commits the re-run gate refuses.
describe('#1585 review: a stale membership in a dead tenant\'s App does not block a chat', () => {
  it('a PUBLIC Agent stays reachable when the caller is also a member of an App whose org was soft-deleted', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    const deadOrg = await db.organization.create({ data: { id: generateId(), name: 'dead', urn: 'dead-1585.example' } });
    const deadApp = await db.app.create({ data: {
      id: generateId(), name: 'dead-app', urn: `${deadOrg.urn}:app`, organizationId: deadOrg.id,
      appAgents: { create: { agentId: agent.id } },
    } });
    await db.appMember.create({ data: { appId: deadApp.id, userId: stranger.id, role: 'member' } });
    // Org deletion deliberately leaves the App row intact.
    await db.organization.update({ where: { id: deadOrg.id }, data: { deletedAt: new Date() } });
    const out = await M.startChat(null, { agentId: agent.id }, userCtx(stranger.id));
    expect(out.chatId).toMatch(/^chats:/);
    expect(await subsFor(agent.id)).toEqual([stranger.id]);
  });
});

describe('#1585 review: the gate and the anchors agree on which Apps carry the right', () => {
  /** A personal (user-owned) App whose owner is then soft-deleted. */
  async function deadOwnerApp(memberId: string) {
    const owner = await db.user.create({ data: { githubId: 158170, githubUsername: 'owner-1585', roles: ['READER'] } });
    const personal = await db.app.create({ data: {
      id: generateId(), name: 'personal-app', urn: 'owner-1585:personal-app', ownerUserId: owner.id,
      appAgents: { create: { agentId: agent.id } },
    } });
    // The owner licensed the (foreign, org-private) Agent for the personal App.
    await db.agentSubscription.create({ data: { userId: owner.id, agentId: agent.id, activatedAt: new Date() } });
    await db.appMember.create({ data: { appId: personal.id, userId: memberId, role: 'member' } });
    await db.user.update({ where: { id: owner.id }, data: { deletedAt: new Date() } });
    return personal;
  }

  it("Atilla's case: a dead owner's personal App carries nothing, so its member is refused (no unanchored path)", async () => {
    await deadOwnerApp(stranger.id);
    await expect(M.startChat(null, { agentId: agent.id }, userCtx(stranger.id)))
      .rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).not.toContain(stranger.id);
  });

  it("CONTROL (Chip): a PUBLIC Agent stays reachable for a member of a dead owner's App", async () => {
    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    await deadOwnerApp(stranger.id);
    const out = await M.startChat(null, { agentId: agent.id }, userCtx(stranger.id));
    expect(out.chatId).toMatch(/^chats:/);
  });
});

// Chip (#1585 QA at 3918a7f9): anchors are chosen before the transaction, so an
// App that becomes a carrier in between (newly licensed) could admit the caller
// unanchored while deleteApp commits. Now the in-transaction gate checks every
// carrier was anchored and otherwise retries with fresh anchors.
describe('#1585 review: a carrier App that appears after anchor selection is fenced too', () => {
  async function holdTx(work: (tx: any) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const done = db.$transaction(async (tx) => { await work(tx); held(); await gate; }, { timeout: 20_000 });
    await isHeld;
    return { release, done };
  }

  it('a chat admitted only through a newly licensed App waits for that App\'s deletion and is refused', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { visibility: 'PUBLIC' } });
    const orgX = await db.organization.create({ data: { id: generateId(), name: 'org-x', urn: 'org-x-1585.example' } });
    const appX = await db.app.create({ data: {
      id: generateId(), name: 'app-x', urn: `${orgX.urn}:app`, organizationId: orgX.id,
      appAgents: { create: { agentId: agent.id } },
    } });
    await db.appMember.create({ data: { appId: appX.id, userId: stranger.id, role: 'member' } });

    // H2: deleteApp in flight on App X (exclusive App anchor, uncommitted).
    const deleting = await holdTx(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: appX.id }], 'exclusive');
      await tx.app.update({ where: { id: appX.id }, data: { deletedAt: new Date() } });
    });
    // H1: holds the Agent anchor so the chat blocks AFTER choosing its anchors
    // (App X is unlicensed then, so not a carrier and not anchored).
    let releaseH1!: () => void;
    const h1Gate = new Promise<void>((r) => { releaseH1 = r; });
    let h1Held!: () => void;
    const h1IsHeld = new Promise<void>((r) => { h1Held = r; });
    const h1 = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'agent', id: agent.id }], 'exclusive');
      h1Held();
      await h1Gate;
      // Before releasing: App X becomes licensed, and the Agent stops being
      // PUBLIC, so the chat can now be admitted ONLY through App X.
      await tx.agentOrgGrant.create({ data: { orgId: orgX.id, agentId: agent.id, activatedAt: new Date() } });
      await tx.agent.update({ where: { id: agent.id }, data: { visibility: 'ORGANIZATION' } });
    }, { timeout: 20_000 });
    await h1IsHeld;

    const chat = M.startChat(null, { agentId: agent.id }, userCtx(stranger.id));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1); // the chat waits on H1
      releaseH1();
      await h1;
      // With the fix the chat retries with App X anchored and now waits on H2.
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      releaseH1();
      deleting.release();
      await deleting.done;
    }
    await expect(chat).rejects.toBeTruthy();
    expect(await subsFor(agent.id)).toEqual([]);
  });
});

describe('#1573: startChat waits for an in-flight revocation of its read right', () => {
  /** Hold an exclusive anchor and apply `revoke` uncommitted until released. */
  async function holdRevocation(anchor: { kind: 'org' | 'app'; id: string }, revoke: (tx: any) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const done = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [anchor], 'exclusive');
      await revoke(tx);
      held();
      await gate;
    }, { timeout: 20_000 });
    await isHeld;
    return { release, done };
  }

  it('an org READER whose membership is being removed is refused after the removal commits', async () => {
    const holder = await holdRevocation({ kind: 'org', id: orgA.id }, (tx) =>
      tx.orgMember.updateMany({ where: { organizationId: orgA.id, userId: member.id }, data: { deletedAt: new Date() } }));
    const chat = M.startChat(null, { agentId: agent.id }, userCtx(member.id));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      holder.release();
      await holder.done;
    }
    await expect(chat).rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });

  it('an App end user whose App membership is being removed is refused after the removal commits', async () => {
    const holder = await holdRevocation({ kind: 'app', id: app.id }, (tx) =>
      tx.appMember.delete({ where: { appId_userId: { appId: app.id, userId: endUser.id } } }));
    const chat = M.startChat(null, { agentId: agent.id }, userCtx(endUser.id));
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
    } finally {
      holder.release();
      await holder.done;
    }
    await expect(chat).rejects.toMatchObject({ name: 'AgentNotFoundError' });
    expect(await subsFor(agent.id)).toEqual([]);
  });
});

// Chip (#1585 QA at 861b6504): the gate and the anchor-coverage proof read the
// carrier Apps separately, so a carrier could admit the gate, be deleted
// unanchored, and vanish from the coverage read. They now share ONE read: the
// in-transaction gate admits only from the carrier set it just proved
// anchored. Pinned at both ends.
describe('#1585 review: admission and anchor coverage come from one carrier read', () => {
  it('canChatWithAgent admits only from the carrier set it is given, never a fresh read', async () => {
    // endUser is an AppMember of a live, licensed App: a fresh read admits.
    expect(await canChatWithAgent(userCtx(endUser.id), agent)).toBe(true);
    // Handed an empty verified set, it must not go and find that App itself.
    expect(await canChatWithAgent(userCtx(endUser.id), agent, { carriers: [] })).toBe(false);
  });

  it('startChat\'s in-transaction gate passes its verified carrier set to canChatWithAgent', () => {
    const src = readFileSync('src/api/graphql/schema/resolvers.mutation.chat.ts', 'utf8');
    const start = src.indexOf('await withAuthorizedTx(ctx, chatAnchors, async (txCtx) => {');
    const gate = src.slice(start, src.indexOf('}, async (tx) => {', start));
    expect(gate.match(/chatCarrierApps\(/g)).toHaveLength(1);
    expect(gate).toContain('canChatWithAgent(txCtx, current, { carriers })');
  });
});
