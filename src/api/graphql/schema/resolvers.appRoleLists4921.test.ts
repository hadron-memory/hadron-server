/**
 * #4921 slice A (hrn:node:hadronmemory.com:specs:cor:agt:060:16 is the precedent; hrn:node:hadronmemory.com:specs:cor:dmo:050:12 says who
 * manages) — the App's role lists, one per purpose (link a defect, the register pick's role route, withdraw a negative
 * review verdict): their set door (whoever manages the App), their read door (the roster audience), the MCP tools, and
 * that no door reads them yet (slice B switches the doors).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { DISABLED_TEAM_TOOLS } from '../../../mcp/disabledTools.js';
import { mcpRoleListArgs, registerAgentTaskTools } from '../../../mcp/agentTaskTools.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);

let appId: string, otherAppId: string, agentId: string, orgId: string;
let ownerId: string, orgAdminId: string, orgOwnerId: string, platformAdminId: string, memberId: string, outsiderId: string;
let keyId: string;
const ctx = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const keyCtx = (): Context => ({ db, appId, appKeyId: keyId, roles: [] });

const failure = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return { message: g.message, extensions: g.extensions };
  }
};
const code = async (p: Promise<unknown>) => (await failure(p))?.extensions?.code ?? 'RESOLVED';

const PURPOSES = ['DEFECT_LINK', 'REGISTER_PICK', 'REVIEW_WITHDRAW'] as const;
type Purpose = (typeof PURPOSES)[number];
const FIELD: Record<Purpose, 'defectLink' | 'registerPick' | 'reviewWithdraw'> = { DEFECT_LINK: 'defectLink', REGISTER_PICK: 'registerPick', REVIEW_WITHDRAW: 'reviewWithdraw' };
const COLUMN: Record<Purpose, 'defectLinkRoles' | 'registerPickRoles' | 'reviewWithdrawRoles'> = { DEFECT_LINK: 'defectLinkRoles', REGISTER_PICK: 'registerPickRoles', REVIEW_WITHDRAW: 'reviewWithdrawRoles' };
const setList = (purpose: unknown, roles: unknown, c: Context, app = appId) => M.setAppRoleList({}, { appRef: app, purpose, roles }, c);
const readLists = (c: Context, app = appId) => Q.appRoleLists({}, { appRef: app }, c);
const EMPTY = { appId: '', defectLink: [], registerPick: [], reviewWithdraw: [] };
const stored = async (purpose: Purpose) => (await db.agentTaskStallSchedule.findUnique({ where: { appId } }))?.[COLUMN[purpose]] ?? [];
beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().slice(-8).toLowerCase();
  const user = (h: string, roles = ['READER']) => db.user.create({ data: { handle: `${h}-${n}`, roles: roles as never } }).then((u) => u.id);
  ownerId = await user('owner');
  orgAdminId = await user('oadmin');
  orgOwnerId = await user('oowner');
  platformAdminId = await user('padmin', ['READER', 'ADMIN']);
  memberId = await user('member');
  outsiderId = await user('outsider');
  const org = await db.organization.create({ data: { name: 'Wake roles', urn: `wr-${n}.test` } });
  orgId = org.id;
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: orgAdminId, role: 'ADMIN' },
    { organizationId: org.id, userId: orgOwnerId, role: 'OWNER' },
  ] });
  agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Wake Agent' }, ctx(orgAdminId))).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `wr-${n}.test:team` } })).id;
  otherAppId = (await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `wr-${n}.test:other` } })).id;
  await db.appMember.createMany({ data: [
    { appId, userId: ownerId, role: 'owner' },
    { appId, userId: memberId, role: 'member' },
    { appId: otherAppId, userId: memberId, role: 'member' },
  ] });
  keyId = (await db.appKey.create({ data: { id: generateId(), appId, keyHash: `h-${generateId()}`, keyPreview: 'abcd' } })).id;
});

/** A worker of `app` in `role`, held by the member, with one open session. */
async function worker(role: string, app = appId) {
  const id = generateId();
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id, appId: app, agentId, name: `W-${id}`, slug: `w-${id}`, role, heldByUserId: memberId } });
  await db.session.create({ data: { id: generateId(), appId: app, agentId, workerId: id, family: 'claude', llmModel: 'claude-sonnet-5-5', startedAt: ago(1), updatedAt: new Date() } });
  return id;
}

describe('#4921 slice A: the App role lists, one per purpose, empty by default, set by whoever manages the App (cor:dmo:050:12)', () => {
  it('every list is empty by default and a participant reads all three', async () => {
    expect(await readLists(ctx(memberId))).toEqual({ ...EMPTY, appId });
  });

  describe.each(PURPOSES)('purpose %s', (purpose) => {
    it.each([
      ['the App owner (an owner-role member)', () => ownerId],
      ['an org ADMIN', () => orgAdminId],
      ['an org OWNER', () => orgOwnerId],
      ['a platform admin', () => platformAdminId],
    ])('%s sets, replaces and clears it, and the read returns what is stored', async (_label, who) => {
      const c = ctx(who(), who() === platformAdminId ? { roles: ['READER', 'ADMIN'] } : {});
      expect(await setList(purpose, ['triager'], c)).toEqual({ appId, purpose, roles: ['triager'] });
      expect((await readLists(ctx(memberId)))[FIELD[purpose]]).toEqual(['triager']);
      expect(await setList(purpose, ['qa-engineer', 'Lead'], c)).toEqual({ appId, purpose, roles: ['lead', 'qa-engineer'] });
      expect(await setList(purpose, [], c)).toEqual({ appId, purpose, roles: [] });
      expect(await stored(purpose)).toEqual([]);
    });

    it('is independent of the other two lists and of the saturation wake list', async () => {
      await M.setSaturationAlarmWakeRoles({}, { appRef: appId, roles: ['wake'] }, ctx(ownerId));
      await setList(purpose, ['mine'], ctx(ownerId));
      const all = await readLists(ctx(memberId));
      for (const p of PURPOSES) expect(all[FIELD[p]]).toEqual(p === purpose ? ['mine'] : []);
      expect((await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } })).saturationWakeRoles).toEqual(['wake']);
      await M.setSaturationAlarmWakeRoles({}, { appRef: appId, roles: [] }, ctx(ownerId));
      expect(await stored(purpose)).toEqual(['mine']);
    });

    it('collapses duplicates (after trimming and case) and keeps a role no worker holds', async () => {
      expect((await setList(purpose, [' Triager ', 'triager', 'TRIAGER', 'nobody-has-this'], ctx(ownerId))).roles).toEqual(['nobody-has-this', 'triager']);
    });

    it.each([
      ['an empty name', ['']],
      ['a blank name', ['   ']],
      ['a name with a colon', ['a:b']],
      ['a name with inner whitespace', ['tri ager']],
      ['a name over 64 characters', ['x'.repeat(65)]],
      ['more than 32 distinct names', Array.from({ length: 33 }, (_, i) => `role-${i}`)],
      ['a null list', null],
    ])('refuses %s as BAD_USER_INPUT before any write', async (_label, roles) => {
      await setList(purpose, ['triager'], ctx(ownerId));
      const before = await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } });
      expect(await code(setList(purpose, roles, ctx(ownerId)))).toBe('BAD_USER_INPUT');
      expect(await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } })).toEqual(before);
    });

    it('MUTANT GUARD: a participant who does not manage the App is refused APP_MANAGER_REQUIRED, and the list is unchanged', async () => {
      await setList(purpose, ['triager'], ctx(ownerId));
      expect(await code(setList(purpose, ['member-role'], ctx(memberId)))).toBe('APP_MANAGER_REQUIRED');
      expect(await stored(purpose)).toEqual(['triager']);
    });

    it('a bound worker adding its own role is refused, even when its holder manages the App, without an instruction', async () => {
      const w = await worker('triager');
      await db.appMember.update({ where: { appId_userId: { appId, userId: memberId } }, data: { role: 'owner' } });
      const s = await db.session.findFirstOrThrow({ where: { workerId: w } });
      const bound = ctx(memberId, { sessionId: s.id });
      expect(await code(runAsActor({ workerId: w, agentId }, () => setList(purpose, ['triager'], bound)))).toBe('APP_MANAGER_REQUIRED');
      expect(await stored(purpose)).toEqual([]);
    });

    it('writing the stored list again (any order or spelling) changes nothing; clearing a never-set list writes no row', async () => {
      await db.agentTaskStallSchedule.deleteMany({ where: { appId } });
      await setList(purpose, [], ctx(ownerId));
      expect(await db.agentTaskStallSchedule.count({ where: { appId } })).toBe(0);
      await setList(purpose, ['triager', 'qa'], ctx(ownerId));
      const before = await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } });
      await new Promise((r) => setTimeout(r, 20));
      await setList(purpose, ['QA', ' triager', 'qa'], ctx(ownerId));
      expect(await db.agentTaskStallSchedule.findUniqueOrThrow({ where: { appId } })).toEqual(before);
    });
  });

  it('an unknown purpose is refused BAD_USER_INPUT before any write', async () => {
    expect(await code(setList('COORDINATOR', ['x'], ctx(ownerId)))).toBe('BAD_USER_INPUT');
    expect(await db.agentTaskStallSchedule.count({ where: { appId } })).toBe(0);
  });

  it('a caller who cannot see the App gets APP_NOT_FOUND, byte-identical to a missing App, on the set and the read', async () => {
    const missing = generateId();
    const norm = (f: unknown, id: string) => JSON.stringify(f).split(id).join('<ref>');
    const setHidden = await failure(setList('DEFECT_LINK', ['x'], ctx(outsiderId)));
    const setMissing = await failure(setList('DEFECT_LINK', ['x'], ctx(outsiderId), missing));
    expect(setHidden?.extensions?.code).toBe('APP_NOT_FOUND');
    expect(norm(setHidden, appId)).toBe(norm(setMissing, missing));
    expect(norm(await failure(readLists(ctx(outsiderId))), appId)).toBe(norm(await failure(readLists(ctx(outsiderId), missing)), missing));
    expect(await db.agentTaskStallSchedule.count({ where: { appId } })).toBe(0);
  });

  it('the read answers exactly as the roster does, for an outsider, a participant and the App key', async () => {
    for (const c of [ctx(outsiderId), ctx(memberId), keyCtx()]) {
      const roster = await failure(Q.teamRoster({}, { appRef: appId }, c));
      expect(await failure(readLists(c)), JSON.stringify(c.userId ?? c.appKeyId)).toEqual(roster);
    }
  });

  it('the App key is refused exactly as on setAgentTaskStallSchedule', async () => {
    const precedent = await failure(M.setAgentTaskStallSchedule({}, { appRef: appId, input: { notStartedMinutes: 33 } }, keyCtx()));
    const mine = await failure(setList('REGISTER_PICK', ['x'], keyCtx()));
    expect(precedent, 'the precedent refuses the App key').not.toBeNull();
    expect(mine?.extensions?.code).toBe(precedent?.extensions?.code);
    expect(await db.agentTaskStallSchedule.count({ where: { appId } })).toBe(0);
  });

  it('slice A changes no door: with every list set, the doors still behave as on main (no role-list read in the doors)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['resolvers.prProtocol.ts', 'resolvers.registerRolePick.ts']) {
      expect(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).not.toMatch(/defectLinkRoles|registerPickRoles|reviewWithdrawRoles|appRoleLists/);
    }
  });
});

describe('#4921 slice A: the MCP door is registered disabled, as the team cut requires (#3082 R1)', () => {
  it('the set and read tools are registered through the team cut, never listed', () => {
    registerAgentTaskTools({} as never, { db, auth: {} } as never);
    expect(DISABLED_TEAM_TOOLS).toEqual(expect.arrayContaining(['hadron_role_lists', 'hadron_role_list_set']));
  });

  it('the set tool forwards appRef, purpose and roles unchanged and drops its own session argument', () => {
    expect(mcpRoleListArgs({ session: 's-1', appRef: 'team-app', purpose: 'DEFECT_LINK', roles: [' Triager ', 'qa'] }))
      .toEqual({ appRef: 'team-app', purpose: 'DEFECT_LINK', roles: [' Triager ', 'qa'] });
    expect(Object.keys(mcpRoleListArgs({ session: 's-1', appRef: 'a', purpose: 'REGISTER_PICK', roles: [] })).sort()).toEqual(['appRef', 'purpose', 'roles']);
  });
});
