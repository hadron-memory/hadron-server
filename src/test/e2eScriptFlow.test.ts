/**
 * #4624: the E2E script-node fixture (src/test/e2eScriptFlow.ts, which scripts/e2e/seed.ts calls) run through the real run
 * path: triggerAppRun as the org admin, then the production executor with the production deps. The bus and git mirror seams are
 * mocked, but the model path is not: the stack has no AI config, so a model call would fail the run, and `tokensSpent` is 0.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { revokeGrantRow } from './appGrants5404.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { executeAppRun } from '../jobs/appRuns.js';
import { makeProdRunDeps } from '../jobs/appRunDeps.js';
import { seedE2eStockAgents } from './e2eBootPrompt.js';
import { E2E_SCRIPT_REFUSED_ENTRY, E2E_SCRIPT_REFUSED_RESULT, E2E_SCRIPT_WRITE_ENTRY, E2E_SCRIPT_WRITE_RESULT, e2eFlowNodeUrn, seedE2eScriptFlow } from './e2eScriptFlow.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any;
const salt = generateId();
const id = (name: string) => createHash('sha256').update(`${salt}:${name}`).digest('hex').slice(0, 32);
let org: string, organizationId: string, admin: any, appId: string, coordinatorId: string, flowsMemoryId: string;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  org = `e2e-${generateId().toLowerCase()}`;
  organizationId = (await db.organization.create({ data: { name: org, urn: org } })).id;
  admin = await db.user.create({ data: { githubId: 462400, githubUsername: org, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId, userId: admin.id, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { organizationId, urn: `${org}:team`, name: 'team', surfaces: ['chat', 'web'], createdBy: admin.id } })).id;
  await db.appMember.create({ data: { appId, userId: admin.id, role: 'admin' } });
  const appMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId, urn: `${org}:app`, name: 'app', class: 'app', appId } })).id;
  const systemMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId, urn: `${org}:system`, name: 'system', class: 'system' } })).id;
  await seedE2eStockAgents(db, { org, organizationId, appId, systemMemoryId, appMemoryId, id, approvedAt: new Date('2026-01-01T00:00:00Z') });
  coordinatorId = id(`${org}:coordinator`);
  flowsMemoryId = (await seedE2eScriptFlow(db, { org, organizationId, appId, agentId: coordinatorId, grantedBy: admin.id, id })).memoryId;
});

const trigger = (entry: string) => M.triggerAppRun({}, { input: { appRef: appId, agentRef: coordinatorId, entryNodeUrn: e2eFlowNodeUrn(org, entry) } }, ctx());
const written = (loc: string) => db.node.findUnique({ where: { loc_memoryId: { loc, memoryId: flowsMemoryId } } });

describe('#4624 script-node fixture on the production run path', () => {
  it('the write flow completes with no model call and its write present, under the App write grant', async () => {
    const run = await trigger(E2E_SCRIPT_WRITE_ENTRY);
    expect(await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'PENDING', triggerKind: 'MANUAL' });
    expect(await executeAppRun(db, run.id, makeProdRunDeps(db))).toBe('completed');
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe('COMPLETED');
    expect(after.tokensSpent).toBe(0);
    expect((await written(E2E_SCRIPT_WRITE_RESULT))?.content).toContain('script-node fixture');
  });

  it('sufficiency: the agent holds only the lesser role \'read\' on the memory and the write still completes', async () => {
    // The App write grant authorizes the write; the agent's memory role only grants visibility (#4624 review F1).
    expect(await db.agentMemoryItem.findMany({ where: { agentId: coordinatorId, memoryId: flowsMemoryId } })).toMatchObject([{ role: 'read' }]);
    const run = await trigger(E2E_SCRIPT_WRITE_ENTRY);
    expect(await executeAppRun(db, run.id, makeProdRunDeps(db))).toBe('completed');
    expect((await written(E2E_SCRIPT_WRITE_RESULT))?.content).toContain('script-node fixture');
  });

  it('the refused flow writes nothing: a loc with no App write grant is refused by the product', async () => {
    const run = await trigger(E2E_SCRIPT_REFUSED_ENTRY);
    expect(await executeAppRun(db, run.id, makeProdRunDeps(db))).toBe('failed');
    expect(await written(E2E_SCRIPT_REFUSED_RESULT)).toBeNull();
    const after = await db.appRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).not.toBe('COMPLETED');
    expect(after.failure).toMatchObject({ code: 'TOOL_FAILED', message: expect.stringContaining('no write access to this memory') });
  });

  it('control: the write is authorized by the grant, not by the fixture (revoke it and the same flow is refused)', async () => {
    // #5404: the grant is the App's signed `memory.write` grant; revoke every one it holds.
    for (const g of await db.grant.findMany({ where: { granteeAppId: appId, action: 'memory.write' }, select: { id: true } })) await revokeGrantRow(g.id, admin.id);
    const run = await trigger(E2E_SCRIPT_WRITE_ENTRY);
    expect(await executeAppRun(db, run.id, makeProdRunDeps(db))).toBe('failed');
    expect(await written(E2E_SCRIPT_WRITE_RESULT)).toBeNull();
    expect((await db.appRun.findUniqueOrThrow({ where: { id: run.id } })).failure).toMatchObject({ code: 'TOOL_FAILED', message: expect.stringContaining('no write access') });
  });
});
