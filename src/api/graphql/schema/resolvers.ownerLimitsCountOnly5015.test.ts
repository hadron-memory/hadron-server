/**
 * #5015 (Billing A7b, cor:acl:150:04): the count-only doors, driven at the cap. A comment, a channel, a new memory's root node,
 * a question log and a question asked each add a live node to an owner who is AT its `nodes` limit and are never refused;
 * the nodes they add count. The rest of the acceptance's count-only list (team chat post, session handoff, compiled boot
 * prompt, team role node, worklog record, run output node, account merge) is pinned per call site by
 * `src/lib/ownerLimits/writeDoorsGuard5015.test.ts`, which fails if any of them turns to `refuse`.
 *
 * Also here, two refusing doors outside the main pin file: `importNode`, whose node insert precedes its run, refuses at the cap
 * and leaves no node and no run; `createAssetReferenceNode` refuses and writes no node (RED on main: both wrote the node).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';
import { OWNER_LIMIT_KEYS } from '../../../lib/ownerLimits/keys.js';
import type { OwnerRef } from '../../../lib/owner.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { createAssetReferenceNode } from '../../../controller/operations/createAssetReferenceNode.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
let u: string, orgId: string, mO: string, mU: string;
const ctx = (): Context => ({ db, userId: u, roles: ['READER'] } as Context);
const count = async (owner: OwnerRef) => Number(await OWNER_LIMIT_KEYS.nodes.count(db, owner));
/** Put an owner exactly at its `nodes` limit. */
const capAtCurrent = async (owner: OwnerRef) => db.ownerLimit.create({
  data: { id: generateId(), ...('userId' in owner ? { ownerUserId: owner.userId } : { organizationId: owner.organizationId }),
    key: 'nodes', limitValue: await count(owner), sourceType: 'manual', sourceId: 't', note: 't' },
});

beforeEach(async () => {
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  u = (await db.user.create({ data: { id: generateId(), handle: 'co5015-u', email: 'co5015-u@example.test', roles: ['READER'] } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'co5015', urn: 'co5015-org' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'OWNER' } });
  mO = (await db.memory.create({ data: { id: generateId(), name: 'o', urn: 'co5015-org:o', class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  mU = (await db.memory.create({ data: { id: generateId(), name: 'u', urn: 'co5015-u:u', class: 'private', userId: u, ownerUserId: u, vectorIndexEnabled: false } })).id;
  await db.node.create({ data: { id: generateId(), memoryId: mO, loc: 'a', name: 'a' } });
  await db.node.create({ data: { id: generateId(), memoryId: mU, loc: 'p', name: 'p' } });
});
afterEach(() => { vi.restoreAllMocks(); reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5015 count-only doors succeed at the owner\'s nodes limit, and what they add counts', () => {
  it('a comment', async () => {
    const owner = { organizationId: orgId };
    await capAtCurrent(owner);
    const before = await count(owner);
    const a = await db.node.findFirstOrThrow({ where: { memoryId: mO, loc: 'a' } });
    await M.createComment({}, { targetRef: a.id, body: 'a thread' }, ctx());
    expect(await count(owner)).toBeGreaterThan(before);
  });

  it('a channel', async () => {
    const owner = { organizationId: orgId };
    await capAtCurrent(owner);
    const before = await count(owner);
    await M.createChannel(null, { input: { memoryRef: mO, loc: 'chats:c', name: 'c' } }, ctx());
    expect(await count(owner)).toBeGreaterThan(before);
  });

  it('a new memory\'s root node', async () => {
    const owner = { userId: u };
    await capAtCurrent(owner);
    const before = await count(owner);
    await M.createMemory(null, { name: 'fresh', memoryClass: 'private' }, ctx());
    expect(await count(owner)).toBeGreaterThan(before);
  });

  it('a question log and a question asked', async () => {
    const owner = { organizationId: orgId };
    await capAtCurrent(owner);
    const before = await count(owner);
    const log = await M.createQuestionLog(null, { memoryRef: mO, loc: 'decisions', defaultDeciders: [u] }, ctx());
    await M.askQuestion(null, { logRef: log.row.id, input: { title: 'Ship it?', yesno: true, recommendation: { key: 'yes', reason: 'ready' } } }, ctx());
    expect(await count(owner)).toBeGreaterThan(before + 1);
  });
});

describe('#5015 importNode at the owner\'s nodes limit', () => {
  it('refuses before the node insert: no node and no run', async () => {
    const app = await db.app.create({ data: { name: 'Import App', urn: 'co5015-org:app', organizationId: orgId } });
    const agentId = (await db.agent.create({ data: { name: 'Importer', urn: 'co5015-org:importer', organizationId: orgId } })).id;
    await db.appAgent.create({ data: { appId: app.id, agentId } as never });
    await serveAgentBootPrompt(db, agentId, 'You import.');
    const task = await db.node.create({ data: { id: generateId(), memoryId: mO, loc: 'tasks:import', name: 'Import', isRunnable: true, nodeType: 'task', content: 'Process {{importedNodeUrn}}' } });
    await capAtCurrent({ organizationId: orgId });
    const admin: Context = { db, userId: u, roles: ['READER'], clientId: `user:${u}` } as Context;
    await expect(M.importNode({}, { input: { memoryId: mO, loc: 'clips:refused', content: '# Imported', contentType: 'text/markdown', taskRef: task.id, appRef: app.id } }, admin))
      .rejects.toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'nodes', callerCanManageOwner: true } });
    expect(await db.node.findUnique({ where: { loc_memoryId: { loc: 'clips:refused', memoryId: mO } } })).toBeNull();
    expect(await db.appRun.count()).toBe(0);
  });
});

describe('#5015 createAssetReferenceNode at the owner\'s nodes limit', () => {
  it('refuses the reference node and writes nothing', async () => {
    const assetId = generateId();
    await db.asset.create({ data: { id: assetId, memoryId: mU, filename: 'plan.pdf', mimeType: 'application/pdf', sizeBytes: 2048,
      storageKey: `key-${assetId}`, scanStatus: 'CLEAN', uploadedBy: u } });
    await capAtCurrent({ userId: u });
    await expect(createAssetReferenceNode(db, { userId: u, roles: ['READER'] as never }, ctx() as never,
      { assetRef: assetId, nodeUrn: 'hrn:node:co5015-u:u:files:plan' }))
      .rejects.toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'nodes', ownerType: 'user', callerCanManageOwner: true } });
    expect(await db.node.count({ where: { memoryId: mU, loc: 'files:plan' } })).toBe(0);
  });
});
