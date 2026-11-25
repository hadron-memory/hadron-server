/**
 * #5015 (Billing A7b, issue step 12; cor:agt:010:03): a run tool that creates a node hands the owner's `nodes` refusal to
 * the model as the tool's own error, and the run goes on. A handler throw is terminal (`TOOL_FAILED`, D-TL-6), so the
 * tools RETURN the refusal; `hadron_store_file` leaves no Asset row and no object behind.
 *
 * RED before the fix: both tools threw, and `admitAndExecuteTool` turned the throw into a `ToolExecutionError` (the run
 * failed TOOL_FAILED).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../integrations/objectstore/index.js', () => ({
  putObject: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { putObject, deleteObject } from '../../../integrations/objectstore/index.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { reloadOwnerDefaultLimitsForTests } from '../../ownerLimits/defaults.js';
import { OWNER_LIMIT_NO_NUMBER_MESSAGE } from '../../ownerLimits/errors.js';
import { admitAndExecuteTool } from '../toolAdmission.js';
import { hadronStoreFile } from './index.js';
import { hadronCreateNode, hadronUpdateNode } from './nodeTools.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';
import { testRunAgentId } from '../../../test/runAgent.js';
import { resolvers, type Context } from '../../../api/graphql/schema/resolvers.js';

const ORG_URN = 'ol5015-run-org';
const MEM_URN = `${ORG_URN}:runmem`;
let orgId: string, appId: string, memoryId: string, writerId: string, ownerId: string;

async function mintRun(userId: string | null): Promise<AppRun> {
  return db.appRun.create({
    data: {
      id: generateId(), organizationId: orgId, appId, agentId: await testRunAgentId(db, orgId, appId), userId,
      triggerKind: 'MANUAL', entryNodeUrn: `${ORG_URN}::runmem::flow:entry`, status: 'RUNNING',
    },
  });
}
const toolCtx = (run: AppRun): RunToolContext => ({ log: vi.fn(), db, run, principal: runContext(db, run) });
const call = (def: typeof hadronCreateNode, run: AppRun, args: Record<string, unknown>) =>
  admitAndExecuteTool(def, args, { toolCtx: toolCtx(run) }) as Promise<Record<string, any>>;

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  reloadOwnerDefaultLimitsForTests({});
  orgId = (await db.organization.create({ data: { id: generateId(), name: ORG_URN, urn: ORG_URN } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'ol-app', urn: `${ORG_URN}::ol-app` } })).id;
  const mk = async (role: 'CONTRIBUTOR' | 'OWNER') => {
    const id = (await db.user.create({ data: { handle: `ol5015-${role.toLowerCase()}-${generateId().toLowerCase()}` } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: id, role } });
    await db.appMember.create({ data: { appId, userId: id, role: 'member' } });
    return id;
  };
  writerId = await mk('CONTRIBUTOR');
  ownerId = await mk('OWNER');
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: orgId, name: 'runmem', urn: MEM_URN, class: 'knowledge', visibility: 'ORGANIZATION' },
  })).id;
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'ol-agent', urn: `${ORG_URN}:ol-agent` } });
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId, role: 'read-write' } });
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'existing', name: 'existing' } });
});
afterEach(() => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }));

describe('#5015 run tools at the owner\'s nodes limit', () => {
  it('hadron_create_node returns the refusal as the tool\'s result (no throw, so the run goes on) and writes nothing', async () => {
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify({ organization: { nodes: 1 } }) });
    const run = await mintRun(writerId);
    const out = await call(hadronCreateNode, run, { urn: `hrn:node:${ORG_URN}:runmem:fresh`, name: 'fresh' });
    expect(out.created).toBe(false);
    // A CONTRIBUTOR manages neither owner: the third form, no owner id, no limit, no number.
    expect(out.error).toEqual({
      code: 'OWNER_LIMIT_REACHED', limitKey: 'nodes', ownerType: 'organization', callerCanManageOwner: false,
      message: OWNER_LIMIT_NO_NUMBER_MESSAGE,
    });
    expect(await db.node.count({ where: { memoryId, loc: 'fresh' } })).toBe(0);
  });

  it('hadron_create_node on behalf of an organization OWNER carries the owner\'s id and the limit', async () => {
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify({ organization: { nodes: 1 } }) });
    const out = await call(hadronCreateNode, await mintRun(ownerId), { urn: `hrn:node:${ORG_URN}:runmem:fresh`, name: 'fresh' });
    expect(out.error).toMatchObject({ code: 'OWNER_LIMIT_REACHED', callerCanManageOwner: true, ownerId: orgId, limit: '1' });
  });

  it('hadron_create_node in a run with no on-behalf-of user returns the form with no owner and no number', async () => {
    // A run with no user writes through an App memory write grant (the #3278 path); an agent's item alone does not admit it.
    await resolvers.Mutation.setAppMemoryWriteGrant({}, { appRef: appId, memoryRef: memoryId, prefix: 'docs', registerNodeUrn: 'hrn:node:example.com:register:authority' },
      { db, userId: ownerId, roles: ['READER'] } as Context);
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify({ organization: { nodes: 1 } }) });
    const out = await call(hadronCreateNode, await mintRun(null), { urn: `hrn:node:${ORG_URN}:runmem:docs:fresh`, name: 'fresh' });
    expect(out.error).toEqual({
      code: 'OWNER_LIMIT_REACHED', limitKey: 'nodes', ownerType: 'organization', callerCanManageOwner: false,
      message: OWNER_LIMIT_NO_NUMBER_MESSAGE,
    });
    expect(await db.node.count({ where: { memoryId, loc: 'docs:fresh' } })).toBe(0);
  });

  it('hadron_create_node still creates below the limit', async () => {
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify({ organization: { nodes: 2 } }) });
    const out = await call(hadronCreateNode, await mintRun(writerId), { urn: `hrn:node:${ORG_URN}:runmem:fresh`, name: 'fresh' });
    expect(out.created).toBe(true);
  });

  it('hadron_store_file returns the refusal and leaves no Asset row and no object', async () => {
    reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify({ organization: { nodes: 1 } }) });
    const run = await mintRun(writerId);
    const urn = `${ORG_URN}::runmem::files:report`;
    const out = await call(hadronStoreFile as typeof hadronCreateNode, run, { urn, filename: 'report.md', content: '# r' });
    expect(out.stored).toBe(false);
    expect(out.error).toMatchObject({ code: 'OWNER_LIMIT_REACHED', callerCanManageOwner: false });
    expect(putObject).toHaveBeenCalledOnce();
    const key = vi.mocked(putObject).mock.calls[0][0].key;
    expect(deleteObject).toHaveBeenCalledWith(key);
    expect(await db.asset.count({ where: { memoryId } })).toBe(0);
    expect(await db.node.count({ where: { memoryId, loc: 'files:report' } })).toBe(0);
  });

  it('#5019: hadron_create_node and hadron_update_node return the node-size refusal and write nothing', async () => {
    vi.stubEnv('NODE_CONTENT_MAX_BYTES', '10');
    try {
      const run = await mintRun(writerId);
      const error = { code: 'NODE_CONTENT_TOO_LARGE', maxBytes: 10, message: 'A node can hold at most 10 bytes.' };
      const created = await call(hadronCreateNode, run, { urn: `hrn:node:${ORG_URN}:runmem:fresh`, name: 'fresh', content: 'x'.repeat(11) });
      expect(created).toMatchObject({ created: false, error });
      expect((created as { error: object }).error).toEqual(error);
      const updated = await call(hadronUpdateNode, run, { urn: `hrn:node:${ORG_URN}:runmem:existing`, content: 'x'.repeat(11) });
      expect(updated).toMatchObject({ updated: false, error });
      expect((updated as { error: object }).error).toEqual(error);
      expect(await db.node.count({ where: { memoryId, loc: 'fresh' } })).toBe(0);
      expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'existing' } })).content).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });

  it('any other handler failure still ends the run (TOOL_FAILED): only the owner-limit refusal is returned', async () => {
    const run = await mintRun(writerId);
    await expect(call(hadronCreateNode, run, { urn: `hrn:node:${ORG_URN}:runmem:existing`, name: 'dup' }))
      .rejects.toThrow(/already exists/);
  });
});
