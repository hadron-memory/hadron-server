/**
 * #1892 — the task list on the version served (#1891's Diego P2-1 class).
 *
 * The list is computed from a scope snapshot and per-loc lookups taken before
 * the rows it serves are read, so a base can change in between. These pins
 * stage that interleaving deterministically, the way
 * resolvers.effectiveRace1885.test.ts does: a hook runs right after the scope
 * snapshot, after one loc lookup, or after the list is built, and changes the
 * base as a concurrent writer would. Only what is effective NOW is served.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

const hooks: {
  afterScope?: () => Promise<void>;
  afterLoc?: { loc: string; run: () => Promise<void> };
  afterList?: () => Promise<void>;
  afterTargetResolved?: () => Promise<void>;
} = {};

vi.mock('../../../lib/effectiveSystemMemory.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../lib/effectiveSystemMemory.js')>();
  return {
    ...mod,
    effectiveScope: async (...args: Parameters<typeof mod.effectiveScope>) => {
      const out = await mod.effectiveScope(...args);
      const hook = hooks.afterScope;
      hooks.afterScope = undefined;
      if (hook) await hook();
      return out;
    },
    findEffectiveNodeIdByLoc: async (...args: Parameters<typeof mod.findEffectiveNodeIdByLoc>) => {
      const out = await mod.findEffectiveNodeIdByLoc(...args);
      const hook = hooks.afterLoc;
      if (hook && args[2] === hook.loc) {
        hooks.afterLoc = undefined;
        await hook.run();
      }
      return out;
    },
  };
});
vi.mock('../../../lib/agentDefinitionLists.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../lib/agentDefinitionLists.js')>();
  return {
    ...mod,
    listAgentTasks: async (...args: Parameters<typeof mod.listAgentTasks>) => {
      const out = await mod.listAgentTasks(...args);
      const hook = hooks.afterList;
      hooks.afterList = undefined;
  hooks.afterTargetResolved = undefined;
      if (hook) await hook();
      return out;
    },
    listAgentProcesses: async (...args: Parameters<typeof mod.listAgentProcesses>) => {
      const out = await mod.listAgentProcesses(...args);
      const hook = hooks.afterList;
      hooks.afterList = undefined;
      if (hook) await hook();
      return out;
    },
  };
});
// setAgentIndexRefs resolves its targets before its transaction: the hook runs
// in that window, as a concurrent revoker would.
vi.mock('./resolvers.nodeRefAccess.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./resolvers.nodeRefAccess.js')>();
  return {
    ...mod,
    resolveNodeRefForCaller: async (...args: Parameters<typeof mod.resolveNodeRefForCaller>) => {
      const out = await mod.resolveNodeRefForCaller(...args);
      const hook = hooks.afterTargetResolved;
      hooks.afterTargetResolved = undefined;
      if (hook) await hook();
      return out;
    },
  };
});
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;

let n: number;
let org: { id: string; urn: string };
let reader: string;
let manager: string;
let team: { id: string };
let privateMem: { id: string };
let engineer: { id: string; mem: string; memUrn: string };
let backend: { id: string; mem: string; memUrn: string };
const ids: Record<string, string> = {};
const ctx = (): Context => ({ db, userId: reader, roles: ['READER'] });
const mcp = (params: Record<string, unknown>) =>
  createTestableMcpServer({ userId: reader, roles: ['READER'], clientId: `user:${reader}` }).callToolText('hadron_agent_tasks', params);
const listed = async () => ((await Q.agentTaskList({}, { ref: backend.id }, ctx())) as Array<{ node: { id: string } }>).map((t) => t.node.id);

async function agent(slug: string, baseId?: string) {
  const memUrn = `${org.urn}:${slug}-system`;
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: slug, urn: memUrn } });
  const a = await db.agent.create({ data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility: 'ORGANIZATION', systemMemoryId: mem.id, extendsAgentId: baseId ?? null } });
  return { id: a.id, mem: mem.id, memUrn };
}

async function node(key: string, memoryId: string, loc: string, data: { role?: string; isRunnable?: boolean } = {}) {
  ids[key] = (await db.node.create({ data: { memoryId, loc, name: key, content: `${key} body`, role: data.role ?? null, isRunnable: data.isRunnable ?? null } })).id;
}

const turnOpenPrIntoBootPrompt = async () => {
  await db.node.update({ where: { id: ids.engOpenPr }, data: { role: 'boot-prompt' } });
};

beforeEach(async () => {
  await cleanDb(db);
  hooks.afterScope = undefined;
  hooks.afterLoc = undefined;
  hooks.afterList = undefined;
  hooks.afterTargetResolved = undefined;
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Race', urn: `race1892-${n}.example` }, select: { id: true, urn: true } });
  reader = (await db.user.create({ data: { handle: `race1892-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader, role: 'READER' } });
  manager = (await db.user.create({ data: { handle: `race1892m-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager, role: 'ADMIN' } });
  team = await db.memory.create({ data: { class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id, name: 'team', urn: `${org.urn}:team` }, select: { id: true } });
  privateMem = await db.memory.create({ data: { class: 'personal', userId: manager, ownerUserId: manager, name: 'mine', urn: `${org.urn}:mine-${n}` }, select: { id: true } });
  engineer = await agent('engineer');
  backend = await agent('backend-engineer', engineer.id);
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: backend.id } });
  await db.appMember.create({ data: { appId: app.id, userId: reader, role: 'member' } });

  await node('engIndex', engineer.mem, 'tasks');
  await node('engOpenPr', engineer.mem, 'tasks:open-pr', { isRunnable: true });
  await node('engShip', engineer.mem, 'tasks:ship', { isRunnable: true });
  await db.edge.create({ data: { memoryId: engineer.mem, sourceId: ids.engOpenPr, targetId: ids.engIndex, name: 'when a PR is ready', loc: 'e1' } });
  await db.agent.update({ where: { id: engineer.id }, data: { tasksIndexRef: ids.engIndex } });
  await node('backDeploy', backend.mem, 'tasks:deploy', { isRunnable: true });
  await node('teamTask', team.id, 'tasks:team-task');
  await db.edge.create({ data: { memoryId: team.id, sourceId: ids.teamTask, targetId: ids.engIndex, name: 'when the team asks', loc: 'e2' } });
});

describe('after the scope snapshot', () => {
  it('a runnable base boot prompt inserted then is not listed, on either surface', async () => {
    const insert = async () => node('lateBoot', engineer.mem, 'tasks:late-boot', { role: 'boot-prompt', isRunnable: true });
    hooks.afterScope = insert;
    expect(await listed()).not.toContain(ids.lateBoot);
    expect(await listed()).toEqual([ids.backDeploy, ids.engOpenPr, ids.engShip, ids.teamTask]); // untouched content still comes through
    await db.node.delete({ where: { id: ids.lateBoot } });
    hooks.afterScope = insert;
    expect(await mcp({ agentRef: backend.id })).not.toContain('tasks:late-boot');
  });

  it('a child override added then (not runnable) hides the base\'s task', async () => {
    hooks.afterScope = async () => node('backShip', backend.mem, 'tasks:ship', { isRunnable: false });
    expect(await listed()).toEqual([ids.backDeploy, ids.engOpenPr, ids.teamTask]);
  });
});

describe('after one loc lookup', () => {
  it('an index-listed base task turned boot prompt then is not listed', async () => {
    hooks.afterLoc = { loc: 'tasks:open-pr', run: turnOpenPrIntoBootPrompt };
    expect(await listed()).toEqual([ids.backDeploy, ids.engShip, ids.teamTask]);
  });

  it('on MCP too, which serves the list without a second read', async () => {
    hooks.afterLoc = { loc: 'tasks:open-pr', run: turnOpenPrIntoBootPrompt };
    const out = await mcp({ agentRef: backend.id });
    expect(out).toContain('tasks:ship');
    expect(out).not.toContain('tasks:open-pr');
  });
});

describe('after the list is built (GraphQL re-reads the rows it serves)', () => {
  it('an inherited task turned boot prompt then is dropped, and a deleted one does not crash the list', async () => {
    hooks.afterList = async () => {
      await turnOpenPrIntoBootPrompt();
      await db.node.update({ where: { id: ids.backDeploy }, data: { deletedAt: new Date() } });
    };
    expect(await listed()).toEqual([ids.engShip, ids.teamTask]);
  });
});

describe('after the list is built: GraphQL re-authorizes the rows it serves (Anne P2-1)', () => {
  it('a readable outside-chain task moved into an unreadable memory is dropped; the rest is served', async () => {
    expect(await listed()).toContain(ids.teamTask); // control
    hooks.afterList = async () => {
      await db.node.update({ where: { id: ids.teamTask }, data: { memoryId: privateMem.id } });
    };
    expect(await listed()).toEqual([ids.backDeploy, ids.engOpenPr, ids.engShip]);
  });

  it('an inherited task the child overrides after the list is dropped, never served as the base\'s', async () => {
    hooks.afterList = async () => {
      await node('backShip', backend.mem, 'tasks:ship', { isRunnable: false });
    };
    expect(await listed()).toEqual([ids.backDeploy, ids.engOpenPr, ids.teamTask]);
  });

  it('a reader who loses the Agent\'s system memory after the list gets nothing', async () => {
    hooks.afterList = async () => {
      await db.appMember.deleteMany({ where: { userId: reader } });
    };
    expect(await listed()).toEqual([]);
  });
});

describe('setAgentIndexRefs re-authorizes inside its transaction (Anne P2-2)', () => {
  const set = (args: Record<string, unknown>) => M.setAgentIndexRefs({}, { ref: backend.id, ...args }, { db, userId: manager, roles: ['READER'] } as Context);
  const pointer = async () => (await db.agent.findUniqueOrThrow({ where: { id: backend.id } })).tasksIndexRef;

  it('control: an ADMIN sets the pointer', async () => {
    expect((await set({ tasksIndexRef: ids.backDeploy })).tasksIndexRef).toBe(ids.backDeploy);
  });

  it('an ADMIN demoted after the first check and before the transaction is refused, and nothing changes', async () => {
    // The target is the team memory's, which a READER still reads, so only the manage gate can refuse.
    hooks.afterTargetResolved = async () => {
      await db.orgMember.updateMany({ where: { userId: manager, organizationId: org.id }, data: { role: 'READER' } });
    };
    const err = await set({ tasksIndexRef: ids.teamTask }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).not.toBe('NODE_NOT_FOUND');
    expect(await pointer()).toBeNull();
  });

  it('control: the same team-memory target is accepted when nobody is demoted', async () => {
    expect((await set({ tasksIndexRef: ids.teamTask })).tasksIndexRef).toBe(ids.teamTask);
  });

  it('a target deleted in that window is refused as not found, and nothing changes', async () => {
    hooks.afterTargetResolved = async () => {
      await db.node.update({ where: { id: ids.backDeploy }, data: { deletedAt: new Date() } });
    };
    await expect(set({ tasksIndexRef: ids.backDeploy })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    expect(await pointer()).toBeNull();
  });

  it('a target moved into a memory the ADMIN can\'t read in that window is refused, and nothing changes', async () => {
    const theirs = await db.memory.create({ data: { class: 'personal', userId: reader, ownerUserId: reader, name: 'r', urn: `${org.urn}:r-${n}` } });
    hooks.afterTargetResolved = async () => {
      await db.node.update({ where: { id: ids.teamTask }, data: { memoryId: theirs.id } });
    };
    await expect(set({ tasksIndexRef: ids.teamTask })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    expect(await pointer()).toBeNull();
  });

  it('the Agent deleted in that window is refused, and nothing changes', async () => {
    hooks.afterTargetResolved = async () => {
      await db.agent.update({ where: { id: backend.id }, data: { deletedAt: new Date() } });
    };
    await expect(set({ tasksIndexRef: ids.backDeploy })).rejects.toThrow();
    expect(await pointer()).toBeNull();
  });
});

describe('#1941: an inherited INVOLVED process, on the version served', () => {
  const involved = async () =>
    ((await Q.agentProcessList({}, { ref: backend.id }, ctx())) as Array<{ node: { id: string }; kind: string }>)
      .filter((p) => p.kind === 'INVOLVED').map((p) => p.node.id);
  const mcpProcesses = () =>
    createTestableMcpServer({ userId: reader, roles: ['READER'], clientId: `user:${reader}` })
      .callToolText('hadron_agent_processes', { agentRef: backend.id });
  const toBootPrompt = async () => { await db.node.update({ where: { id: ids.engRelease }, data: { role: 'boot-prompt' } }); };

  beforeEach(async () => {
    await node('engRelease', engineer.mem, 'processes:release', { role: 'process' });
    await db.edge.create({ data: { memoryId: engineer.mem, sourceId: ids.engRelease, targetId: ids.engOpenPr, name: 'stage 1: open the PR', loc: 'e3' } });
  });

  it('control: listed, on both surfaces', async () => {
    expect(await involved()).toEqual([ids.engRelease]);
    expect(await mcpProcesses()).toContain('processes:release');
  });

  it('turned boot prompt between the loc lookup and the read: dropped', async () => {
    hooks.afterLoc = { loc: 'processes:release', run: toBootPrompt };
    expect(await involved()).toEqual([]);
  });

  it('the same on MCP, which serves the list without a second read', async () => {
    hooks.afterLoc = { loc: 'processes:release', run: toBootPrompt };
    expect(await mcpProcesses()).not.toContain('processes:release');
  });

  it('overridden by the child between the loc lookup and the read: the base\'s node is never served', async () => {
    hooks.afterLoc = { loc: 'processes:release', run: async () => { await node('backNote', backend.mem, 'processes:release'); } };
    expect(await involved()).toEqual([]);
  });

  it('overridden then on MCP, which has no second read: only the as-read re-check keeps the base\'s node out', async () => {
    hooks.afterLoc = { loc: 'processes:release', run: async () => { await node('backNote', backend.mem, 'processes:release'); } };
    expect(await mcpProcesses()).not.toContain('processes:release');
  });

  it('overridden by the child after the list is built: GraphQL drops the base\'s row', async () => {
    hooks.afterList = async () => { await node('backNote', backend.mem, 'processes:release'); };
    expect(await involved()).toEqual([]);
  });
});
