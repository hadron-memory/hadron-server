/**
 * #3470 (rulings 0163, 0164; cor:agt:110:03): every action answer gives the same state
 * for the same caller and register, whichever producer made it. One table, two producers
 * (the PR review commands and App actions) over one fixture. Tick wakes already match and
 * are pinned by tickRegister2733.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { RegisterLookup } from '../../../lib/actionRegister/lookup.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as Record<string, (...args: any[]) => Promise<any>>;
const H = 'c'.repeat(40), APP_CODE = 'app.team.frozen';
let author: any, other: any, app: any, build: any, teamAgent: any, roleAgent: any, roleMemory: any, worker: any;
const ctx = (userId = author.id) => ({ db, userId, roles: ['READER' as const] });
const bound = <T>(fn: () => Promise<T>) => runAsActor({ workerId: worker.id, agentId: roleAgent.id }, fn);
const mapped = () => ({ state: 'MAPPED', taskLoc: 'tasks:review', taskUrn: `hrn:node:${roleMemory.urn}:tasks:review` });

/** Both producers' answers, normalised to the public shape (absent fields dropped). */
async function answers(): Promise<{ pr: any; app: any }> {
  const pr = (await bound(() => M.freezePullRequestHead!({}, { taskRef: build.id, head: H }, ctx()))).action;
  const rec = (await bound(() => M.recordAppAction!({}, { appRef: app.id, code: APP_CODE }, ctx()))).action;
  const norm = (a: any) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== null && v !== undefined));
  return { pr: norm(pr), app: norm(rec) };
}
async function hiddenBase(label: string) {
  const memory = await db.memory.create({ data: { name: label, urn: `${app.urn}:${label}`, class: 'system', ownerUserId: other.id } });
  return db.agent.create({ data: { name: label, urn: `${app.urn}:${label}-agent`, systemMemoryId: memory.id, ownerUserId: other.id } });
}
const CODES = ['pr.frozen', APP_CODE];
const entry = async (memoryId: string) => { for (const code of CODES) await db.node.create({ data: { id: generateId(), memoryId, loc: `register:${code}`, name: 'Entry', data: { registerEntry: { code, taskLoc: 'tasks:review' } } } }); };
const dropEntry = (memoryId: string) => db.node.deleteMany({ where: { memoryId, loc: { in: CODES.map(c => `register:${c}`) } } });
/** The App producer answers for its own code; compare everything else. */
const asPr = (a: any) => ({ ...a, code: 'pr.frozen' });

beforeEach(async () => {
  await cleanDb(db);
  [author, other] = await Promise.all(['author', 'other'].map(handle => db.user.create({ data: { handle } })));
  const org = await db.organization.create({ data: { name: 'Align', urn: `align-${generateId()}.test` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: author.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Align', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: author.id, role: 'member' } });
  build = await M.createAgentTask!({}, { input: { appRef: app.id, title: 'Build', source: 'synthetic', assignee: { user: author.id }, references: [{ kind: 'PULL_REQUEST', target: 'https://github.com/example/project/pull/1' }] } }, ctx());
  const teamMemory = await db.memory.create({ data: { name: 'Team system', urn: `${app.urn}:team-system`, class: 'system', ownerUserId: author.id } });
  teamAgent = await db.agent.create({ data: { name: 'Team', urn: `${app.urn}:team-agent`, systemMemoryId: teamMemory.id, ownerUserId: author.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.node.create({ data: { id: generateId(), memoryId: teamMemory.id, loc: 'roles:author', name: 'Role' } });
  await db.node.create({ data: { id: generateId(), memoryId: teamMemory.id, loc: 'tasks:review', name: 'Team task', isRunnable: true } });
  await entry(teamMemory.id);
  roleMemory = await db.memory.create({ data: { name: 'Caller system', urn: `${app.urn}:caller-system`, class: 'system', ownerUserId: author.id } });
  roleAgent = await db.agent.create({ data: { name: 'Caller', urn: `${app.urn}:caller-agent`, systemMemoryId: roleMemory.id, ownerUserId: author.id } });
  await db.node.create({ data: { id: generateId(), memoryId: roleMemory.id, loc: 'tasks:review', name: 'Caller task', isRunnable: true } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: roleAgent.id, name: 'Author', slug: 'author', heldByUserId: author.id } });
  await M.reassignAgentTask!({}, { taskId: build.id, assignee: { worker: worker.id } }, ctx());
});

describe('one disclosure threshold and fault state for every action answer', () => {
  it('a fully readable chain is MAPPED in both producers', async () => {
    const r = await answers();
    expect(r.pr).toEqual({ code: 'pr.frozen', ...mapped() });
    expect(asPr(r.app)).toEqual(r.pr);
  });
  it.each(['team', 'role'])('an unreadable %s ancestor is WITHHELD even with a readable nearer entry and task', async side => {
    const base = await hiddenBase('hidden-base');
    await db.agent.update({ where: { id: side === 'team' ? teamAgent.id : roleAgent.id }, data: { extendsAgentId: base.id } });
    const r = await answers();
    expect(r.pr).toEqual({ code: 'pr.frozen', state: 'WITHHELD' });
    expect(asPr(r.app)).toEqual(r.pr);
  });
  it('an entry present only in an unreadable memory is WITHHELD, not UNMAPPED', async () => {
    await dropEntry(teamAgent.systemMemoryId);
    const base = await hiddenBase('hidden-entry');
    await entry(base.systemMemoryId!);
    await db.agent.update({ where: { id: teamAgent.id }, data: { extendsAgentId: base.id } });
    const r = await answers();
    expect(r.pr).toEqual({ code: 'pr.frozen', state: 'WITHHELD' });
    expect(asPr(r.app)).toEqual(r.pr);
  });
  it('an unreadable role ancestor holding the only task is WITHHELD, not UNRESOLVED', async () => {
    await db.node.deleteMany({ where: { memoryId: roleMemory.id, loc: 'tasks:review' } });
    const base = await hiddenBase('hidden-task');
    await db.node.create({ data: { id: generateId(), memoryId: base.systemMemoryId!, loc: 'tasks:review', name: 'Task', isRunnable: true } });
    await db.agent.update({ where: { id: roleAgent.id }, data: { extendsAgentId: base.id } });
    const r = await answers();
    expect(r.pr).toEqual({ code: 'pr.frozen', state: 'WITHHELD' });
    expect(asPr(r.app)).toEqual(r.pr);
  });
  it('a readable chain with no task still carries the loc as UNRESOLVED', async () => {
    await db.node.deleteMany({ where: { memoryId: roleMemory.id, loc: 'tasks:review' } });
    await db.node.deleteMany({ where: { memoryId: teamAgent.systemMemoryId, loc: 'tasks:review' } });
    const r = await answers();
    expect(r.pr).toEqual({ code: 'pr.frozen', state: 'UNRESOLVED', taskLoc: 'tasks:review' });
    expect(asPr(r.app)).toEqual(r.pr);
  });
  it('an injected lookup fault is WITHHELD with the code alone, and the command still commits', async () => {
    const spy = vi.spyOn(RegisterLookup.prototype, 'entry').mockRejectedValue(new Error('injected'));
    try {
      const before = await db.agentTeamEvent.count({ where: { appId: app.id } });
      const r = await answers();
      expect(r.pr).toEqual({ code: 'pr.frozen', state: 'WITHHELD' });
      expect(asPr(r.app)).toEqual(r.pr);
      expect(await db.agentTeamEvent.count({ where: { appId: app.id } })).toBeGreaterThan(before);
    } finally { spy.mockRestore(); }
  });
});
