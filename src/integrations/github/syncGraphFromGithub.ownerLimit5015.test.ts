/**
 * #5015 (Billing A7b, cor:acl:150:04, gate ruling 7): a GitHub sync is judged once, on its net (live nodes it adds less those
 * its cleanup removes), against the memory owner's `nodes` limit. A refused sync writes no node (the whole transaction rolls
 * back), records the refusal on the memory in the form with no owner and no number, and returns the refusal in the form for
 * the caller it was given (`ownerLimitCaller`; null for the webhook and boot paths).
 *
 * RED on main: the refused cases wrote every node and recorded syncStatus OK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { OWNER_LIMIT_NO_NUMBER_MESSAGE } from '../../lib/ownerLimits/errors.js';
import { reloadOwnerDefaultLimitsForTests } from '../../lib/ownerLimits/defaults.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';

vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, { stdout: '', stderr: '' });
}) }));
vi.mock('./githubApp.js', () => ({ getInstallationToken: vi.fn(async () => 'fixture'), toHttpsUrl: vi.fn((s: string) => s) }));
vi.mock('../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
let graphsPath: string;
let cleanup: () => void;
let graph: MemoryWithOrg;
let orgId: string;
let admin: string;
vi.mock('../../config.js', async original => ({ ...await original<typeof import('../../config.js')>(), get GRAPHS_PATH() { return graphsPath; } }));
const root = () => join(graphsPath, 'limit-org', 'limit-memory');
const file = (loc: string) => {
  mkdirSync(root(), { recursive: true });
  writeFileSync(join(root(), `${loc}.md`), `---\nname: ${loc}\n---\nbody of ${loc}\n`);
};
const cap = (limitValue: number) => db.ownerLimit.create({
  data: { id: generateId(), organizationId: orgId, key: 'nodes', limitValue, sourceType: 'manual', sourceId: 't', note: 't' },
});
const liveNodes = () => db.node.count({ where: { memoryId: graph.id, deletedAt: null } });
const memoryRow = async () => db.memory.findUniqueOrThrow({ where: { id: graph.id } }) as unknown as Promise<{ syncStatus: string; syncError: string | null; lastSyncReport: string | null }>;

beforeEach(async () => {
  ({ dir: graphsPath, cleanup } = makeTmpDir());
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  const { org, graph: created } = await createDbOrgAndGraph(db, { orgName: 'limit-org', graphName: 'limit-memory' });
  orgId = org.id;
  await db.organization.update({ where: { id: org.id }, data: { githubInstallationId: 12345 } });
  graph = await db.memory.update({ where: { id: created.id }, data: { urn: 'limit-org:limit-memory', source: 'git@github.com:fixture/repo.git', readBranch: 'main' }, include: { organization: true } });
  admin = (await db.user.create({ data: { id: generateId(), handle: 'sync5015-admin', email: 'sync5015-admin@example.test', roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin, role: 'ADMIN' } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5015 GitHub sync at the owner\'s nodes limit', () => {
  it('control: a sync whose net fits the headroom commits every node', async () => {
    const before = await liveNodes();
    await cap(before + 2);
    file('a'); file('b');
    const result = await syncGraphFromGithub(graph, { ownerLimitCaller: { userId: admin } });
    expect(result.error).toBeUndefined();
    expect(await liveNodes()).toBe(before + 2);
    expect((await memoryRow()).syncStatus).toBe('OK');
  });

  it('refuses a sync whose net exceeds the headroom as a whole: no node written, the refusal recorded, the admin\'s form returned', async () => {
    const before = await liveNodes();
    await cap(before + 1);
    file('a'); file('b');
    const result = await syncGraphFromGithub(graph, { ownerLimitCaller: { userId: admin } });
    expect(result.errorCode).toBe('OWNER_LIMIT_REACHED');
    expect(result.fault).toBeUndefined();
    expect(result.ownerLimitError?.extensions).toMatchObject({
      code: 'OWNER_LIMIT_REACHED', limitKey: 'nodes', ownerType: 'organization', callerCanManageOwner: true, ownerId: orgId, limit: String(before + 1),
    });
    expect(await liveNodes()).toBe(before);
    expect(await db.node.count({ where: { memoryId: graph.id, loc: { in: ['a', 'b'] } } })).toBe(0);
    const row = await memoryRow();
    expect(row.syncStatus).toBe('ERROR');
    expect(row.syncError).toBe(OWNER_LIMIT_NO_NUMBER_MESSAGE);
    expect(JSON.parse(row.lastSyncReport!)).toMatchObject({ version: 3, outcome: 'failed', entries: [], code: 'OWNER_LIMIT_REACHED' });
  });

  it('with no caller (webhook, boot) the returned refusal names no owner and no number', async () => {
    await cap(await liveNodes());
    file('a');
    const result = await syncGraphFromGithub(graph);
    expect(result.errorCode).toBe('OWNER_LIMIT_REACHED');
    expect(result.error).toBe(OWNER_LIMIT_NO_NUMBER_MESSAGE);
    expect(result.ownerLimitError?.extensions).toEqual({ code: 'OWNER_LIMIT_REACHED', limitKey: 'nodes', ownerType: 'organization', callerCanManageOwner: false });
    expect((await memoryRow()).syncError).toBe(OWNER_LIMIT_NO_NUMBER_MESSAGE);
  });

  it('a sync that removes as many nodes as it adds succeeds at the cap', async () => {
    file('a'); file('b');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    await cap(await liveNodes());
    unlinkSync(join(root(), 'a.md'));
    file('c');
    const result = await syncGraphFromGithub(graph, { ownerLimitCaller: { userId: admin } });
    expect(result.error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'c', deletedAt: null } })).toBe(1);
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'a' } })).toBe(0);
  });

  it('an owner already over a lowered limit can still sync a change whose net is zero (adding nothing is never refused)', async () => {
    file('a'); file('b');
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    await cap((await liveNodes()) - 1);
    unlinkSync(join(root(), 'a.md'));
    file('c');
    const result = await syncGraphFromGithub(graph, { ownerLimitCaller: { userId: admin } });
    expect(result.error).toBeUndefined();
    expect(await db.node.count({ where: { memoryId: graph.id, loc: 'c', deletedAt: null } })).toBe(1);
  });

  it('a later sync after a refusal, with room made, commits and clears the recorded refusal', async () => {
    const before = await liveNodes();
    const row = await cap(before);
    file('a');
    expect((await syncGraphFromGithub(graph)).errorCode).toBe('OWNER_LIMIT_REACHED');
    await db.ownerLimit.update({ where: { id: row.id }, data: { limitValue: before + 1 } });
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    const after = await memoryRow();
    expect(after.syncStatus).toBe('OK');
    expect(after.syncError).toBeNull();
    expect(after.lastSyncReport).toBeNull();
  });
});
