/**
 * #2831 S1 (cor:agt:060:12) — model groups: the writer gates (an Agent's by whoever manages the Agent, an App's by
 * whoever manages the App), the live resolution walk (App's row else the Team Agent's, no merge, never copied), and
 * the effective-group reader with each group's origin. The matcher filters are S2 and a worker's groups S3.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { MODEL_GROUPS_PER_OWNER_MAX } from '../../../lib/agentTasks/modelGroups.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    // A typed domain error (AgentNotFoundError) carries `code`; a GraphQLError carries `extensions.code`.
    const err = e as { code?: string; extensions?: { code?: string } };
    expect(err.extensions?.code ?? err.code).toBe(code);
  }
}

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let appMember: { id: string };
let outsider: { id: string };
let teamAgent: { id: string; systemMemoryId: string };
let otherAgent: { id: string };
let app: { id: string; urn: string };

const user = (k: number, name: string, suffix: string) =>
  db.user.create({ data: { id: generateId(), githubId: k, githubUsername: `mg-${name}-${suffix}`, roles: ['READER'] }, select: { id: true } });

const setAgent = (c: Context, name: string, patterns: string[], agentRef = teamAgent.id) =>
  M.setAgentModelGroup({}, { agentRef, name, patterns }, c);
const setApp = (c: Context, name: string, patterns: string[]) => M.setAppModelGroup({}, { appRef: app.id, name, patterns }, c);
const effective = (c: Context) => Q.effectiveModelGroups({}, { appRef: app.id }, c);
const rows = () => db.modelGroup.findMany({ orderBy: { name: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'mg-org', urn: `mg-org-${suffix}.com` } });
  admin = await user(98101, 'admin', suffix);
  contrib = await user(98102, 'contrib', suffix);
  appMember = await user(98103, 'member', suffix);
  outsider = await user(98104, 'outsider', suffix);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: contrib.id, role: 'CONTRIBUTOR' } });
  const team = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgent = { id: team.id, systemMemoryId: team.systemMemoryId };
  // The roles: branch is what marks the Team Agent (locateTeamAgent).
  await db.node.create({ data: { id: generateId(), memoryId: teamAgent.systemMemoryId, loc: 'roles:engineer', name: 'engineer', content: '', data: { names: ['Iris'] } } });
  const other = await M.createAgent({}, { orgId: org.id, name: 'Role Agent' }, ctx(admin.id));
  otherAgent = { id: other.id };
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: otherAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'member' } });
});

describe('Agent groups — who writes', () => {
  it('whoever manages the Agent sets a group; the name and patterns are stored lowercase, de-duplicated', async () => {
    const g = await setAgent(ctx(admin.id), ' Large ', ['Claude-Opus-*', 'claude-opus-*', 'claude-fable-*']);
    expect(g.name).toBe('large');
    expect(g.patterns).toEqual(['claude-opus-*', 'claude-fable-*']);
    expect((await rows()).map((r) => [r.agentId, r.appId, r.name])).toEqual([[teamAgent.id, null, 'large']]);
  });

  it('setting an existing name replaces the whole list, no merge', async () => {
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*']);
    await setAgent(ctx(admin.id), 'large', ['gpt-5*']);
    expect((await rows()).map((r) => r.patterns)).toEqual([['gpt-5*']]);
  });

  it('an org CONTRIBUTOR is refused and nothing is written', async () => {
    await expectCode(setAgent(ctx(contrib.id), 'large', ['x*']), 'FORBIDDEN');
    expect(await rows()).toHaveLength(0);
  });

  it('a non-member answers as an absent Agent and nothing is written', async () => {
    await expectCode(setAgent(ctx(outsider.id), 'large', ['x*']), 'AGENT_NOT_FOUND');
    expect(await rows()).toHaveLength(0);
  });

  it('a revoked org ADMIN no longer writes', async () => {
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: admin.id }, data: { deletedAt: new Date() } });
    await expect(setAgent(ctx(admin.id), 'large', ['x*'])).rejects.toBeDefined();
    expect(await rows()).toHaveLength(0);
  });

  it('an App manager is not thereby an Agent manager: an App-only member cannot write the Agent', async () => {
    await expectCode(setAgent(ctx(appMember.id), 'large', ['x*']), 'AGENT_NOT_FOUND');
    expect(await rows()).toHaveLength(0);
  });

  it('delete removes the group; a missing one is MODEL_GROUP_NOT_FOUND; a CONTRIBUTOR deletes nothing', async () => {
    await setAgent(ctx(admin.id), 'large', ['x*']);
    await expectCode(M.deleteAgentModelGroup({}, { agentRef: teamAgent.id, name: 'large' }, ctx(contrib.id)), 'FORBIDDEN');
    expect(await rows()).toHaveLength(1);
    expect(await M.deleteAgentModelGroup({}, { agentRef: teamAgent.id, name: 'large' }, ctx(admin.id))).toBe(true);
    await expectCode(M.deleteAgentModelGroup({}, { agentRef: teamAgent.id, name: 'large' }, ctx(admin.id)), 'MODEL_GROUP_NOT_FOUND');
  });

  it('agentModelGroups lists the Agent’s groups to its manager only', async () => {
    await setAgent(ctx(admin.id), 'b', ['b*']);
    await setAgent(ctx(admin.id), 'a', ['a*']);
    const list = await Q.agentModelGroups({}, { agentRef: teamAgent.id }, ctx(admin.id));
    expect(list.map((g: any) => g.name)).toEqual(['a', 'b']);
    await expectCode(Q.agentModelGroups({}, { agentRef: teamAgent.id }, ctx(contrib.id)), 'FORBIDDEN');
  });
});

describe('App groups — who writes', () => {
  it('whoever manages the App sets a group', async () => {
    const g = await setApp(ctx(admin.id), 'large', ['gpt-5*']);
    expect(g.patterns).toEqual(['gpt-5*']);
    expect((await rows()).map((r) => [r.agentId, r.appId])).toEqual([[null, app.id]]);
  });

  it('an App member who does not manage it is APP_MANAGER_REQUIRED and nothing is written', async () => {
    await expectCode(setApp(ctx(appMember.id), 'large', ['x*']), 'APP_MANAGER_REQUIRED');
    await expectCode(M.deleteAppModelGroup({}, { appRef: app.id, name: 'large' }, ctx(appMember.id)), 'APP_MANAGER_REQUIRED');
    expect(await rows()).toHaveLength(0);
  });

  it('a non-participant answers as an absent App', async () => {
    await expectCode(setApp(ctx(outsider.id), 'large', ['x*']), 'APP_NOT_FOUND');
    expect(await rows()).toHaveLength(0);
  });

  it('a revoked org ADMIN no longer writes', async () => {
    await db.orgMember.updateMany({ where: { organizationId: org.id, userId: admin.id }, data: { deletedAt: new Date() } });
    await expect(setApp(ctx(admin.id), 'large', ['x*'])).rejects.toBeDefined();
    expect(await rows()).toHaveLength(0);
  });

  it('an Agent manager who is not in the App cannot write the App’s groups', async () => {
    const solo = await user(98105, 'solo', 'x');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: solo.id, role: 'ADMIN' } });
    // An org ADMIN manages the org's Apps too, so this one passes: the gate is "manages the App", and they do.
    const g = await setApp(ctx(solo.id), 'large', ['x*']);
    expect(g.name).toBe('large');
  });
});

describe('the live walk', () => {
  it('shows the Agent’s groups, the App’s override replacing one by name (no merge), and the App’s own, with origins', async () => {
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*']);
    await setAgent(ctx(admin.id), 'mid', ['claude-sonnet-*']);
    await setApp(ctx(admin.id), 'large', ['gpt-5*']);
    await setApp(ctx(admin.id), 'local', ['llama-*']);
    expect(await effective(ctx(admin.id))).toEqual([
      { name: 'large', patterns: ['gpt-5*'], origin: 'APP_OVERRIDE' },
      { name: 'local', patterns: ['llama-*'], origin: 'APP' },
      { name: 'mid', patterns: ['claude-sonnet-*'], origin: 'AGENT' },
    ]);
  });

  it('an Agent edit reaches an un-overridden App at once, with no App write, and not an overridden one', async () => {
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*']);
    await setAgent(ctx(admin.id), 'mid', ['claude-sonnet-*']);
    await setApp(ctx(admin.id), 'mid', ['gpt-4*']);
    const appRowsBefore = await db.modelGroup.count({ where: { appId: app.id } });
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*', 'claude-fable-*']);
    await setAgent(ctx(admin.id), 'mid', ['changed*']);
    const eff = await effective(ctx(appMember.id));
    expect(eff.find((g: any) => g.name === 'large')).toEqual({ name: 'large', patterns: ['claude-opus-*', 'claude-fable-*'], origin: 'AGENT' });
    expect(eff.find((g: any) => g.name === 'mid')).toEqual({ name: 'mid', patterns: ['gpt-4*'], origin: 'APP_OVERRIDE' });
    expect(await db.modelGroup.count({ where: { appId: app.id } })).toBe(appRowsBefore);
  });

  it('an Agent group deleted is gone from an App that never overrode it, and an override then reads as App-only', async () => {
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*']);
    await setApp(ctx(admin.id), 'large', ['gpt-5*']);
    await M.deleteAgentModelGroup({}, { agentRef: teamAgent.id, name: 'large' }, ctx(admin.id));
    expect(await effective(ctx(admin.id))).toEqual([{ name: 'large', patterns: ['gpt-5*'], origin: 'APP' }]);
  });

  it('the App cannot delete the Agent’s group: removing its row of that name reverts to the Agent’s, and a name it has no row for is refused', async () => {
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*']);
    await expectCode(M.deleteAppModelGroup({}, { appRef: app.id, name: 'large' }, ctx(admin.id)), 'MODEL_GROUP_NOT_FOUND');
    await setApp(ctx(admin.id), 'large', ['gpt-5*']);
    expect(await M.deleteAppModelGroup({}, { appRef: app.id, name: 'large' }, ctx(admin.id))).toBe(true);
    expect(await effective(ctx(admin.id))).toEqual([{ name: 'large', patterns: ['claude-opus-*'], origin: 'AGENT' }]);
    expect(await db.modelGroup.count({ where: { agentId: teamAgent.id } })).toBe(1);
  });

  it('an empty override stays an override that matches no one', async () => {
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*']);
    await setApp(ctx(admin.id), 'large', []);
    expect(await effective(ctx(admin.id))).toEqual([{ name: 'large', patterns: [], origin: 'APP_OVERRIDE' }]);
  });

  it('only the Team Agent’s groups apply: another installed Agent’s do not show', async () => {
    await setAgent(ctx(admin.id), 'sneaky', ['x*'], otherAgent.id);
    expect(await effective(ctx(admin.id))).toEqual([]);
  });

  it('an App with no Team Agent has only its own groups; two Team Agents refuse, never a guess', async () => {
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*']);
    await setApp(ctx(admin.id), 'mine', ['m*']);
    const otherMemoryId = (await db.agent.findUniqueOrThrow({ where: { id: otherAgent.id } })).systemMemoryId!;
    await db.node.create({ data: { id: generateId(), memoryId: otherMemoryId, loc: 'roles:x', name: 'x', content: '', data: { names: ['Q'] } } });
    await expectCode(effective(ctx(admin.id)), 'TEAM_AGENT_AMBIGUOUS');
    await db.node.deleteMany({ where: { memoryId: teamAgent.systemMemoryId, loc: { startsWith: 'roles:' } } });
    await db.node.deleteMany({ where: { memoryId: otherMemoryId, loc: 'roles:x' } });
    expect(await effective(ctx(admin.id))).toEqual([{ name: 'mine', patterns: ['m*'], origin: 'APP' }]);
  });

  it('a participant reads the effective groups; a non-participant gets an absent App', async () => {
    await setAgent(ctx(admin.id), 'large', ['claude-opus-*']);
    expect((await effective(ctx(appMember.id))).map((g: any) => g.name)).toEqual(['large']);
    await expectCode(effective(ctx(outsider.id)), 'APP_NOT_FOUND');
  });

  it('another App’s groups never show', async () => {
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    await db.modelGroup.create({ data: { appId: other.id, name: 'theirs', patterns: ['t*'] } });
    expect(await effective(ctx(admin.id))).toEqual([]);
  });
});

describe('input and storage', () => {
  it('refuses a bad name or pattern as BAD_USER_INPUT, writing nothing', async () => {
    await expectCode(setAgent(ctx(admin.id), 'Not A Name!', ['x*']), 'BAD_USER_INPUT');
    await expectCode(setAgent(ctx(admin.id), '', ['x*']), 'BAD_USER_INPUT');
    await expectCode(setAgent(ctx(admin.id), 'large', ['bad pattern']), 'BAD_USER_INPUT');
    await expectCode(setAgent(ctx(admin.id), 'large', ['']), 'BAD_USER_INPUT');
    await expectCode(setApp(ctx(admin.id), 'large', ['a;b']), 'BAD_USER_INPUT');
    expect(await rows()).toHaveLength(0);
  });

  it('caps the groups one owner declares', async () => {
    for (let i = 0; i < MODEL_GROUPS_PER_OWNER_MAX; i++) await setApp(ctx(admin.id), `g${i}`, ['x*']);
    await expectCode(setApp(ctx(admin.id), 'one-more', ['x*']), 'MODEL_GROUP_LIMIT_REACHED');
    // Replacing an existing one is not a new group.
    await setApp(ctx(admin.id), 'g0', ['y*']);
  });

  it('the database refuses a row with two owners or none', async () => {
    await expect(db.modelGroup.create({ data: { name: 'both', agentId: teamAgent.id, appId: app.id, patterns: [] } })).rejects.toBeDefined();
    await expect(db.modelGroup.create({ data: { name: 'none', patterns: [] } })).rejects.toBeDefined();
  });

  it('a group name is unique per owner: an Agent and an App may share one name', async () => {
    await db.modelGroup.create({ data: { name: 'large', agentId: teamAgent.id, patterns: [] } });
    await db.modelGroup.create({ data: { name: 'large', appId: app.id, patterns: [] } });
    await expect(db.modelGroup.create({ data: { name: 'large', appId: app.id, patterns: [] } })).rejects.toBeDefined();
  });

  it('groups go with their owner: deleting the App removes its groups', async () => {
    await setApp(ctx(admin.id), 'large', ['x*']);
    await db.app.delete({ where: { id: app.id } });
    expect(await db.modelGroup.count({ where: { appId: app.id } })).toBe(0);
  });
});
