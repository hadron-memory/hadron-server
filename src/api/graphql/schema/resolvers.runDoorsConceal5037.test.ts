/**
 * #5037 — the five run doors (cancelAppRun, updateAgentSchedule, deleteAgentSchedule, rotateAgentWebhook,
 * deleteAgentWebhook) answer NOT_FOUND, byte-identical to an id that names nothing, for a caller with no standing over
 * the entity; a caller who can read it (an org READER) keeps FORBIDDEN, and nothing is written for either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { testRunAgentId } from '../../../test/runAgent.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const ENTRY = 'hrn:node:5037.test:flow:entry';
let orgA: { id: string }; let appA: { id: string };
let adminB: { id: string }; let plain: { id: string }; let readerA: { id: string }; let adminA: { id: string };
let runId: string; let scheduleId: string; let webhookId: string;

const ctxOf = (u: { id: string }): Context => ({ db, userId: u.id, roles: ['READER'] }) as unknown as Context;
const answer = (p: Promise<unknown>) => p.then(
  (v) => ({ admitted: JSON.stringify(v ?? null) }),
  (e: any) => ({ code: e?.extensions?.code ?? null, message: String(e?.message) }),
);
const missing = () => generateId();

const DOORS: Array<{ name: string; call: (id: string, c: Context) => Promise<unknown>; id: () => string; notFound: string }> = [
  { name: 'cancelAppRun', call: (id, c) => M.cancelAppRun({}, { ref: id }, c), id: () => runId, notFound: 'Run not found.' },
  { name: 'updateAgentSchedule', call: (id, c) => M.updateAgentSchedule({}, { id, input: { enabled: false } }, c), id: () => scheduleId, notFound: 'Schedule not found.' },
  { name: 'deleteAgentSchedule', call: (id, c) => M.deleteAgentSchedule({}, { id }, c), id: () => scheduleId, notFound: 'Schedule not found.' },
  { name: 'rotateAgentWebhook', call: (id, c) => M.rotateAgentWebhook({}, { id }, c), id: () => webhookId, notFound: 'Webhook not found.' },
  { name: 'deleteAgentWebhook', call: (id, c) => M.deleteAgentWebhook({}, { id }, c), id: () => webhookId, notFound: 'Webhook not found.' },
];

beforeEach(async () => {
  await cleanDb(db);
  const mk = (h: string) => db.user.create({ data: { id: generateId(), handle: h, name: h, roles: ['READER'] as never } });
  [adminA, readerA, adminB, plain] = await Promise.all([mk('adm-a-5037'), mk('rdr-a-5037'), mk('adm-b-5037'), mk('plain-5037')]);
  orgA = await db.organization.create({ data: { id: generateId(), name: 'Org A', urn: 'a5037.test' } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'Org B', urn: 'b5037.test' } });
  await db.orgMember.createMany({ data: [
    { organizationId: orgA.id, userId: adminA.id, role: 'ADMIN' },
    { organizationId: orgA.id, userId: readerA.id, role: 'READER' },
    { organizationId: orgB.id, userId: adminB.id, role: 'ADMIN' },
  ] });
  appA = await db.app.create({ data: { organizationId: orgA.id, name: 'App A', urn: 'a5037.test:app' } });
  await db.appMember.create({ data: { appId: appA.id, userId: adminA.id, role: 'owner' } });
  const agent = await db.agent.create({ data: { organizationId: orgA.id, name: 'Agent A', urn: 'a5037.test:agent', type: 'CHATBOT' } });
  await db.appAgent.create({ data: { appId: appA.id, agentId: agent.id } });
  runId = (await db.appRun.create({ data: { id: generateId(), organizationId: orgA.id, appId: appA.id, agentId: await testRunAgentId(db, orgA.id, appA.id), triggerKind: 'MANUAL', entryNodeUrn: 'x:y:z', status: 'RUNNING' } })).id;
  scheduleId = (await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgA.id, appId: appA.id, userId: adminA.id, name: 's', cron: '0 9 * * *', timezone: 'UTC', entryNodeUrn: ENTRY, nextRunAt: new Date(Date.now() + 3600000) } })).id;
  webhookId = (await db.agentWebhook.create({ data: { id: generateId(), organizationId: orgA.id, appId: appA.id, userId: adminA.id, name: 'h', secret: 'original-secret', entryNodeUrn: ENTRY } })).id;
});

const untouched = async () => {
  expect((await db.appRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('RUNNING');
  expect(await db.agentSchedule.findUniqueOrThrow({ where: { id: scheduleId } })).toMatchObject({ deletedAt: null, enabled: true });
  expect(await db.agentWebhook.findUniqueOrThrow({ where: { id: webhookId } })).toMatchObject({ deletedAt: null, secret: 'original-secret' });
};

describe.each(DOORS)('#5037 $name', ({ call, id, notFound }) => {
  it('a foreign ADMIN and a caller in no org get exactly the answer for an id that names nothing, and nothing is written', async () => {
    const nothing = await answer(call(missing(), ctxOf(adminB)));
    expect(nothing).toEqual({ code: 'NOT_FOUND', message: notFound });
    expect(await answer(call(id(), ctxOf(adminB)))).toEqual(nothing);
    expect(await answer(call(id(), ctxOf(plain)))).toEqual(nothing);
    await untouched();
  });

  it('an org READER (who can read the entity) keeps FORBIDDEN, and nothing is written', async () => {
    expect(await answer(call(id(), ctxOf(readerA)))).toMatchObject({ code: 'FORBIDDEN' });
    await untouched();
  });

  it('an App key of ANOTHER App is answered as for a missing id; an App key of this App keeps the door\'s own refusal', async () => {
    const other = await db.app.create({ data: { organizationId: (await db.organization.findFirstOrThrow({ where: { urn: 'b5037.test' } })).id, name: 'App B', urn: 'b5037.test:app' } });
    const nothing = await answer(call(missing(), { db, appId: other.id, roles: [] } as unknown as Context));
    expect(await answer(call(id(), { db, appId: other.id, roles: [] } as unknown as Context))).toEqual(nothing);
    expect(await answer(call(id(), { db, appId: appA.id, roles: [] } as unknown as Context))).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('control: the org ADMIN is admitted', async () => {
    const got = await answer(call(id(), ctxOf(adminA)));
    expect(got).toHaveProperty('admitted');
  });

  it('a fault in the readability check propagates (never reads as not-found)', async () => {
    const faulty = { ...ctxOf(plain), db: db.$extends({ query: { orgMember: { findFirst() { throw new Error('fixture-fault-5037'); } } } }) } as unknown as Context;
    const got = await answer(call(id(), faulty));
    expect(got).not.toMatchObject({ code: 'NOT_FOUND' });
  });
});
