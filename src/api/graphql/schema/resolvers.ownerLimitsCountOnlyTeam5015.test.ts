/**
 * #5015 (Billing A7b, cor:acl:150:04): the team surfaces among the count-only doors, driven with the organization AT its
 * `nodes` limit. A team chat post, a worklog record, a session handoff, a compiled boot prompt and a team role node each add
 * a live node to the organization and are never refused; what they add counts. These pass on main and stay as guards
 * against over-refusal: the handoff and the compile go through `writeNodeCore` with `ownerLimit: 'count-only'`, so the
 * mutant that treats `count-only` as `refuse` turns them red (issue #5015 section 5, "option honoured").
 *
 * Not driven here, pinned per call site by `src/lib/ownerLimits/writeDoorsGuard5016.test.ts` instead: an agent chat
 * message (a raw insert with no gate call; driving it needs a conversation and stage fixture), a run's output node
 * (`makeProdRunDeps.writeOutput`, its `count-only` literal pinned), and an account merge (re-owns rows without an insert;
 * its marker pinned).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';
import { OWNER_LIMIT_KEYS } from '../../../lib/ownerLimits/keys.js';
import { resolvers, type Context } from './resolvers.js';
import { writeSessionHandoff } from './resolvers.mutation.session.js';
import { compileBootPrompt } from './compileBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
let orgId: string, orgAdmin: string, member: string, agentId: string, appId: string, workerId: string, sessionId: string;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'], clientId: `user:${userId}` }) as Context;
const owner = () => ({ organizationId: orgId });
const count = async () => Number(await OWNER_LIMIT_KEYS.nodes.count(db, owner()));
/** Put the organization exactly at its `nodes` limit and return the count it is capped at. */
const capAtCurrent = async () => {
  const at = await count();
  await db.ownerLimit.create({
    data: { id: generateId(), organizationId: orgId, key: 'nodes', limitValue: at, sourceType: 'manual', sourceId: 't', note: 't' },
  });
  return at;
};

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  const n = Math.floor(Math.random() * 1_000_000);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'cot5015', urn: `cot5015-${n}.example` } })).id;
  const user = async (tag: string, i: number) =>
    (await db.user.create({ data: { id: generateId(), githubId: 501_500_000 + i * 1_000_000 + n, githubUsername: `cot5015-${tag}-${n}`, roles: ['READER'] } })).id;
  orgAdmin = await user('admin', 1);
  member = await user('member', 2);
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: orgAdmin, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: orgId, name: 'Team Agent' }, ctx(orgAdmin));
  agentId = agent.id;
  // The worklog's first write bootstraps through the App's Team Agent, inferred from a roles: branch (#947); the compile
  // reads its boot-prompt source.
  await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId, loc: 'roles:server-engineer', name: 'server-engineer', content: 'You are {{worker.name}}.' } });
  await db.node.create({ data: { id: generateId(), memoryId: agent.systemMemoryId, loc: 'boot:source', name: 'source', content: 'You are {{worker.name}}.', role: 'boot-prompt' } });
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'Team', urn: `cot5015-${n}.example:team` } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await db.appMember.create({ data: { appId, userId: member, role: 'member' } });
  workerId = (await db.worker.create({
    data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Anne', slug: 'anne', heldByUserId: member }, select: { id: true },
  })).id;
  sessionId = (await db.session.create({ data: { id: generateId(), appId, workerId, agentId, userId: member }, select: { id: true } })).id;
});
afterEach(() => { vi.restoreAllMocks(); reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5015 team count-only doors succeed at the organization\'s nodes limit, and what they add counts', () => {
  it('a team chat post (its first post also creates the chat\'s roots)', async () => {
    const at = await capAtCurrent();
    await M.createTeamChatMessage({}, { appRef: appId, body: 'hello team' }, ctx(member));
    expect(await count()).toBeGreaterThan(at);
  });

  it('a worklog record', async () => {
    const at = await capAtCurrent();
    await M.recordTeamWork({}, { appRef: appId, sessionRef: sessionId, tool: 'github', kind: 'pr', ref: 'o/r#371', action: 'opened' }, ctx(member));
    expect(await count()).toBeGreaterThan(at);
  });

  it('a session handoff (the handoffs parent and the record)', async () => {
    // Provision the working memory first, so the cap is taken over everything the handoff itself does not add.
    await writeSessionHandoff(ctx(member), sessionId, workerId, 'first');
    await db.session.update({ where: { id: sessionId }, data: { endedAt: new Date() } });
    const next = (await db.session.create({ data: { id: generateId(), appId, workerId, agentId, userId: member }, select: { id: true } })).id;
    const at = await capAtCurrent();
    await writeSessionHandoff(ctx(member), next, workerId, 'Handing off: at the cap.');
    expect(await count()).toBe(at + 1);
  });

  it('a compiled boot prompt', async () => {
    const at = await capAtCurrent();
    const r = await compileBootPrompt(ctx(orgAdmin), { kind: 'AGENT', agentId });
    expect(r.revNo).toBe(1);
    expect(await count()).toBe(at + 1);
  });

  it('a team role node', async () => {
    const at = await capAtCurrent();
    await M.createTeamRole({}, { appRef: appId, role: 'oncall', description: 'paged first' }, ctx(orgAdmin));
    expect(await count()).toBeGreaterThan(at);
  });
});
