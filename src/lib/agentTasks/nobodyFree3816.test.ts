/** #3816 (V21-V23): a match that finds nobody answers with each skipped candidate and EVERY reason, never stored. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any, Q = resolvers.Query as any;
let app: any, owner: any, agent: any, ctx: any;
beforeEach(async () => {
  await cleanDb(db);
  process.env.DISABLE_TASK_MATCHER = 'true';
  const n = generateId();
  owner = await db.user.create({ data: { handle: `nf-${n}` } });
  const org = await db.organization.create({ data: { name: 'Nobody free', urn: `nf-${n}.example` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  ctx = { db, userId: owner.id, roles: ['READER'] };
  agent = await M.createAgent({}, { orgId: org.id, name: 'Team' }, ctx);
  app = await db.app.create({ data: { organizationId: org.id, name: 'Match', urn: `${org.urn}:app` } });
});
afterEach(() => { delete process.env.DISABLE_TASK_MATCHER; });
async function worker(name: string, role = 'reviewer', opts: { family?: string; model?: string; session?: boolean } = {}) {
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role } });
  if (opts.session !== false) {
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId: agent.id, role, family: opts.family ?? 'claude',
      llmModel: opts.model ?? 'claude-sonnet-5-5', startedAt: new Date(), updatedAt: new Date() } });
  }
  return w;
}
const create = (input: any = {}) => M.createAgentTask({}, { input: { appRef: app.id, title: 'Match', match: true, requirements: { role: 'reviewer' }, ...input } }, ctx);
const hold = async (workerId: string) => {
  const t = await M.createAgentTask({}, { input: { appRef: app.id, title: 'busy' } }, ctx);
  await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: workerId } }, ctx);
};
const unavailable = (workerId: string, reason = 'out-of-tokens') => db.workerAvailability.create({
  data: { workerId, state: 'unavailable', reason, until: reason === 'stalled' ? null : new Date(Date.now() + 3600_000), setAt: new Date(), setBy: reason === 'stalled' ? 'stall-rule' : 'holder', setByUserId: reason === 'stalled' ? null : owner.id } });
const byName = (t: any) => Object.fromEntries((t.matchSkipped ?? []).map((c: any) => [c.name, c.reasons]));

it('lists each skipped candidate with its ruled reason, and leaves a non-candidate role out', async () => {
  const unav = await worker('Unav'); await worker('Holder'); await worker('Gone'); await worker('Other', 'engineer');
  await unavailable(unav.id);
  await hold((await db.worker.findFirstOrThrow({ where: { name: 'Holder' } })).id);
  await db.worker.updateMany({ where: { appId: app.id, name: 'Gone' }, data: { retiredAt: new Date() } });
  const t = await create();
  expect(t.matchFailedReason).toBe('NOBODY_FREE');
  expect(byName(t)).toEqual({ Unav: ['UNAVAILABLE'], Holder: ['HOLDS_TASK'], Gone: ['RETIRED'] });
});
it('a worker excluded for two reasons carries both, in the enum order (V23)', async () => {
  const w = await worker('Both');
  await hold(w.id);
  await unavailable(w.id);
  expect(byName(await create())).toEqual({ Both: ['HOLDS_TASK', 'UNAVAILABLE'] });
});
it('own and family unavailability are both listed, in the enum order (V23)', async () => {
  const w = await worker('Both2', 'reviewer', { family: 'codex', model: 'gpt-6.1-sol' });
  await unavailable(w.id);
  await db.modelFamilyAvailability.create({ data: { appId: app.id, family: 'codex', state: 'unavailable', reason: 'out-of-tokens', until: new Date(Date.now() + 3600_000), setAt: new Date(), setByUserId: owner.id } });
  expect(byName(await create()).Both2).toEqual(['UNAVAILABLE', 'FAMILY_UNAVAILABLE']);
});
it('a stall mark reads STALLED, not UNAVAILABLE', async () => {
  const w = await worker('Stalled');
  await unavailable(w.id, 'stalled');
  expect(byName(await create())).toEqual({ Stalled: ['STALLED'] });
});
it('requirement exclusions: family, name and tier each get their own value', async () => {
  const fam = await worker('Fam', 'reviewer', { family: 'codex', model: 'gpt-6.1-sol' });
  const named = await worker('Named');
  const low = await worker('Low', 'reviewer', { model: 'claude-haiku-5-5' });
  const t = await create({ requirements: { role: 'reviewer', familyNotIn: ['codex'], excludeWorkers: [named.id], minTier: 'high' } });
  expect(t.matchFailedReason).toBe('REQUIREMENTS_EXCLUDED');
  const r = byName(t);
  expect(r.Fam).toContain('FAMILY_EXCLUDED'); expect(r.Named).toContain('NAME_EXCLUDED'); expect(r.Low).toContain('TIER_BELOW_MINIMUM');
  expect(fam.id && low.id).toBeTruthy();
});
it('returned, not stored: the mark keeps its coarse reason and a later read carries no list (V22)', async () => {
  const w = await worker('Holder'); await hold(w.id);
  const t = await create();
  expect(t.matchSkipped).toHaveLength(1);
  const fresh = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
  expect(fresh.matchFailedReason).toBe('NOBODY_FREE');
  expect(Object.keys(fresh).join()).not.toMatch(/skip/i);
  expect((resolvers as any).AgentTask.matchSkipped(fresh)).toBeNull();
});
it('a successful match and a plain create carry no list; a non-participant gets the roster refusal', async () => {
  await worker('Free');
  expect((await create()).matchSkipped ?? null).toBeNull();
  const outsider = await db.user.create({ data: { handle: `out-${generateId()}` } });
  await expect(M.createAgentTask({}, { input: { appRef: app.id, title: 'x', match: true } }, { db, userId: outsider.id, roles: ['READER'] }))
    .rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
});
it('GraphQL: a failed match-now create answers matchSkipped on the AgentTask; a plain create and a later read carry none (V22)', async () => {
  const w = await worker('Holder'); await hold(w.id);
  const plain = await create({ match: false });
  expect(plain.matchFailedReason ?? null).toBeNull();
  expect(plain.matchSkipped ?? null).toBeNull();
  expect((resolvers as any).AgentTask.matchSkipped(plain)).toBeNull();
  const failed = await create();
  expect(failed.matchSkipped).toEqual([{ workerId: w.id, name: 'Holder', reasons: ['HOLDS_TASK'] }]);
  const sdl = (await import('../../api/graphql/schema/typeDefs.js')) as any;
  expect(JSON.stringify(sdl)).toContain('matchSkipped: [AgentTaskSkippedCandidate!]');
});
it('a concurrent claim change that wins the guarded failure write leaves no matchSkipped on the answer', async () => {
  const w = await worker('Holder'); await hold(w.id);
  const real = db.agentTask.updateMany.bind(db.agentTask);
  const spy = vi.spyOn(db.agentTask, 'updateMany').mockImplementation((async (args: any) => {
    if (args?.data?.matchFailedReason) {
      spy.mockRestore();
      await db.agentTask.updateMany({ where: { id: args.where.id }, data: { matchClaimedAt: new Date() } });
    }
    return real(args);
  }) as any);
  const t = await create();
  spy.mockRestore();
  expect(t.matchSkipped ?? null).toBeNull();
  const fresh = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
  expect(fresh.matchFailedReason).toBeNull();
  expect(fresh.matchPending).toBe(true);
});
it('a retired worker of the role carries RETIRED and every other reason that applies to it (V23)', async () => {
  const named = await worker('RetiredNamed');
  await db.worker.update({ where: { id: named.id }, data: { retiredAt: new Date() } });
  const r = byName(await create({ requirements: { role: 'reviewer', excludeWorkers: [named.id] } }));
  expect(r.RetiredNamed).toEqual(['RETIRED', 'NAME_EXCLUDED']);
});
it('a retired worker of another role is not a candidate; a retired one of the role is (RETIRED)', async () => {
  const other = await worker('RetiredEng', 'engineer'); const mine = await worker('RetiredRev');
  await db.worker.updateMany({ where: { id: { in: [other.id, mine.id] } }, data: { retiredAt: new Date() } });
  expect(byName(await create())).toEqual({ RetiredRev: ['RETIRED'] });
});
it('an agent that uses no tasks reads USES_NO_TASKS', async () => {
  await worker('NoTasks'); await db.agent.update({ where: { id: agent.id }, data: { usesTasks: false } });
  expect(byName(await create()).NoTasks).toContain('USES_NO_TASKS');
});
it('NO_FAMILY for an unbound worker no host can launch; a bound worker gone quiet is matched, not skipped (V21, #3815)', async () => {
  await worker('Unbound', 'reviewer', { session: false });
  const quiet = await worker('Quiet');
  const old = new Date(Date.now() - 3 * 86_400_000);
  await db.session.updateMany({ where: { workerId: quiet.id }, data: { startedAt: old, updatedAt: old } });
  const t = await create();
  // #3815: the quiet bound worker is the one candidate, so the task is assigned and there is no NOBODY_FREE.
  expect(t.matchFailedReason ?? null).toBeNull();
  expect(t.assigneeWorkerId).toBe(quiet.id);
  const none = await create();
  const r = byName(none);
  expect(none.matchFailedReason).toBe('NOBODY_FREE');
  expect(r.Unbound).toEqual(['NO_FAMILY']);
  expect(r.Quiet).toEqual(['HOLDS_TASK']);
});
it('a worker under a stop signal reads STOP_SIGNAL', async () => {
  const w = await worker('Paused');
  await db.teamStopSignal.create({ data: { id: generateId(), appId: app.id, level: 'pause', scope: 'worker', targetWorkerId: w.id, setAt: new Date(), setByUserId: owner.id } });
  const t = await create();
  expect(t.matchFailedReason).toBe('STOP_SIGNAL');
  expect(byName(t)).toEqual({ Paused: ['STOP_SIGNAL'] });
});
