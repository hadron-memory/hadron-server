/** #1886: live installs/imports refuse Agent retirement without changing any row. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { waitForLockWaiters, waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let userId: string;
let alpha: { id: string };
let beta: { id: string };
const ctx = (): Context => ({ db, userId, roles: [] });
const makeAgent = (name: string, org = beta) => M.createAgent(null, {
  orgId: org.id, name, visibility: 'PUBLIC',
}, ctx());

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { id: generateId(), handle: 'deletion-admin', githubId: 1886001, roles: [] } });
  userId = user.id;
  alpha = await db.organization.create({ data: { id: generateId(), name: 'Alpha', urn: 'delete-alpha.example' } });
  beta = await db.organization.create({ data: { id: generateId(), name: 'Beta', urn: 'delete-beta.example' } });
  await db.orgMember.createMany({ data: [alpha, beta].map(org => ({ organizationId: org.id, userId, role: 'ADMIN' })) });
});

/** Publish the real cross-org import, including its real grant. */
async function importAgent(targetId: string) {
  const parent = await makeAgent('Importer', alpha);
  await M.createAgentOrgGrant(null, { agentRef: targetId, orgRef: alpha.id }, ctx());
  const edge = await M.publishAgentImport(null, { parentAgentRef: parent.id, importedAgentRef: targetId, position: 100 }, ctx());
  return { parent, edge };
}

/** Compare complete persisted rows: a refusal cannot dirty even timestamps. */
async function snapshot(id: string, memoryId: string) {
  return { agent: await db.agent.findUniqueOrThrow({ where: { id } }), memory: await db.memory.findUniqueOrThrow({ where: { id: memoryId } }) };
}

async function refusedDelete(target: { id: string; systemMemoryId: string }) {
  const before = await snapshot(target.id, target.systemMemoryId);
  await expect(M.deleteAgent(null, { ref: target.id }, ctx())).rejects.toMatchObject({ extensions: { code: 'AGENT_IN_USE' } });
  expect(await snapshot(target.id, target.systemMemoryId)).toEqual(before);
}

/** Demote after the resolver's request-context check, before its transaction. */
function demotedAdminContext(): Context {
  const wrapped = new Proxy(db, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return async (callback: (tx: any) => Promise<unknown>, options: any) => {
      await db.user.update({ where: { id: userId }, data: { roles: ['READER'] } });
      return target.$transaction(callback, options);
    };
  } });
  return { db: wrapped, userId, roles: ['ADMIN'] };
}

describe('#1890 P3 fresh-role authorization pins', () => {
  it('delete refuses a demoted platform admin without changing Agent or memory', async () => {
    const target = await makeAgent('Stale delete admin');
    await db.orgMember.deleteMany({ where: { userId } });
    await db.user.update({ where: { id: userId }, data: { roles: ['ADMIN'] } });
    const before = await snapshot(target.id, target.systemMemoryId);

    await expect(M.deleteAgent(null, { ref: target.id }, demotedAdminContext()))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await snapshot(target.id, target.systemMemoryId)).toEqual(before);

    // A real, still-current ADMIN grant permits the otherwise identical delete.
    await db.user.update({ where: { id: userId }, data: { roles: ['ADMIN'] } });
    expect(await M.deleteAgent(null, { ref: target.id }, { ...ctx(), roles: ['ADMIN'] })).toBe(true);
  });

  it('import refuses a demoted platform admin without creating an edge or changing either Agent', async () => {
    const target = await makeAgent('Stale import target');
    const parent = await makeAgent('Stale import parent', alpha);
    await M.createAgentOrgGrant(null, { agentRef: target.id, orgRef: alpha.id }, ctx());
    const input = { parentAgentRef: parent.id, importedAgentRef: target.id, position: 100 };
    const beforeTarget = await snapshot(target.id, target.systemMemoryId);
    const beforeParent = await snapshot(parent.id, parent.systemMemoryId);
    const beforeGrants = await db.agentOrgGrant.findMany();
    await db.orgMember.deleteMany({ where: { userId } });
    await db.user.update({ where: { id: userId }, data: { roles: ['ADMIN'] } });

    await expect(M.publishAgentImport(null, input, demotedAdminContext()))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.agentImport.findMany()).toEqual([]);
    expect(await snapshot(target.id, target.systemMemoryId)).toEqual(beforeTarget);
    expect(await snapshot(parent.id, parent.systemMemoryId)).toEqual(beforeParent);
    expect(await db.agentOrgGrant.findMany()).toEqual(beforeGrants);

    await db.user.update({ where: { id: userId }, data: { roles: ['ADMIN'] } });
    expect(await M.publishAgentImport(null, input, { ...ctx(), roles: ['ADMIN'] }))
      .toMatchObject({ parentAgentId: parent.id, importedAgentId: target.id });
  });
});

describe('#1886 Agent retirement dependencies', () => {
  it('a real live App installation refuses retirement and preserves install, Agent and memory', async () => {
    const target = await makeAgent('Installed');
    const app = await M.createApp(null, { orgRef: beta.id, agentRef: target.id, name: 'Installed App' }, ctx());
    const install = await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: app.id, agentId: target.id } } });
    await refusedDelete(target);
    expect(await db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: app.id, agentId: target.id } } })).toEqual(install);
    expect((await db.app.findUniqueOrThrow({ where: { id: app.id } })).deletedAt).toBeNull();
  });

  it('a real licensed cross-org import refuses retirement and preserves both Agents and the edge', async () => {
    const target = await makeAgent('Imported');
    const { parent, edge } = await importAgent(target.id);
    const beforeParent = await db.agent.findUniqueOrThrow({ where: { id: parent.id } });
    await refusedDelete(target);
    expect(await db.agentImport.findUniqueOrThrow({ where: { parentAgentId_importedAgentId: { parentAgentId: parent.id, importedAgentId: target.id } } })).toEqual(edge);
    expect(await db.agent.findUniqueOrThrow({ where: { id: parent.id } })).toEqual(beforeParent);
  });

  it('unreferenced deletion still tombstones the Agent and its owned system memory', async () => {
    const target = await makeAgent('Unused');
    expect(await M.deleteAgent(null, { ref: target.id }, ctx())).toBe(true);
    const after = await snapshot(target.id, target.systemMemoryId);
    expect(after.agent.deletedAt).not.toBeNull();
    expect(after.memory.deletedAt).not.toBeNull();
  });

  it.each(['deleted', 'uninstalled'])('a retained install on an %s App is not live', async state => {
    const target = await makeAgent('Inactive Install');
    const app = await M.createApp(null, { orgRef: beta.id, agentRef: target.id, name: 'Inactive App' }, ctx());
    await db.app.update({ where: { id: app.id }, data: state === 'deleted' ? { deletedAt: new Date() } : { uninstalledAt: new Date() } });
    expect(await M.deleteAgent(null, { ref: target.id }, ctx())).toBe(true);
  });

  it('an import retained by a deleted parent does not block retirement', async () => {
    const target = await makeAgent('Inactive Import');
    const { parent } = await importAgent(target.id);
    await db.agent.update({ where: { id: parent.id }, data: { deletedAt: new Date() } });
    expect(await M.deleteAgent(null, { ref: target.id }, ctx())).toBe(true);
  });

  it('AgentMemoryItem alone is non-blocking and its memory is untouched', async () => {
    const target = await makeAgent('Linked Knowledge');
    const memory = await M.createMemory(null, { orgId: beta.id, name: 'Linked knowledge' }, ctx());
    await db.agentMemoryItem.create({ data: { agentId: target.id, memoryId: memory.id } });
    expect(await M.deleteAgent(null, { ref: target.id }, ctx())).toBe(true);
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).deletedAt).toBeNull();
  });
});

/** Pause an actual mutation after its write, with the real transaction/locks still open. */
function pauseWrite(model: 'agent' | 'appAgent' | 'agentImport' | 'app', operation: 'update' | 'create') {
  let release!: () => void;
  let signal!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { signal = resolve; });
  const wrapped = new Proxy(db, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (callback: (tx: any) => Promise<unknown>, options: any) => target.$transaction(async tx => {
      const proxied = new Proxy(tx, { get(t, p) {
        if (p !== model) return Reflect.get(t, p);
        const delegate = Reflect.get(t, p);
        return new Proxy(delegate, { get(d, method) {
          if (method !== operation) return Reflect.get(d, method);
          return async (args: any) => {
            const invoke = Reflect.get(d, method) as (args: unknown) => Promise<unknown>;
            const result = await invoke.call(d, args);
            signal();
            await gate;
            return result;
          };
        } });
      } });
      return callback(proxied);
    }, options);
  } });
  return { ctx: { ...ctx(), db: wrapped }, held, release };
}

/** Capture errors immediately so a controlled competing refusal cannot be unhandled. */
const resultOf = (promise: Promise<unknown>) => promise.then(value => ({ ok: true, value, error: undefined }), error => ({ ok: false, value: undefined, error }));

describe('#1886 writer-coordinated races', () => {
  for (const kind of ['install', 'import', 'create-app'] as const) {
    /** Prepare all unrelated authority/fixtures before either competing transaction starts. */
    async function prepare() {
      const target = await makeAgent('Race Target');
      if (kind === 'import') {
        const parent = await makeAgent('Race Importer', alpha);
        await M.createAgentOrgGrant(null, { agentRef: target.id, orgRef: alpha.id }, ctx());
        return { target, write: (c: Context) => M.publishAgentImport(null, {
          parentAgentRef: parent.id, importedAgentRef: target.id, position: 100,
        }, c), count: () => db.agentImport.count({ where: { importedAgentId: target.id } }) };
      }
      if (kind === 'create-app') return { target,
        write: (c: Context) => M.createApp(null, { orgRef: beta.id, agentRef: target.id, name: 'Raced New App' }, c),
        count: () => db.appAgent.count({ where: { agentId: target.id } }),
      };
      const seed = await makeAgent('App Seed');
      const app = await M.createApp(null, { orgRef: beta.id, agentRef: seed.id, name: 'Raced Existing App' }, ctx());
      return { target, write: (c: Context) => M.installAgentIntoApp(null, { appRef: app.id, agentRef: target.id }, c),
        count: () => db.appAgent.count({ where: { agentId: target.id } }),
      };
    }

    it(`deletion wins: ${kind} waits, rechecks the tombstone and writes no reference`, async () => {
      const f = await prepare();
      const pause = pauseWrite('agent', 'update');
      const deletion = resultOf(M.deleteAgent(null, { ref: f.target.id }, pause.ctx));
      await pause.held;
      const insertion = resultOf(f.write(ctx()));
      try {
        await waitForLockWaiters(db);
        pause.release();
        expect((await deletion).ok).toBe(true);
        expect((await insertion).ok).toBe(false);
        expect(await f.count()).toBe(0);
        expect((await snapshot(f.target.id, f.target.systemMemoryId)).agent.deletedAt).not.toBeNull();
      } finally {
        pause.release();
        await Promise.allSettled([deletion, insertion]);
      }
    });

    it(`${kind} wins: deletion waits for its commit, then refuses with all rows intact`, async () => {
      const f = await prepare();
      const before = await snapshot(f.target.id, f.target.systemMemoryId);
      const pause = pauseWrite(kind === 'import' ? 'agentImport' : kind === 'create-app' ? 'app' : 'appAgent', 'create');
      const insertion = resultOf(f.write(pause.ctx));
      await pause.held;
      const deletion = resultOf(M.deleteAgent(null, { ref: f.target.id }, ctx()));
      try {
        await waitForLockWaiters(db);
        pause.release();
        expect((await insertion).ok).toBe(true);
        expect((await deletion).error).toMatchObject({ extensions: { code: 'AGENT_IN_USE' } });
        expect(await f.count()).toBe(1);
        expect(await snapshot(f.target.id, f.target.systemMemoryId)).toEqual(before);
      } finally {
        pause.release();
        await Promise.allSettled([deletion, insertion]);
      }
    });
  }

  it('Agent FOR UPDATE precedes the predicate, serializing an independent FOR SHARE writer', async () => {
    const target = await makeAgent('Row Fence Target');
    const seed = await makeAgent('Row Fence Seed');
    const app = await M.createApp(null, { orgRef: beta.id, agentRef: seed.id, name: 'Row Fence App' }, ctx());
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { signal = resolve; });
    // This independent writer follows Dan's set-base row-lock protocol,
    // deliberately without the install helper's advisory authority bracket.
    const writer = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM agents WHERE id = ${target.id} FOR SHARE`;
      signal();
      await gate;
      await tx.appAgent.create({ data: { appId: app.id, agentId: target.id } });
    }, { timeout: 20_000 });
    await held;
    const deletion = resultOf(M.deleteAgent(null, { ref: target.id }, ctx()));
    try {
      await waitForLockWaitersOfType(db, 'transactionid');
      release();
      await writer;
      expect((await deletion).error).toMatchObject({ extensions: { code: 'AGENT_IN_USE' } });
      expect((await snapshot(target.id, target.systemMemoryId)).agent.deletedAt).toBeNull();
    } finally {
      release();
      await Promise.allSettled([writer, deletion]);
    }
  });
});
