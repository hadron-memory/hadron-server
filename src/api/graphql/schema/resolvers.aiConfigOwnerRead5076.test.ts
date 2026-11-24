/**
 * #5076 (billing F2b; cor:dmo:050:10, :12, cor:acl:010:01) — the owner of a person's App reads its masked AI-configuration
 * lists with no AppMember row, and effectiveAccess reports the owner-only gate a person's AI configuration enforces.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, User, Agent, App } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const Q = resolvers.Query as any;
let org: Organization, owner: User, other: User, platform: User, orgAdmin: User, contributor: User, member: User;
let mine: App, orgApp: App, orgAgent: Agent, myAgent: Agent;
let mineCfg: { id: string }, orgAppCfg: { id: string };
const ctx = (u: User, roles: string[] = ['READER']): Context => ({ db, userId: u.id, roles } as Context);
const code = async (p: Promise<unknown>) => p.then(() => null, (e: any) => e.extensions?.code ?? (e.name === 'AppNotFoundError' ? 'APP_NOT_FOUND' : e.name) ?? String(e));

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId();
  org = await db.organization.create({ data: { name: 'Acme', urn: `acme-${s}.example` } });
  [owner, other, platform, orgAdmin, contributor, member] = await Promise.all(['owner', 'other', 'platform', 'oadmin', 'contrib', 'member'].map(h =>
    db.user.create({ data: { handle: `${h}-${s}`, roles: h === 'platform' ? ['ADMIN'] : ['READER'] } })));
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' },
  ] });
  // A person's App: the owner has NO AppMember row (the Agent offers no owner role).
  mine = await db.app.create({ data: { ownerUserId: owner.id, name: 'Mine', urn: `owner-${s}:mine` } });
  mineCfg = await db.aiServiceConfig.create({ data: { appId: mine.id, name: 'default', provider: 'glm', model: 'glm-5' } });
  await db.appMember.create({ data: { appId: mine.id, userId: member.id, role: 'reader' } });
  orgApp = await db.app.create({ data: { organizationId: org.id, name: 'Work', urn: `${org.urn}:work` } });
  orgAppCfg = await db.aiServiceConfig.create({ data: { appId: orgApp.id, name: 'default', provider: 'glm', model: 'glm-5' } });
  orgAgent = await db.agent.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:a`, visibility: 'ORGANIZATION' } });
  myAgent = await db.agent.create({ data: { ownerUserId: owner.id, name: 'M', urn: `owner-${s}:agent`, visibility: 'PERSONAL' } });
  await db.appAgent.create({ data: { appId: orgApp.id, agentId: orgAgent.id } });
  await createDbAgentOrgGrant(db, org.id, orgAgent.id);
});

const picker = (c: Context, appRef = mine.id, agentRef?: string) => Q.resolveAiServiceConfigs(null, { appRef, agentRef }, c);
const choices = (c: Context, appRef = mine.id) => Q.chatAiConfigChoices(null, { appRef }, c);
const run = (u: User) => ({ ...ctx(u), appId: mine.id, clientId: 'run:fixture' }) as unknown as Context;
const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId: generateId(), agentId: null }, fn);

describe('the owner of a person\'s App reads both masked lists', () => {
  it('the picker admits the owner with no member row', async () => {
    expect((await picker(ctx(owner))).map((c: any) => c.id)).toContain(mineCfg.id);
  });
  it('the chat choices admit the owner with no member row', async () => {
    expect(await choices(ctx(owner))).toBeTruthy();
  });
  it('a member and a platform admin are still admitted to both', async () => {
    expect(await code(picker(ctx(member)))).toBeNull();
    expect(await code(choices(ctx(member)))).toBeNull();
    expect(await code(picker(ctx(platform, ['ADMIN'])))).toBeNull();
    expect(await code(choices(ctx(platform, ['ADMIN'])))).toBeNull();
  });
  it('an Agent not installed in the App answers as a missing Agent for the owner, as for a member', async () => {
    await db.appMember.create({ data: { appId: mine.id, userId: other.id, role: 'reader' } });
    const asMember = await code(picker(ctx(other), mine.id, myAgent.id));
    const asOwner = await code(picker(ctx(owner), mine.id, myAgent.id));
    expect(asMember).not.toBeNull();
    expect(asOwner).toBe(asMember);
  });
});

describe('everyone else is refused exactly as today', () => {
  it('another user: FORBIDDEN from the picker, APP_NOT_FOUND from the choices', async () => {
    expect(await code(picker(ctx(other)))).toBe('FORBIDDEN');
    expect(await code(choices(ctx(other)))).toBe('APP_NOT_FOUND');
  });
  it('an impersonated session of the owner', async () => {
    const c = { ...ctx(owner), impersonation: { actorId: platform.id } } as unknown as Context;
    expect(await code(picker(c))).toBe('FORBIDDEN');
    expect(await code(choices(c))).toBe('APP_NOT_FOUND');
  });
  it('the App\'s own key', async () => {
    const c = { db, appId: mine.id, roles: [] } as Context;
    expect(await code(picker(c))).toBe('FORBIDDEN');
    expect(await code(choices(c))).toBe('APP_NOT_FOUND');
  });
  it('a run principal acting for the owner', async () => {
    expect(await code(picker(run(owner)))).toBe('FORBIDDEN');
    expect(await code(choices(run(owner)))).toBe('APP_NOT_FOUND');
  });
  it('a worker-bound request refuses the choices', async () => {
    expect(await code(asWorker(() => choices(ctx(owner))))).toBe('APP_NOT_FOUND');
  });
  it('an organization ADMIN or CONTRIBUTOR who is not an App member is still refused an organization App\'s picker', async () => {
    expect(await code(picker(ctx(orgAdmin), orgApp.id))).toBe('FORBIDDEN');
    expect(await code(picker(ctx(contributor), orgApp.id))).toBe('FORBIDDEN');
    expect(await code(choices(ctx(orgAdmin), orgApp.id))).toBe('APP_NOT_FOUND');
  });
});

describe('effectiveAccess reports the gate enforced on a person\'s AI configuration', () => {
  const ea = (user: User, resource: string, caller: Context) => Q.effectiveAccess(null, { user: user.id, resource }, caller);
  it('the owner has one AICONFIG_OWNER grant on a config of a person\'s App and a platform admin has none', async () => {
    const asPlatform = ctx(platform, ['OWNER']);
    const o = await ea(owner, mineCfg.id, asPlatform);
    expect(o.grants.map((g: any) => [g.source, g.role])).toEqual([['AICONFIG_OWNER', 'owner']]);
    const p = await ea(platform, mineCfg.id, asPlatform);
    expect(p.grants).toEqual([]);
  });
  it('the same for a config of a person\'s Agent', async () => {
    const cfg = await db.aiServiceConfig.create({ data: { agentId: myAgent.id, name: 'default', provider: 'glm', model: 'g' } });
    const asPlatform = ctx(platform, ['OWNER']);
    expect((await ea(owner, cfg.id, asPlatform)).grants.map((g: any) => g.source)).toEqual(['AICONFIG_OWNER']);
    expect((await ea(platform, cfg.id, asPlatform)).grants).toEqual([]);
    expect((await ea(other, cfg.id, asPlatform)).grants).toEqual([]);
  });
  it('organization and platform contexts are unchanged', async () => {
    const agentCfg = await db.aiServiceConfig.create({ data: { agentId: orgAgent.id, name: 'default', provider: 'glm', model: 'g' } });
    const orgCfg = await db.aiServiceConfig.create({ data: { organizationId: org.id, name: 'default', provider: 'glm', model: 'g' } });
    const asPlatform = ctx(platform, ['OWNER']);
    const table: Record<string, unknown> = {};
    for (const [name, cfg] of [['org', orgCfg], ['orgApp', orgAppCfg], ['orgAgent', agentCfg]] as const)
      for (const [who, u] of [['orgAdmin', orgAdmin], ['contributor', contributor], ['platform', platform]] as const)
        table[`${name}/${who}`] = (await ea(u, cfg.id, asPlatform)).grants.map((g: any) => [g.source, g.role]);
    expect(table).toEqual({
      'org/orgAdmin': [['AICONFIG_OWNER', 'ADMIN']], 'org/contributor': [], 'org/platform': [['PLATFORM_ROLE', 'ADMIN']],
      'orgApp/orgAdmin': [['AICONFIG_OWNER', 'ADMIN']], 'orgApp/contributor': [], 'orgApp/platform': [['PLATFORM_ROLE', 'ADMIN']],
      'orgAgent/orgAdmin': [['AICONFIG_OWNER', 'ADMIN']], 'orgAgent/contributor': [], 'orgAgent/platform': [['PLATFORM_ROLE', 'ADMIN']],
    });
  });
});
