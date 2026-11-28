/**
 * The record read gate for a per-user chat holding (hadron-internal#87, cor:cht:010:02): a knowledge-class memory created by
 * the startChat no-App path (userMemoryOfAgentId set, ownerUserId null) is read by its CREATOR alone. #5394 retired that
 * path, so the shape is seeded from a real startChat under a seed App, reshaped to the row the retired path wrote.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { resolvers, type Context } from './resolvers.js';
import { filterReadableMemoryRecords, MEMORY_RECORD_GATE_SELECT } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let orgId: string, otherOrgId: string, agentId: string, holdingId: string, plainId: string, appId: string;
const u: Record<string, string> = {};
const as = (who: string, roles: string[] = ['READER']): Context => ({ db, userId: u[who], roles }) as Context;

async function user(handle: string, orgRole?: 'READER' | 'CONTRIBUTOR' | 'ADMIN' | 'OWNER', org = orgId) {
  const id = (await db.user.create({ data: { handle } })).id;
  u[handle] = id;
  if (orgRole) await db.orgMember.create({ data: { organizationId: org, userId: id, role: orgRole } });
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { name: 'Holding org', urn: 'holding87.test' } })).id;
  otherOrgId = (await db.organization.create({ data: { name: 'Other org', urn: 'holdother87.test' } })).id;
  await user('creator', 'ADMIN');
  await user('member', 'READER');
  await user('contributor', 'CONTRIBUTOR');
  await user('orgadmin', 'ADMIN');
  await user('orgowner', 'OWNER');
  await user('foreigner', 'READER', otherOrgId);
  await user('outsider');
  await user('platformadmin');
  const agent = await M.createAgent({}, { orgRef: orgId, name: 'Holding agent', visibility: 'ORGANIZATION' }, as('creator'));
  agentId = agent.id;
  const systemId = agent.systemMemoryId;
  for (const row of [
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts:step', content: 'STAGE', data: {} },
  ]) await db.node.create({ data: { memoryId: systemId, name: row.loc, nodeType: 'system', ...row } });
  await serveEveryAgent(db);
  // #5394: before, the fixture seeded the holding through the real no-App path (the Agent's manager started a chat with
  // no installed App). That route is retired, so a start with no App is refused, and the holding such a start left is
  // made the way it left it: a real start under a seed App, then the home reshaped to the retired route's row (knowledge,
  // no App, no owner column, ORGANIZATION), and the seed App removed.
  await expect(M.startChat({}, { agentRef: agentId, scope: 'private', conversationName: 'flow' }, as('creator')))
    .rejects.toMatchObject({ code: 'CHAT_APP_NOT_IDENTIFIED' });
  const seedApp = await db.app.create({ data: { name: 'Seed app', urn: 'holding87.test:seed', organizationId: orgId, appAgents: { create: { agentId } } } });
  const started = await M.startChat({}, { agentRef: agentId, appRef: seedApp.id, scope: 'private', conversationName: 'flow' }, as('creator'));
  holdingId = (await chatNodeByLocOrThrow(db, started.chatId)).memoryId;
  await db.memory.update({ where: { id: holdingId }, data: { class: 'knowledge', userId: null, appId: null, visibility: 'ORGANIZATION' } });
  await db.app.delete({ where: { id: seedApp.id } });
  const seeded = await db.memory.findUniqueOrThrow({ where: { id: holdingId } });
  // Guard the fixture's own shape, so these pins cannot go green on a different row.
  expect(seeded).toMatchObject({ class: 'knowledge', ownerUserId: null, appId: null, userMemoryOfAgentId: agentId, createdBy: u.creator });
  plainId = (await db.memory.create({
    data: { id: generateId(), name: 'Plain', urn: 'holding87.test:plain', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION', createdBy: u.creator },
  })).id;
  appId = (await db.app.create({ data: { name: 'Home app', urn: 'holding87.test:app', organizationId: orgId } })).id;
});

const read = (who: Context, id = holdingId) => Q.memory({}, { ref: id }, who);

describe('a per-user chat holding record is read by its creator alone (hadron-internal#87)', () => {
  it('(a) the creator reads it', async () => {
    expect((await read(as('creator')))?.id).toBe(holdingId);
  });

  for (const [label, who, roles] of [
    ['another org member', 'member', ['READER']],
    ['an org contributor', 'contributor', ['READER']],
    ['an org admin', 'orgadmin', ['READER']],
    ['an org owner', 'orgowner', ['READER']],
    // Above the platform ADMIN/OWNER short-circuit: the check must not sit below it.
    ['a platform ADMIN who is not a member', 'platformadmin', ['ADMIN']],
    ['a platform OWNER who is not a member', 'platformadmin', ['OWNER']],
    ['a platform ADMIN who is an org member', 'member', ['ADMIN']],
  ] as const) {
    it(`(b) ${label} gets null, the same as a missing id`, async () => {
      const got = await read(as(who, [...roles]));
      expect(got).toBeNull();
      expect(got).toEqual(await read(as(who, [...roles]), generateId()));
    });
  }

  it('(c) a member of another org and an outsider get null', async () => {
    expect(await read(as('foreigner'))).toBeNull();
    expect(await read(as('outsider'))).toBeNull();
  });

  it('(d) an App-bound personal home read by a co-member stays null', async () => {
    const homeId = (await db.memory.create({
      data: { id: generateId(), name: 'Home', urn: 'holding87.test:home', organizationId: orgId, class: 'personal', userId: u.creator,
        appId, userMemoryOfAgentId: agentId, createdBy: u.creator },
    })).id;
    expect(await read(as('member'), homeId)).toBeNull();
    expect(await read(as('orgadmin'), homeId)).toBeNull();
    expect((await read(as('creator'), homeId))?.id).toBe(homeId);
  });

  it('(e) an impersonated session, an App key and a run principal get null, even carrying the creator', async () => {
    const impersonated = { db, userId: u.creator, roles: [], impersonation: { orgId } } as unknown as Context;
    const appKey = { db, appId, organizationId: orgId, roles: [] } as unknown as Context;
    const run = { db, ...runAuthContext({ id: generateId(), appId, userId: u.creator, organizationId: orgId }) } as unknown as Context;
    expect(await read(impersonated)).toBeNull();
    expect(await read(appKey)).toBeNull();
    expect(await read(run)).toBeNull();
  });

  it('(f) the batch filter drops it for a non-creator and keeps it for the creator, the total agreeing', async () => {
    const rows = await db.memory.findMany({ where: { id: { in: [holdingId, plainId] } }, select: MEMORY_RECORD_GATE_SELECT });
    const ids = async (c: Context) => (await filterReadableMemoryRecords(c, rows)).map((r) => r.id).sort();
    expect(await ids(as('creator'))).toEqual([holdingId, plainId].sort());
    for (const who of ['member', 'orgadmin', 'orgowner'] as const) expect(await ids(as(who))).toEqual([plainId]);
    expect(await ids(as('platformadmin', ['ADMIN']))).toEqual([plainId]);
    // The point read and the batch agree row by row.
    for (const who of ['creator', 'member', 'orgadmin'] as const) {
      expect(await ids(as(who))).toEqual(
        (await Promise.all([holdingId, plainId].map(async (id) => ((await read(as(who), id)) ? id : null)))).filter(Boolean).sort(),
      );
    }
  });

  it('(g) an ordinary org knowledge record (no per-user holding) stays readable by org members', async () => {
    for (const who of ['member', 'contributor', 'orgadmin', 'orgowner'] as const) expect((await read(as(who), plainId))?.id).toBe(plainId);
    expect((await read(as('platformadmin', ['ADMIN']), plainId))?.id).toBe(plainId);
    expect(await read(as('outsider'), plainId)).toBeNull();
  });
});
