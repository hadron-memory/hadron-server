/**
 * #3491 (ruling 0176, with 0163/0164; cor:agt:110:03): a task warning's `register` is mapped, unmapped or
 * unresolved only when the caller may read every system memory on the chains looked up; otherwise it is
 * `{ state: 'withheld' }`, never a different answer for "this unreadable memory holds the entry" and "it does not".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { RegisterLookup } from '../../../lib/actionRegister/lookup.js';
import { resolvers, type Context } from './resolvers.js';
import { emitTaskWarnings, resolveRegisters, type TaskWarningCode } from './resolvers.taskWarnings.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const CODE: TaskWarningCode = 'task.finish.open-children';
let org: any, admin: any, member: any, app: any, team: any, role: any, worker: any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const asCaller = <T>(fn: () => Promise<T>) => runAsActor({ workerId: worker.id, agentId: role.id }, fn);
const register = async (c = ctx(member.id)) => (await asCaller(() => resolveRegisters(c, app.id, [CODE]))).get(CODE);
const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
const entry = (memoryId: string) => node(memoryId, `register:${CODE}`, { data: { registerEntry: { code: CODE, taskLoc: 'tasks:finish' } } });
const task = (memoryId: string) => node(memoryId, 'tasks:finish', { isRunnable: true });
/** A system memory the caller cannot read (owned by another user), as an agent that others may extend. */
async function hiddenBase(label: string) {
  const other = await db.user.create({ data: { handle: 'h-' + label + generateId().toLowerCase() } });
  const memory = await db.memory.create({ data: { name: label, urn: `${org.urn}:${label}`, class: 'system', ownerUserId: other.id } });
  return db.agent.create({ data: { name: label, urn: `${org.urn}:${label}-agent`, systemMemoryId: memory.id, ownerUserId: other.id } });
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'gate', urn: `gate-${suffix}.example` } });
  admin = await db.user.create({ data: { handle: 'gate-admin' } });
  member = await db.user.create({ data: { handle: 'gate-member' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const made = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  team = await db.agent.findUniqueOrThrow({ where: { id: made.id } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: team.id } });
  await node(team.systemMemoryId!, 'roles');
  role = team; // the caller's Agent is the Team Agent itself unless a row re-points it
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: role.id, name: 'Anne', slug: 'anne' } });
  await entry(team.systemMemoryId!);
  await task(team.systemMemoryId!);
});

describe('task warnings join the whole-chain gate', () => {
  it('control: a fully readable chain is mapped', async () => {
    expect(await register()).toMatchObject({ state: 'mapped', taskLoc: 'tasks:finish' });
  });
  it.each([['holds the entry', true], ['holds nothing', false]] as const)(
    'an unreadable memory on the Team Agent chain that %s gives withheld (the oracle is closed)', async (_label, holdsEntry) => {
      const base = await hiddenBase('team-base');
      if (holdsEntry) await entry(base.systemMemoryId!);
      await db.agent.update({ where: { id: team.id }, data: { extendsAgentId: base.id } });
      expect(await register()).toEqual({ state: 'withheld' });
    });
  it.each([['holds a nearer task', true], ['holds nothing', false]] as const)(
    'an unreadable memory on the caller Agent chain that %s gives withheld', async (_label, holdsTask) => {
      const callerMade = await M.createAgent({}, { orgId: org.id, name: 'Caller' }, ctx(admin.id));
      const caller = await db.agent.findUniqueOrThrow({ where: { id: callerMade.id } });
      await db.appAgent.create({ data: { appId: app.id, agentId: caller.id } });
      const base = await hiddenBase('caller-base');
      if (holdsTask) await task(base.systemMemoryId!);
      await db.agent.update({ where: { id: caller.id }, data: { extendsAgentId: base.id } });
      await db.worker.update({ where: { id: worker.id }, data: { agentId: caller.id } });
      expect(await runAsActor({ workerId: worker.id, agentId: caller.id }, () => resolveRegisters(ctx(member.id), app.id, [CODE])).then(m => m.get(CODE))).toEqual({ state: 'withheld' });
    });
  it('a distinct caller Agent: an unreadable Team base withholds even when the entry sits in the readable Team memory and the caller chain is readable (§10 P3-1)', async () => {
    // The caller is NOT the Team Agent, so the caller-chain loop cannot answer for the Team chain: only the team-chain gate can.
    const callerMade = await M.createAgent({}, { orgId: org.id, name: 'Caller' }, ctx(admin.id));
    const caller = await db.agent.findUniqueOrThrow({ where: { id: callerMade.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: caller.id } });
    await task(caller.systemMemoryId!);
    await db.worker.update({ where: { id: worker.id }, data: { agentId: caller.id } });
    const run = () => runAsActor({ workerId: worker.id, agentId: caller.id }, () => resolveRegisters(ctx(member.id), app.id, [CODE])).then(m => m.get(CODE));
    expect(await run()).toMatchObject({ state: 'mapped' }); // control: both chains readable
    const base = await hiddenBase('team-base-distinct');
    await db.agent.update({ where: { id: team.id }, data: { extendsAgentId: base.id } });
    expect(await run()).toEqual({ state: 'withheld' });
  });
  it('resolveRegisters: a failed read transaction withholds every code (§10 P3-4)', async () => {
    const spy = vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('boom'));
    try {
      const out = await asCaller(() => resolveRegisters(ctx(member.id), app.id, [CODE, 'task.create.no-source']));
      expect([...out.values()]).toEqual([{ state: 'withheld' }, { state: 'withheld' }]);
    } finally { spy.mockRestore(); }
  });
  it('an outsider who reads none of it gets withheld, not unmapped', async () => {
    const outsider = await db.user.create({ data: { handle: 'gate-out' } });
    expect(await register(ctx(outsider.id))).toEqual({ state: 'withheld' });
  });
  it('readable chains keep every other answer: unmapped (no entry) and unresolved (entry, no task)', async () => {
    await db.node.deleteMany({ where: { memoryId: team.systemMemoryId!, loc: 'tasks:finish' } });
    expect(await register()).toEqual({ state: 'unresolved' });
    await db.node.deleteMany({ where: { memoryId: team.systemMemoryId!, loc: `register:${CODE}` } });
    expect(await register()).toEqual({ state: 'unmapped' });
  });
  it.each(['teamMemory', 'chain', 'entry', 'task'] as const)('a fault in lookup.%s gives withheld, logs only a fixed string', async method => {
    const spy = vi.spyOn(RegisterLookup.prototype, method).mockRejectedValue(new Error('secret-detail'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await register()).toEqual({ state: 'withheld' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-detail');
      expect(JSON.stringify(warn.mock.calls)).toContain('task_warning.register_failed');
    } finally { spy.mockRestore(); warn.mockRestore(); }
  });
  it('a failed read transaction files the warning WITH register withheld and never fails the mutation', async () => {
    const spy = vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('boom'));
    const c = ctx(member.id);
    await asCaller(() => emitTaskWarnings(c, undefined, app.id, { codes: ['task.create.no-source'] }));
    spy.mockRestore();
    expect(c.taskWarnings).toHaveLength(1);
    expect(c.taskWarnings![0].warning.register).toEqual({ state: 'withheld' });
  });
  it('a deadline that passes mid-lookup withholds the codes not reached', async () => {
    const real = Date.now.bind(Date);
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (++calls <= 2 ? real() : real() + 60_000));
    try {
      const out = await asCaller(() => resolveRegisters(ctx(member.id), app.id, ['task.create.no-source', CODE]));
      expect(out.get(CODE)).toEqual({ state: 'withheld' });
    } finally { clock.mockRestore(); }
  });
  it('a budget spent before the first code is routine: withheld, no further read, and no register_failed log (BLIND P2-1)', async () => {
    const real = Date.now.bind(Date);
    let calls = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (++calls <= 2 ? real() : real() + 60_000));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await asCaller(() => resolveRegisters(ctx(member.id), app.id, ['task.create.no-source', CODE]));
      expect(out.get(CODE)).toEqual({ state: 'withheld' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('task_warning.register_failed');
    } finally { clock.mockRestore(); warn.mockRestore(); }
  });
  it('no Agent: no register field and no lookup, as before', async () => {
    const spy = vi.spyOn(db, '$transaction');
    expect((await resolveRegisters(ctx(member.id), app.id, [CODE])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
