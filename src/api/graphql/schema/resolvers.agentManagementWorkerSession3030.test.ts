/**
 * #3030 (cor:agt:080:35, V19): a worker session never carries its holder's right to manage the Agent. The five doors
 * in this cut (ticker-template create/update/delete, setAgentModelGroup, deleteAgentModelGroup) refuse a write under
 * a bound worker session, even when the person behind it is the org ADMIN who manages the Agent, and write nothing.
 * The same person without a worker session is unchanged (S1). The refusal comes before the revision and existence
 * checks inside the deciding transaction, so it says nothing about the row it was aimed at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));

const M = resolvers.Mutation as any;
const F = resolvers.Agent as any;
const REFUSED = 'AGENT_MANAGEMENT_WORKER_SESSION_REFUSED';

let ctx: Context;
let agentId: string;
let workerId: string;

const asWorker = <T>(fn: () => Promise<T>) => runAsActor({ workerId, agentId: null }, fn);
const codeOf = async (p: Promise<unknown>) =>
  p.then(() => 'NO_ERROR', (e) => e?.extensions?.code ?? e?.code ?? String(e));
const templates = () => db.agentTickerTemplate.findMany({ orderBy: { id: 'asc' } });
const groups = () => db.modelGroup.findMany({ orderBy: { id: 'asc' } });

const createTemplate = (name: string) =>
  M.createAgentTickerTemplate({}, { agentRef: agentId, input: { name, cadenceSeconds: 600 } }, ctx);
const updateTemplate = (id: string, expectedRevision: number) =>
  M.updateAgentTickerTemplate({}, { id, expectedRevision, input: { cadenceSeconds: 1200 } }, ctx);
const deleteTemplate = (id: string, expectedRevision: number) =>
  M.deleteAgentTickerTemplate({}, { id, expectedRevision }, ctx);
const setGroup = (name: string, patterns: string[]) => M.setAgentModelGroup({}, { agentRef: agentId, name, patterns }, ctx);
const deleteGroup = (name: string) => M.deleteAgentModelGroup({}, { agentRef: agentId, name }, ctx);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Ws3030', urn: 'ws3030.example' } });
  const admin = await db.user.create({ data: { id: generateId(), githubId: 303001, githubUsername: 'ws3030-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  ctx = { db, userId: admin.id, roles: ['READER'] };
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Coordinator role' }, ctx)).id;
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Ws team', urn: `${org.urn}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  workerId = (await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Ada', slug: 'ada' },
  })).id;
});
afterEach(() => vi.restoreAllMocks());

describe('#3030 ticker templates under a worker session', () => {
  it('create is refused and writes nothing', async () => {
    expect(await codeOf(asWorker(() => createTemplate('base')))).toBe(REFUSED);
    expect(await templates()).toEqual([]);
  });

  it('update is refused at the right revision and writes nothing', async () => {
    const t = await createTemplate('base');
    const before = await templates();
    expect(await codeOf(asWorker(() => updateTemplate(t.id, 1)))).toBe(REFUSED);
    expect(await templates()).toEqual(before);
  });

  it('delete is refused at the right revision and writes nothing', async () => {
    const t = await createTemplate('base');
    const before = await templates();
    expect(await codeOf(asWorker(() => deleteTemplate(t.id, 1)))).toBe(REFUSED);
    expect(await templates()).toEqual(before);
  });

  it('the refusal comes before the revision check, so a stale revision gets the same answer', async () => {
    const t = await createTemplate('base');
    expect(await codeOf(asWorker(() => updateTemplate(t.id, 7)))).toBe(REFUSED);
    expect(await codeOf(asWorker(() => deleteTemplate(t.id, 7)))).toBe(REFUSED);
  });

  it('the refusal comes before the name-clash check', async () => {
    await createTemplate('base');
    expect(await codeOf(asWorker(() => createTemplate('BASE')))).toBe(REFUSED);
  });

  it('the answer does not depend on the target: a missing, a deleted and a malformed id get the same refusal', async () => {
    const gone = await createTemplate('gone');
    await deleteTemplate(gone.id, 1);
    for (const id of [generateId(), gone.id, 'not-an-id']) {
      expect(await codeOf(asWorker(() => updateTemplate(id, 1)))).toBe(REFUSED);
      expect(await codeOf(asWorker(() => deleteTemplate(id, 1)))).toBe(REFUSED);
    }
    expect(await codeOf(asWorker(() => M.createAgentTickerTemplate({}, { agentRef: generateId(), input: { name: 'x', cadenceSeconds: 600 } }, ctx)))).toBe(REFUSED);
  });

  it('the same manager without a worker session still creates, updates and deletes (S1)', async () => {
    const t = await createTemplate('base');
    expect((await updateTemplate(t.id, 1)).revision).toBe(2);
    expect(await deleteTemplate(t.id, 2)).toBe(true);
  });

  it('viewerMayEditTickerTemplates is false under a worker session and true without one', async () => {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(await asWorker(() => F.viewerMayEditTickerTemplates(agent, {}, ctx))).toBe(false);
    expect(await F.viewerMayEditTickerTemplates(agent, {}, ctx)).toBe(true);
  });
});

describe('#3030 Agent model groups under a worker session', () => {
  it('setAgentModelGroup is refused for a new and an existing name and writes nothing', async () => {
    expect(await codeOf(asWorker(() => setGroup('large', ['claude-opus-*'])))).toBe(REFUSED);
    expect(await groups()).toEqual([]);
    await setGroup('large', ['claude-opus-*']);
    const before = await groups();
    expect(await codeOf(asWorker(() => setGroup('large', ['gpt-5*'])))).toBe(REFUSED);
    expect(await groups()).toEqual(before);
  });

  it('deleteAgentModelGroup is refused and writes nothing; a missing name gets the same answer', async () => {
    await setGroup('large', ['claude-opus-*']);
    const before = await groups();
    expect(await codeOf(asWorker(() => deleteGroup('large')))).toBe(REFUSED);
    expect(await groups()).toEqual(before);
    expect(await codeOf(asWorker(() => deleteGroup('absent')))).toBe(REFUSED);
  });

  it('the answer does not depend on the target Agent: a missing Agent gets the same refusal', async () => {
    const missing = generateId();
    expect(await codeOf(asWorker(() => M.setAgentModelGroup({}, { agentRef: missing, name: 'large', patterns: ['x*'] }, ctx)))).toBe(REFUSED);
    expect(await codeOf(asWorker(() => M.deleteAgentModelGroup({}, { agentRef: missing, name: 'large' }, ctx)))).toBe(REFUSED);
  });

  it('the same manager without a worker session still sets and deletes', async () => {
    expect((await setGroup('large', ['claude-opus-*'])).name).toBe('large');
    expect(await deleteGroup('large')).toBe(true);
    expect(await groups()).toEqual([]);
  });
});
