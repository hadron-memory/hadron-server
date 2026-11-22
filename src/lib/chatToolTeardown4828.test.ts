/**
 * #4828 (#597 follow-up; hrn:node:hadronmemory.com:specs:cor:dmo:080:04, "no tool connection is ever left that no live row points to"):
 * deleting an App, an organization, or an account whose sole-member organization or owned App holds a Telegram or Slack
 * registration must tear down the tool-side registration, through ONE shared path, after authorization and after commit, once per
 * connection. Real database; only the two provider tool clients' delete calls are replaced (they never throw by contract).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { deleteUserAccount } from '../controller/operations/deleteUser.js';
import { deleteSlackToolConnection } from './slackClient.js';
import { deleteTelegramToolConnection } from './telegramClient.js';

vi.mock('./slackClient.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./slackClient.js')>()), deleteSlackToolConnection: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./telegramClient.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./telegramClient.js')>()), deleteTelegramToolConnection: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const slackDelete = vi.mocked(deleteSlackToolConnection);
const telegramDelete = vi.mocked(deleteTelegramToolConnection);
let org: { id: string }, otherOrg: { id: string };
let appA: { id: string }, appB: { id: string }, otherApp: { id: string };
let admin: { id: string }, member: { id: string }, platform: { id: string };
const ctx = (userId: string, roles: string[] = ['READER']): Context => ({ db, roles, userId }) as unknown as Context;

async function user(name: string, orgId: string | null, role: 'OWNER' | 'ADMIN' | 'READER' = 'READER') {
  const u = await db.user.create({ data: { id: generateId(), email: `${name}-${generateId().slice(0, 5)}@s4828.test`, name } });
  if (orgId) await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: u.id, role } });
  return u;
}
const telegram = (organizationId: string, appId: string, tool: string) => db.telegramConnection.create({
  data: { organizationId, appId, toolConnectionId: tool, botId: `bot-${tool}`, botUsername: `bot_${tool}`, displayName: tool } });
const slack = (organizationId: string, defaultAppId: string, tool: string) => db.slackConnection.create({
  data: { organizationId, defaultAppId, toolConnectionId: tool, teamId: `T-${tool}`, teamName: tool, botUserId: `U-${tool}`, botId: `B-${tool}` } });
const live = async () => ({
  telegram: (await db.telegramConnection.findMany({ where: { deletedAt: null }, select: { toolConnectionId: true } })).map((c) => c.toolConnectionId).sort(),
  slack: (await db.slackConnection.findMany({ where: { deletedAt: null }, select: { toolConnectionId: true } })).map((c) => c.toolConnectionId).sort(),
});
const calls = () => ({
  telegram: telegramDelete.mock.calls.map((c) => c[1]).sort(),
  slack: slackDelete.mock.calls.map((c) => c[1]).sort(),
});
/** The teardown is fire-and-forget after commit: let the microtask queue run before reading the calls. */
const settle = () => new Promise<void>((r) => setImmediate(r));

beforeEach(async () => {
  await cleanDb(db);
  slackDelete.mockReset().mockResolvedValue(undefined);
  telegramDelete.mockReset().mockResolvedValue(undefined);
  org = await db.organization.create({ data: { id: generateId(), name: 'td-org', urn: 'td-org' } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'td-other', urn: 'td-other' } });
  appA = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'a', urn: 'td-org::a' } });
  appB = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'b', urn: 'td-org::b' } });
  otherApp = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'o', urn: 'td-other::o' } });
  admin = await user('admin', org.id, 'ADMIN');
  member = await user('member', org.id, 'READER');
  platform = await db.user.create({ data: { id: generateId(), email: `platform-${generateId().slice(0, 5)}@s4828.test`, name: 'platform', roles: ['ADMIN'] } });
  await telegram(org.id, appA.id, 'tg-a'); await telegram(org.id, appB.id, 'tg-b'); await telegram(otherOrg.id, otherApp.id, 'tg-other');
  await slack(org.id, appA.id, 'sl-a'); await slack(org.id, appB.id, 'sl-b'); await slack(otherOrg.id, otherApp.id, 'sl-other');
});

describe('#4828 deleteApp tears down that App\'s Telegram and Slack registrations', () => {
  it('soft-deletes both rows, asks each tool once, and touches no other App\'s connection', async () => {
    await expect(M.deleteApp({}, { ref: appA.id }, ctx(admin.id))).resolves.toBe(true);
    await settle();
    expect(calls()).toEqual({ telegram: ['tg-a'], slack: ['sl-a'] });
    expect(telegramDelete).toHaveBeenCalledWith('telegram', 'tg-a');
    expect(slackDelete).toHaveBeenCalledWith('slack', 'sl-a');
    expect(await live()).toEqual({ telegram: ['tg-b', 'tg-other'], slack: ['sl-b', 'sl-other'] });
    const row = await db.telegramConnection.findFirstOrThrow({ where: { toolConnectionId: 'tg-a' } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(admin.id);
  });

  it('judges authorization first: a refused caller deletes nothing and tears nothing down', async () => {
    await expect(M.deleteApp({}, { ref: appA.id }, ctx(member.id))).rejects.toThrow();
    await settle();
    expect(calls()).toEqual({ telegram: [], slack: [] });
    expect(await live()).toEqual({ telegram: ['tg-a', 'tg-b', 'tg-other'], slack: ['sl-a', 'sl-b', 'sl-other'] });
  });

  it('a second delete of the App, and a connection already deleted, ask the tool nothing more', async () => {
    await db.telegramConnection.updateMany({ where: { toolConnectionId: 'tg-a' }, data: { deletedAt: new Date() } });
    await M.deleteApp({}, { ref: appA.id }, ctx(admin.id));
    await settle();
    expect(calls()).toEqual({ telegram: [], slack: ['sl-a'] });
    await expect(M.deleteApp({}, { ref: appA.id }, ctx(admin.id))).rejects.toThrow();
    await settle();
    expect(slackDelete).toHaveBeenCalledTimes(1);
  });

  it('a tool that is down or refuses never fails the delete: the rows are gone and the failure is logged, not thrown', async () => {
    telegramDelete.mockRejectedValue(new Error('tool unreachable'));
    slackDelete.mockRejectedValue(new Error('tool unreachable'));
    await expect(M.deleteApp({}, { ref: appA.id }, ctx(admin.id))).resolves.toBe(true);
    await settle();
    expect((await live()).telegram).not.toContain('tg-a');
  });
});

describe('#4828 a registration already deleted is never asked of its tool again', () => {
  it('App scope: both providers\' already-deleted rows are neither returned nor re-torn', async () => {
    await db.telegramConnection.updateMany({ where: { toolConnectionId: 'tg-b' }, data: { deletedAt: new Date() } });
    await db.slackConnection.updateMany({ where: { toolConnectionId: 'sl-b' }, data: { deletedAt: new Date() } });
    await M.deleteApp({}, { ref: appB.id }, ctx(admin.id));
    await settle();
    expect(calls()).toEqual({ telegram: [], slack: [] });
  });

  it('organization scope: the already-deleted rows of both providers are skipped, the live ones torn down once', async () => {
    await db.telegramConnection.updateMany({ where: { toolConnectionId: 'tg-b' }, data: { deletedAt: new Date() } });
    await db.slackConnection.updateMany({ where: { toolConnectionId: 'sl-b' }, data: { deletedAt: new Date() } });
    await M.deleteOrganization({}, { ref: org.id }, ctx(platform.id, ['ADMIN']));
    await settle();
    expect(calls()).toEqual({ telegram: ['tg-a'], slack: ['sl-a'] });
  });
});

describe('#4828 deleteOrganization tears down every registration of the organization', () => {
  it('both providers, both Apps, once each; another organization\'s connections are untouched', async () => {
    await expect(M.deleteOrganization({}, { ref: org.id }, ctx(platform.id, ['ADMIN']))).resolves.toBe(true);
    await settle();
    expect(calls()).toEqual({ telegram: ['tg-a', 'tg-b'], slack: ['sl-a', 'sl-b'] });
    expect(await live()).toEqual({ telegram: ['tg-other'], slack: ['sl-other'] });
  });

  it('records who deleted the organization on every connection it cascaded (both providers)', async () => {
    await M.deleteOrganization({}, { ref: org.id }, ctx(platform.id, ['ADMIN']));
    const t = await db.telegramConnection.findMany({ where: { organizationId: org.id } });
    const sl = await db.slackConnection.findMany({ where: { organizationId: org.id } });
    expect(t.map((r) => r.deletedBy)).toEqual([platform.id, platform.id]);
    expect(sl.map((r) => r.deletedBy)).toEqual([platform.id, platform.id]);
  });

  it('two concurrent organization deletes ask each tool once between them', async () => {
    await Promise.allSettled([
      M.deleteOrganization({}, { ref: org.id }, ctx(platform.id, ['ADMIN'])),
      M.deleteOrganization({}, { ref: org.id }, ctx(platform.id, ['ADMIN'])),
    ]);
    await settle();
    expect(calls()).toEqual({ telegram: ['tg-a', 'tg-b'], slack: ['sl-a', 'sl-b'] });
  });

  it('judges the platform-admin gate first, and deleting it again asks the tools nothing more', async () => {
    await expect(M.deleteOrganization({}, { ref: org.id }, ctx(member.id))).rejects.toThrow();
    await settle();
    expect(calls()).toEqual({ telegram: [], slack: [] });
    await M.deleteOrganization({}, { ref: org.id }, ctx(platform.id, ['ADMIN']));
    await expect(M.deleteOrganization({}, { ref: org.id }, ctx(platform.id, ['ADMIN']))).rejects.toThrow();
    await settle();
    expect(telegramDelete).toHaveBeenCalledTimes(2);
    expect(slackDelete).toHaveBeenCalledTimes(2);
  });
});

describe('#4828 an account erasure tears down what its sole-member organization held', () => {
  it('the registrations of an organization that dies with the account are asked to go, after commit; an organization the person only belongs to is untouched', async () => {
    const solo = await db.organization.create({ data: { id: generateId(), name: 'solo', urn: 'td-solo' } });
    const person = await user('solo-person', solo.id, 'OWNER');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: person.id, role: 'READER' } });
    const soloApp = await db.app.create({ data: { id: generateId(), organizationId: solo.id, name: 's', urn: 'td-solo::s' } });
    await telegram(solo.id, soloApp.id, 'tg-solo'); await slack(solo.id, soloApp.id, 'sl-solo');
    await deleteUserAccount(db, { targetUserId: person.id, actorUserId: person.id });
    await settle();
    expect(calls()).toEqual({ telegram: ['tg-solo'], slack: ['sl-solo'] });
    expect(await live()).toEqual({ telegram: ['tg-a', 'tg-b', 'tg-other'], slack: ['sl-a', 'sl-b', 'sl-other'] });
  });
});
