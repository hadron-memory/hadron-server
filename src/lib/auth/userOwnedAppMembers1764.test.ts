/**
 * #1764 — members of a user-owned App are participants (Holger "A", #8151 / #8155; cor:acl:010:01).
 *
 * A user-owned App's participants are its owner AND every AppMember at any role. They read and write the App's team
 * space, see its tasks and events, and may create root tasks. User-owned MEMORIES and AGENTS stay strictly owner-only
 * (spec 047), a non-member and a member of ANOTHER user's App are refused, the App-derived set and the predicate agree,
 * and no nested field of a relaxed gate hands a member what only the owner may see.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { getAccessibleMemoryIds, isAppParticipant } from '../../api/graphql/schema/resolvers.helpers.js';
import { canReadMemory, canWriteToMemory, getMemoryAccess } from '../../mcp/access-control.js';
import { participantAppIds } from './appParticipation.js';
import { computeEffectiveAccess } from './effectiveAccess.js';
import { ensureChannelWithRoot } from '../channels.js';
import type { AuthContext } from '../../middleware/auth.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
const auth = (userId: string, extra: Partial<AuthContext> = {}): AuthContext => ({ userId, roles: ['READER'], ...extra }) as AuthContext;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) { return e instanceof GraphQLError ? (e.extensions?.code as string) ?? e.message : (e as Error).message; }
  return undefined;
}

let owner: { id: string };
let member: { id: string };
let outsider: { id: string };
let otherOwner: { id: string };
let otherMember: { id: string };
let app: { id: string; ownerUserId: string | null; organizationId: string | null };
let otherApp: { id: string };
let teamSpace: { id: string };
let ownersMemory: { id: string };
let otherTeamSpace: { id: string };

async function mkUser(n: number, handle: string) {
  return db.user.create({ data: { id: generateId(), githubId: 96_500 + n, githubUsername: `uo-${n}-${Date.now()}-${Math.floor(Math.random() * 1e5)}`, handle: `${handle}${Date.now() % 100000}`, roles: ['READER'] }, select: { id: true } });
}
async function mkApp(ownerId: string, name: string) {
  const a = await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name, urn: `u${generateId().toLowerCase()}:${name}` } });
  await db.appMember.create({ data: { appId: a.id, userId: ownerId, role: 'owner' } });
  const space = await db.memory.create({ data: { id: generateId(), class: 'app', appId: a.id, ownerUserId: ownerId, name: `${name} space`, urn: `${a.urn}-space` } });
  return { app: a, space };
}

beforeEach(async () => {
  await cleanDb(db);
  [owner, member, outsider, otherOwner, otherMember] = [
    await mkUser(1, 'own'), await mkUser(2, 'mem'), await mkUser(3, 'out'), await mkUser(4, 'oth'), await mkUser(5, 'omem'),
  ];
  ({ app, space: teamSpace } = await mkApp(owner.id, 'mine'));
  ({ app: otherApp, space: otherTeamSpace } = await mkApp(otherOwner.id, 'theirs'));
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'reader' } });
  await db.appMember.create({ data: { appId: otherApp.id, userId: otherMember.id, role: 'member' } });
  // A user-owned MEMORY of the owner that is not the App's team space: strict, whoever is in the App.
  ownersMemory = await db.memory.create({ data: { id: generateId(), class: 'knowledge', ownerUserId: owner.id, name: 'Owner notes', urn: `own${generateId().toLowerCase()}:notes` } });
});

describe('the predicate', () => {
  it('owner and every member at any role participate; a non-member and a member of another user\'s App do not', async () => {
    expect(await isAppParticipant(ctx(owner.id), app)).toBe(true);
    expect(await isAppParticipant(ctx(member.id), app)).toBe(true);
    expect(await isAppParticipant(ctx(outsider.id), app)).toBe(false);
    expect(await isAppParticipant(ctx(otherMember.id), app)).toBe(false);
    expect(await isAppParticipant(ctx(otherOwner.id), app)).toBe(false);
    // A role string never matters.
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: member.id } }, data: { role: 'whatever-it-says' } });
    expect(await isAppParticipant(ctx(member.id), app)).toBe(true);
    // No identity, no participation; and never under impersonation (identity-scoped).
    expect(await isAppParticipant({ db } as Context, app)).toBe(false);
    expect(await isAppParticipant(ctx(member.id, { impersonation: { orgId: 'x' } as any }), app)).toBe(false);
  });

  it('the SET agrees with the predicate for every principal and App (the chatLocFilter case)', async () => {
    for (const u of [owner, member, outsider, otherOwner, otherMember]) {
      for (const a of [app, otherApp]) {
        const row = await db.app.findUniqueOrThrow({ where: { id: a.id }, select: { id: true, organizationId: true, ownerUserId: true } });
        const viaPredicate = await isAppParticipant(ctx(u.id), row);
        const viaSet = (await participantAppIds(db, { userId: u.id }, { includeMemberships: true })).includes(a.id);
        expect({ user: u.id, app: a.id, viaSet }).toEqual({ user: u.id, app: a.id, viaSet: viaPredicate });
      }
    }
    // The set that omits memberships (the access fold's "arms a member row cannot express") still holds only the owner arm.
    expect(await participantAppIds(db, { userId: member.id })).toEqual([]);
    expect(await participantAppIds(db, { userId: owner.id })).toEqual([app.id]);
    // Under impersonation a user-owned App is in nobody's set.
    expect(await participantAppIds(db, { userId: member.id, impersonation: { orgId: 'x' } }, { includeMemberships: true })).toEqual([]);
  });
});

describe('the team space: members read and write it; everyone else still cannot', () => {
  it('MCP: the access map, the point read and the point write', async () => {
    expect((await getMemoryAccess(db, auth(member.id))).get(teamSpace.id)).toBe('READ_WRITE');
    expect(await canReadMemory(db, auth(member.id), teamSpace.id)).toBe(true);
    expect(await canWriteToMemory(db, auth(member.id), teamSpace.id)).toBe(true);
    for (const u of [outsider, otherMember, otherOwner]) {
      expect((await getMemoryAccess(db, auth(u.id))).has(teamSpace.id)).toBe(false);
      expect(await canReadMemory(db, auth(u.id), teamSpace.id)).toBe(false);
      expect(await canWriteToMemory(db, auth(u.id), teamSpace.id)).toBe(false);
    }
    // The owner is unchanged.
    expect(await canWriteToMemory(db, auth(owner.id), teamSpace.id)).toBe(true);
  });

  it('an impersonated support session reaches nothing of a user-owned App, even as one of its members', async () => {
    const imp = auth(member.id, { impersonation: { orgId: 'x', adminUserId: 'a' } as never });
    expect((await getMemoryAccess(db, imp)).has(teamSpace.id)).toBe(false);
    expect(await canReadMemory(db, imp, teamSpace.id)).toBe(false);
    expect(await canWriteToMemory(db, imp, teamSpace.id)).toBe(false);
    expect(await getAccessibleMemoryIds(ctx(member.id, { impersonation: { orgId: 'x' } as never }))).not.toContain(teamSpace.id);
  });

  it('GraphQL: the readable-memory set', async () => {
    expect(await getAccessibleMemoryIds(ctx(member.id))).toContain(teamSpace.id);
    for (const u of [outsider, otherMember]) expect(await getAccessibleMemoryIds(ctx(u.id))).not.toContain(teamSpace.id);
    // ...and a member of THIS App does not get the OTHER user's App's space.
    expect(await getAccessibleMemoryIds(ctx(member.id))).not.toContain(otherTeamSpace.id);
  });

  it('the audit (effectiveAccess) reports what the gates enforce', async () => {
    const mem = await db.memory.findUniqueOrThrow({ where: { id: teamSpace.id }, include: { workerOf: { select: { id: true, appId: true, retiredAt: true, heldByUserId: true } } } });
    const forMember = await computeEffectiveAccess(db, { id: member.id, roles: ['READER'] }, { kind: 'memory', memory: mem as never });
    expect(forMember.canRead).toBe(true);
    expect(forMember.canWrite).toBe(true);
    expect(forMember.canManage).toBe(false);
    const forOutsider = await computeEffectiveAccess(db, { id: outsider.id, roles: ['READER'] }, { kind: 'memory', memory: mem as never });
    expect(forOutsider.canRead).toBe(false);
    const appRow = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    const appMember = await computeEffectiveAccess(db, { id: member.id, roles: ['READER'] }, { kind: 'app', app: appRow as never });
    expect(appMember.canRead).toBe(true);
    expect(appMember.canWrite).toBe(true);
    expect(appMember.canManage).toBe(false);
    expect((await computeEffectiveAccess(db, { id: outsider.id, roles: ['READER'] }, { kind: 'app', app: appRow as never })).canRead).toBe(false);
  });
});

describe('what stays strict', () => {
  it('the owner\'s other user-owned memory is the owner\'s alone, though the member is in the owner\'s App', async () => {
    expect(await canReadMemory(db, auth(member.id), ownersMemory.id)).toBe(false);
    expect(await canWriteToMemory(db, auth(member.id), ownersMemory.id)).toBe(false);
    expect(await getAccessibleMemoryIds(ctx(member.id))).not.toContain(ownersMemory.id);
    expect((await getMemoryAccess(db, auth(member.id))).has(ownersMemory.id)).toBe(false);
    // Even attached to the App's agent: a fold never makes a user-owned memory a member's.
    const agent = await db.agent.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'Mine', urn: `own${generateId().toLowerCase()}:mine`, visibility: 'ORGANIZATION' } as never });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: ownersMemory.id, role: 'read' } });
    expect((await getMemoryAccess(db, auth(member.id))).has(ownersMemory.id)).toBe(false);
    expect(await getAccessibleMemoryIds(ctx(member.id))).not.toContain(ownersMemory.id);
  });

  it('an app-class row of THIS App that belongs to someone other than the App owner is nobody\'s team space', async () => {
    const stray = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, ownerUserId: otherOwner.id, name: 'stray', urn: `${app.id}-stray` } });
    expect(await canReadMemory(db, auth(member.id), stray.id)).toBe(false);
    expect(await canWriteToMemory(db, auth(member.id), stray.id)).toBe(false);
    expect((await getMemoryAccess(db, auth(member.id))).has(stray.id)).toBe(false);
    expect(await getAccessibleMemoryIds(ctx(member.id))).not.toContain(stray.id);
    const mem = await db.memory.findUniqueOrThrow({ where: { id: stray.id }, include: { workerOf: { select: { id: true, appId: true, retiredAt: true, heldByUserId: true } } } });
    expect((await computeEffectiveAccess(db, { id: member.id, roles: ['READER'] }, { kind: 'memory', memory: mem as never })).canRead).toBe(false);
  });

  it('a member does not become a manager: no keys, no member management, no settings', async () => {
    expect(await code(Q.appKeys({}, { appRef: app.id }, ctx(member.id)))).toBeDefined();
    expect(await code(M.createAppKey({}, { appRef: app.id, label: 'x' }, ctx(member.id)))).toBeDefined();
    expect(await db.appKey.count({ where: { appId: app.id } })).toBe(0);
  });

  it('the App object and its nested secrets are not handed to a member through any participant-gated type', async () => {
    // Participation relaxes the team-space, task and chat gates. The App object itself (keys, members, AI config) is
    // admin material behind its own gates, and the participant-gated types return no App object.
    expect(await code(Q.app({}, { ref: app.id }, ctx(member.id)))).toBeDefined();
    expect(await code(Q.appAIConfig({}, { appRef: app.id }, ctx(member.id)))).toBeDefined();
    const made = await M.createAgentTask({}, { input: { appRef: app.id, title: 'T' } }, ctx(member.id));
    expect(Object.keys(made)).not.toContain('app');
    expect(Object.keys(made)).not.toContain('keys');
    // ...and the member cannot add members or rename the App.
    expect(await code(M.ensureAppMember({}, { appRef: app.id, userRef: outsider.id, role: 'member' }, ctx(member.id)))).toBeDefined();
    expect(await db.appMember.count({ where: { appId: app.id, userId: outsider.id } })).toBe(0);
  });

  it('a worker\'s working memory and a session memory stay out of the member\'s reach', async () => {
    const agent = await db.agent.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'Mine2', urn: `own${generateId().toLowerCase()}:mine2`, visibility: 'ORGANIZATION' } as never });
    const workerMem = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, ownerUserId: owner.id, name: 'worker mem', urn: `${app.id}-w` } });
    await db.worker.create({ data: { id: generateId(), appId: app.id, agentId: agent.id, name: 'W', slug: 'w', memoryId: workerMem.id } as never });
    const sessionMem = await db.memory.create({ data: { id: generateId(), class: 'app', appId: app.id, ownerUserId: owner.id, userMemoryOfAgentId: agent.id, name: 'sess', urn: `${app.id}-s` } });
    for (const m of [workerMem, sessionMem]) {
      expect(await canReadMemory(db, auth(member.id), m.id)).toBe(false);
      expect(await canWriteToMemory(db, auth(member.id), m.id)).toBe(false);
    }
  });
});

describe('tasks and the team chat', () => {
  it('a member lists tasks, reads one, and creates a root task; a non-member is concealed', async () => {
    expect(await Q.agentTasks({}, { appRef: app.id }, ctx(member.id))).toEqual([]);
    const made = await M.createAgentTask({}, { input: { appRef: app.id, title: 'From a member' } }, ctx(member.id));
    expect(made.title).toBe('From a member');
    expect((await Q.agentTask({}, { id: made.id }, ctx(member.id))).id).toBe(made.id);
    expect((await Q.agentTask({}, { id: made.id }, ctx(owner.id))).id).toBe(made.id);
    expect(await code(Q.agentTasks({}, { appRef: app.id }, ctx(outsider.id)))).toBe('APP_NOT_FOUND');
    expect(await code(Q.agentTasks({}, { appRef: app.id }, ctx(otherMember.id)))).toBe('APP_NOT_FOUND');
    expect(await code(M.createAgentTask({}, { input: { appRef: app.id, title: 'nope' } }, ctx(outsider.id)))).toBe('APP_NOT_FOUND');
  });

  it('the team chat: a member reads and posts; a non-member is refused; impersonation never reaches it', async () => {
    // The team chat's root lives in the team space (the Team Agent bootstrap is not what is under test).
    await ensureChannelWithRoot(db, { memoryId: teamSpace.id, loc: 'chats:team', name: 'team', createdBy: owner.id, asDefaultOfAppId: app.id });
    await M.createTeamChatMessage({}, { appRef: app.id, body: 'hello from a member' }, ctx(member.id));
    const page = await Q.teamChatMessages({}, { appRef: app.id }, ctx(member.id));
    expect(page.total).toBe(1);
    expect(await code(Q.teamChatMessages({}, { appRef: app.id }, ctx(outsider.id)))).toBe('FORBIDDEN');
    expect(await code(Q.teamChatMessages({}, { appRef: app.id }, ctx(otherMember.id)))).toBe('FORBIDDEN');
    expect(await code(M.createTeamChatMessage({}, { appRef: app.id, body: 'x' }, ctx(outsider.id)))).toBe('FORBIDDEN');
    expect(await code(Q.teamChatMessages({}, { appRef: app.id }, ctx(member.id, { impersonation: { orgId: 'x' } as any })))).toBe('FORBIDDEN');
  });
});
