/**
 * #1892 — an Agent's task list and process list (cor:dmo:050:15, :16), on
 * GraphQL (agentTaskList / agentProcessList / setAgentIndexRefs) and MCP
 * (hadron_agent_tasks / hadron_agent_processes).
 *
 * Fixture: `backend-engineer` extends `engineer`. The reader is a participant
 * of an App that installs only `backend-engineer`, so they read its system
 * memory and hold no access to `engineer`'s: every engineer task they see came
 * through the child (cor:dmo:050:14 ruling 4). A `team` org memory holds the
 * processes, as the real team's `hadron-dev-team-system` does, and its stage
 * edges cross into the agents' system memories.
 *
 *   engineer:  tasks (index) ← open-pr "when a PR is ready"
 *                            ← review  "when asked to review"
 *              tasks:open-pr, tasks:review (runnable), prompts:boot (boot
 *              prompt, runnable: never inherited), processes:base-release
 *              (a base process, staging tasks:open-pr: #1893's, skipped)
 *   backend:   tasks (index)  ← deploy "when deploying"
 *                             ← review "when reviewing backend code"
 *              tasks:deploy, tasks:review, tasks:hotfix (runnable; hotfix
 *              is on no index), processes (index) ← processes:release
 *              "when I cut a release"
 *   team:      processes:drive (stages engineer's tasks:review, which backend
 *              overrides) and processes:ship-it (stages engineer's
 *              inherited tasks:open-pr); notes:staged-note (not a process)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const N = (resolvers as any).Node;

let n: number;
let org: { id: string; urn: string };
let reader: string;
let manager: string;
let stranger: string;
let engineer: { id: string; urn: string; mem: string; memUrn: string };
let backend: { id: string; urn: string; mem: string; memUrn: string };
let team: { id: string; urn: string };
let privateMem: { id: string; urn: string };
const ids: Record<string, string> = {};

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const mcp = (userId: string, tool: string, params: Record<string, unknown>) =>
  createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` }).callToolText(tool, params);

async function agent(slug: string, base?: { id: string }) {
  const memUrn = `${org.urn}:${slug}-system`;
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${slug} system`, urn: memUrn } });
  const a = await db.agent.create({
    data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: base?.id ?? null },
  });
  return { id: a.id, urn: a.urn, mem: mem.id, memUrn };
}

async function node(key: string, memoryId: string, loc: string, data: { role?: string; isRunnable?: boolean } = {}) {
  ids[key] = (await db.node.create({ data: { memoryId, loc, name: key, content: key, role: data.role ?? null, isRunnable: data.isRunnable ?? null } })).id;
  return ids[key];
}

let edgeN = 0;
async function edge(source: string, target: string, name: string) {
  const src = await db.node.findUniqueOrThrow({ where: { id: ids[source] } });
  await db.edge.create({ data: { memoryId: src.memoryId, sourceId: ids[source], targetId: ids[target], name, loc: `e${++edgeN}` } });
}

const nodeUrn = (memUrn: string, loc: string) => `hrn:node:${memUrn}:${loc}`;
const agentUrn = (a: { urn: string }) => `hrn:agent:${a.urn}`;

const tasks = async (userId = reader) =>
  (await Q.agentTaskList({}, { ref: backend.id }, ctx(userId))) as Array<{ node: any; trigger: string | null }>;
const processes = async (userId = reader) =>
  (await Q.agentProcessList({}, { ref: backend.id }, ctx(userId))) as Array<{ node: any; kind: string; trigger: string | null }>;
const taskView = async (userId = reader) =>
  (await tasks(userId)).map((t) => [t.node.id, t.trigger, N.inheritedFrom(t.node)?.agentUrn ?? null]);

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Lists', urn: `lists1892-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `l-reader-${n}`, roles: ['READER'] } })).id;
  manager = (await db.user.create({ data: { handle: `l-manager-${n}`, roles: ['READER'] } })).id;
  stranger = (await db.user.create({ data: { handle: `l-stranger-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager, role: 'ADMIN' } });
  engineer = await agent('engineer');
  backend = await agent('backend-engineer', engineer);
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: backend.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader, role: 'member' } });
  team = await db.memory.create({ data: { class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id, name: 'team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  privateMem = await db.memory.create({ data: { class: 'personal', userId: manager, ownerUserId: manager, name: 'mine', urn: `${org.urn}:mine-${n}` }, select: { id: true, urn: true } });

  // engineer
  await node('engIndex', engineer.mem, 'tasks');
  await node('engOpenPr', engineer.mem, 'tasks:open-pr', { isRunnable: true });
  await node('engReview', engineer.mem, 'tasks:review', { isRunnable: true });
  await node('engBoot', engineer.mem, 'prompts:boot', { role: 'boot-prompt', isRunnable: true });
  await node('engBaseRelease', engineer.mem, 'processes:base-release', { role: 'process' });
  await edge('engOpenPr', 'engIndex', 'when a PR is ready');
  await edge('engReview', 'engIndex', 'when asked to review');
  await edge('engBaseRelease', 'engOpenPr', 'stage 1: open the PR');
  await db.agent.update({ where: { id: engineer.id }, data: { tasksIndexRef: ids.engIndex } });

  // backend
  await node('backIndex', backend.mem, 'tasks');
  await node('backDeploy', backend.mem, 'tasks:deploy', { isRunnable: true });
  await node('backReview', backend.mem, 'tasks:review', { isRunnable: true });
  await node('backHotfix', backend.mem, 'tasks:hotfix', { isRunnable: true });
  await node('backProcIndex', backend.mem, 'processes');
  await node('backRelease', backend.mem, 'processes:release', { role: 'process' });
  await edge('backDeploy', 'backIndex', 'when deploying');
  await edge('backReview', 'backIndex', 'when reviewing backend code');
  await edge('backRelease', 'backProcIndex', 'when I cut a release');
  await edge('backRelease', 'backDeploy', 'stage 2: deploy');
  await db.agent.update({ where: { id: backend.id }, data: { tasksIndexRef: ids.backIndex, processesIndexRef: ids.backProcIndex } });

  // team
  await node('drive', team.id, 'processes:drive', { role: 'process' });
  await node('shipIt', team.id, 'processes:ship-it', { role: 'process.release' });
  await node('stagedNote', team.id, 'notes:staged-note');
  await edge('drive', 'engReview', 'stage 4a: blind review');
  await edge('shipIt', 'engOpenPr', 'Stage 1: open it');
  await edge('stagedNote', 'backDeploy', 'stage 9: not a process');
});

describe('the reader\'s footing', () => {
  it('reads backend-engineer\'s system memory and the team memory, and not engineer\'s or the private memory', async () => {
    expect((await Q.memory({}, { ref: backend.mem }, ctx(reader)))?.id).toBe(backend.mem);
    expect((await Q.memory({}, { ref: team.id }, ctx(reader)))?.id).toBe(team.id);
    expect(await Q.memory({}, { ref: engineer.mem }, ctx(reader))).toBeNull();
    expect(await Q.memory({}, { ref: privateMem.id }, ctx(reader))).toBeNull();
  });
});

describe('050:15 — an Agent\'s tasks', () => {
  it('S1/S2/S5: the child\'s tasks and engineer\'s inherited one, each once, with the nearest trigger', async () => {
    expect(await taskView()).toEqual([
      [ids.backDeploy, 'when deploying', null],
      [ids.backHotfix, null, null],
      [ids.engOpenPr, 'when a PR is ready', agentUrn(engineer)],
      [ids.backReview, 'when reviewing backend code', null],
    ]);
  });

  it('never lists a base\'s boot prompt, though it is runnable', async () => {
    expect((await tasks()).map((t) => t.node.id)).not.toContain(ids.engBoot);
  });

  it('S2: a task both indexes list is the child\'s node, with the child index\'s trigger (Q1)', async () => {
    const review = (await tasks()).filter((t) => t.node.loc === 'tasks:review');
    expect(review).toHaveLength(1);
    expect(review[0]!.node.id).toBe(ids.backReview);
    expect(review[0]!.trigger).toBe('when reviewing backend code');
  });

  it('S4: a child\'s own node at a loc engineer\'s index lists replaces it, listed once under the listing edge', async () => {
    const own = await node('backOpenPr', backend.mem, 'tasks:open-pr', { isRunnable: true });
    const openPr = (await tasks()).filter((t) => t.node.loc === 'tasks:open-pr');
    expect(openPr.map((t) => [t.node.id, t.trigger, N.inheritedFrom(t.node)])).toEqual([[own, 'when a PR is ready', null]]);
  });

  it('S5 with no edges at all: a task no index lists is still listed, with no trigger', async () => {
    await db.edge.deleteMany({ where: { targetId: { in: [ids.backIndex, ids.engIndex] } } });
    expect((await taskView()).map(([, trigger]) => trigger)).toEqual([null, null, null, null]);
  });

  it('an inherited task keeps the base\'s URN and shows none of the base\'s edges', async () => {
    const openPr = (await tasks()).find((t) => t.node.id === ids.engOpenPr)!;
    expect(await N.urn(openPr.node, {}, ctx(reader))).toBe(nodeUrn(engineer.memUrn, 'tasks:open-pr'));
    expect(await N.outgoingEdges(openPr.node, {}, ctx(reader))).toEqual([]);
    expect(await N.incomingEdges(openPr.node, {}, ctx(reader))).toEqual([]);
  });

  it('a base adds a task: it is on the child\'s list on the next read', async () => {
    const added = await node('engNew', engineer.mem, 'tasks:new', { isRunnable: true });
    expect((await tasks()).map((t) => t.node.id)).toContain(added);
  });

  it('Q2: an index source outside the chain is listed iff its own memory is readable', async () => {
    await node('teamTask', team.id, 'tasks:team-task');
    await node('privTask', privateMem.id, 'tasks:private-task');
    await edge('teamTask', 'backIndex', 'when the team asks');
    await edge('privTask', 'backIndex', 'when it is private');
    const listed = await tasks();
    expect(listed.find((t) => t.node.id === ids.teamTask)?.trigger).toBe('when the team asks');
    expect(listed.map((t) => t.node.id)).not.toContain(ids.privTask);
    // The manager, who owns the private memory, does see it.
    expect((await tasks(manager)).map((t) => t.node.id)).toContain(ids.privTask);
  });

  it('Q5: an Agent with no tasks index still lists its effective runnable nodes', async () => {
    await db.agent.update({ where: { id: backend.id }, data: { tasksIndexRef: null } });
    expect(await taskView()).toEqual([
      [ids.backDeploy, null, null],
      [ids.backHotfix, null, null],
      [ids.engOpenPr, 'when a PR is ready', agentUrn(engineer)],
      // engineer's index still lists tasks:review; backend's own node is listed, as in S4.
      [ids.backReview, 'when asked to review', null],
    ]);
  });

  it('a soft-deleted index lists nothing, and a soft-deleted listing edge drops its trigger', async () => {
    await db.node.update({ where: { id: ids.engIndex }, data: { deletedAt: new Date() } });
    await db.edge.updateMany({ where: { sourceId: ids.backDeploy, targetId: ids.backIndex }, data: { deletedAt: new Date() } });
    expect((await taskView()).map(([, trigger]) => trigger)).toEqual([null, null, null, 'when reviewing backend code']);
  });
});

describe('050:16 — an Agent\'s processes', () => {
  it('S1/S2: what it starts or owns, with its trigger, then what it is involved in, without', async () => {
    expect((await processes()).map((p) => [p.node.id, p.kind, p.trigger])).toEqual([
      [ids.backRelease, 'STARTS', 'when I cut a release'],
      [ids.drive, 'INVOLVED', null],
      [ids.shipIt, 'INVOLVED', null],
    ]);
  });

  it('Q6: a process both owned and staged is listed once, as STARTS', async () => {
    expect((await processes()).filter((p) => p.node.id === ids.backRelease)).toHaveLength(1);
  });

  it('a stage edge to a base task the child overrides counts for the child\'s task; to an inherited task, for it', async () => {
    const kinds = new Map((await processes()).map((p) => [p.node.id, p.kind]));
    expect(kinds.get(ids.drive)).toBe('INVOLVED'); // stages engineer's review; backend overrides it
    expect(kinds.get(ids.shipIt)).toBe('INVOLVED'); // stages engineer's open-pr, inherited ('Stage' in any case)
  });

  it('S3: removing the stage edge drops the process from the involved list, nothing else edited', async () => {
    await db.edge.deleteMany({ where: { sourceId: ids.drive } });
    expect((await processes()).map((p) => p.node.id)).toEqual([ids.backRelease, ids.shipIt]);
  });

  it('Q3: a `stage …` edge from a node that is not a process does not count, nor does a non-stage edge from a process', async () => {
    await edge('drive', 'backHotfix', 'related to');
    await db.edge.deleteMany({ where: { sourceId: ids.drive, targetId: ids.engReview } });
    expect((await processes()).map((p) => p.node.id)).not.toContain(ids.drive);
    expect((await processes()).map((p) => p.node.id)).not.toContain(ids.stagedNote);
  });

  it('a base\'s process staging an inherited task waits for #1893: not listed, even to a reader of the base', async () => {
    expect((await processes()).map((p) => p.node.id)).not.toContain(ids.engBaseRelease);
    // The manager may read engineer's memory directly, so only the #1893 skip keeps it out.
    expect((await Q.memory({}, { ref: engineer.mem }, ctx(manager)))?.id).toBe(engineer.mem);
    expect((await processes(manager)).map((p) => p.node.id)).not.toContain(ids.engBaseRelease);
  });

  it('Q4: a process the reader may not read is not listed', async () => {
    await node('privProc', privateMem.id, 'processes:private', { role: 'process' });
    await edge('privProc', 'backDeploy', 'stage 1: private');
    expect((await processes()).map((p) => p.node.id)).not.toContain(ids.privProc);
    expect((await processes(manager)).map((p) => p.node.id)).toContain(ids.privProc);
  });

  it('Q7: a base\'s processes index is not the child\'s', async () => {
    await node('engProcIndex', engineer.mem, 'processes');
    await edge('engBaseRelease', 'engProcIndex', 'when the base releases');
    await db.agent.update({ where: { id: engineer.id }, data: { processesIndexRef: ids.engProcIndex } });
    expect((await processes()).map((p) => p.node.id)).not.toContain(ids.engBaseRelease);
  });
});

describe('who may list', () => {
  it('someone who can\'t read the Agent\'s system memory is refused as not found, on both lists and both surfaces', async () => {
    await expect(Q.agentTaskList({}, { ref: backend.id }, ctx(stranger))).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(Q.agentProcessList({}, { ref: backend.id }, ctx(stranger))).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    expect(await mcp(stranger, 'hadron_agent_tasks', { agentRef: backend.id })).toContain('AGENT_NOT_FOUND');
    expect(await mcp(stranger, 'hadron_agent_processes', { agentRef: backend.id })).toContain('AGENT_NOT_FOUND');
  });

  it('the reader may list backend-engineer but not engineer, whose system memory they can\'t read', async () => {
    await expect(Q.agentTaskList({}, { ref: engineer.id }, ctx(reader))).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });

  it('a deleted Agent is not found', async () => {
    await db.agent.update({ where: { id: backend.id }, data: { deletedAt: new Date() } });
    await expect(Q.agentTaskList({}, { ref: backend.id }, ctx(manager))).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });
});

describe('050:15 S3 / 050:16 S4 — MCP returns the same lists', () => {
  /** [urn, trigger, inheritedFrom] per entry, parsed from the MCP text. */
  function parse(text: string) {
    const out: Array<[string, string | null, string | null, string | null]> = [];
    for (const line of text.split('\n')) {
      const head = /^- .* — (hrn:node:\S+)$/.exec(line);
      if (head) { out.push([head[1]!, null, null, null]); continue; }
      const last = out[out.length - 1];
      if (!last) continue;
      const trigger = /^ {2}Trigger: (.*)$/.exec(line);
      if (trigger) last[1] = trigger[1]!;
      const from = /^ {2}Inherited from: (\S+)$/.exec(line);
      if (from) last[2] = from[1]!;
      const kind = /^ {2}Kind: (.*)$/.exec(line);
      if (kind) last[3] = kind[1] === 'starts or owns' ? 'STARTS' : 'INVOLVED';
    }
    return out;
  }

  it('tasks: the same entries, in the same order, with the same triggers and bases', async () => {
    const gql = await Promise.all((await tasks()).map(async (t) =>
      [await N.urn(t.node, {}, ctx(reader)), t.trigger, N.inheritedFrom(t.node)?.agentUrn ?? null, null]));
    const text = await mcp(reader, 'hadron_agent_tasks', { agentRef: `hrn:agent:${backend.urn}` });
    expect(parse(text)).toEqual(gql);
    expect(text).toContain(`Inherited from: ${agentUrn(engineer)}`);
  });

  it('processes: the same entries, kinds and triggers', async () => {
    const gql = await Promise.all((await processes()).map(async (p) =>
      [await N.urn(p.node, {}, ctx(reader)), p.trigger, N.inheritedFrom(p.node)?.agentUrn ?? null, p.kind]));
    expect(parse(await mcp(reader, 'hadron_agent_processes', { agentRef: backend.id }))).toEqual(gql);
  });
});

describe('setAgentIndexRefs', () => {
  const set = (userId: string, args: Record<string, unknown>) => M.setAgentIndexRefs({}, { ref: backend.id, ...args }, ctx(userId));

  it('whoever manages the Agent sets a pointer by URN, and an omitted one stays as it was', async () => {
    const other = await node('otherIndex', backend.mem, 'tasks-two');
    const out = await set(manager, { tasksIndexRef: nodeUrn(backend.memUrn, 'tasks-two') });
    expect(out.tasksIndexRef).toBe(other);
    expect(out.processesIndexRef).toBe(ids.backProcIndex);
  });

  it('null clears a pointer', async () => {
    const out = await set(manager, { processesIndexRef: null });
    expect(out.processesIndexRef).toBeNull();
    expect(out.tasksIndexRef).toBe(ids.backIndex);
  });

  it('a reader who doesn\'t manage the Agent is refused, and nothing changes', async () => {
    await expect(set(reader, { tasksIndexRef: null })).rejects.toThrow();
    expect((await db.agent.findUniqueOrThrow({ where: { id: backend.id } })).tasksIndexRef).toBe(ids.backIndex);
  });

  it('a target the manager can\'t read is refused as not found, and nothing changes', async () => {
    const theirs = await db.memory.create({ data: { class: 'personal', userId: reader, ownerUserId: reader, name: 'r', urn: `${org.urn}:r-${n}` } });
    const hidden = await node('hidden', theirs.id, 'idx');
    await expect(set(manager, { tasksIndexRef: hidden })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    expect((await db.agent.findUniqueOrThrow({ where: { id: backend.id } })).tasksIndexRef).toBe(ids.backIndex);
  });

  it('a hard-deleted index node unsets the pointer (SetNull)', async () => {
    await db.edge.deleteMany({ where: { targetId: ids.backProcIndex } });
    await db.node.delete({ where: { id: ids.backProcIndex } });
    expect((await db.agent.findUniqueOrThrow({ where: { id: backend.id } })).processesIndexRef).toBeNull();
  });
});
