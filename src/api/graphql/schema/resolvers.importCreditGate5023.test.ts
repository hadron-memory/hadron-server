/**
 * hadron-server#5023 (Billing A3): `importNode(taskRef:)` mints its run inside the import's own transaction. A launch refused
 * for want of credit refuses the import and writes no node (the composed transaction rolls back, as it does for QUOTA_EXCEEDED),
 * and the gate writes nothing inside that transaction (gate ruling 8a).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { resolvers, type Context } from './resolvers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let ctx: Context, memoryId: string, appId: string, taskId: string, agentId: string;
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Import credit', urn: 'import5023.test' } });
  const user = await db.user.create({ data: { githubId: 502301, githubUsername: 'import5023-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  ctx = { db, userId: user.id, roles: ['ADMIN'], clientId: `user:${user.id}` } as Context;
  memoryId = (await db.memory.create({ data: { name: 'Imports', urn: 'import5023.test:imports', organizationId: org.id, class: 'knowledge' } })).id;
  appId = (await db.app.create({ data: { name: 'Import App', urn: 'import5023.test:app', organizationId: org.id } })).id;
  agentId = (await db.agent.create({ data: { name: 'Importer', urn: 'import5023.test:importer', organizationId: org.id } })).id;
  await db.appAgent.create({ data: { appId, agentId } as never });
  await serveAgentBootPrompt(db, agentId, 'You import.');
  taskId = (await db.node.create({ data: { id: generateId(), memoryId, loc: 'tasks:import', name: 'Import', isRunnable: true, nodeType: 'task', content: 'Process {{importedNodeUrn}}' } })).id;
  // the platform's own default configuration: the run would use the platform key
  const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://import5023.hadron.local' } });
  await db.aiServiceConfig.create({ data: { name: 'default', provider: 'anthropic', model: 'test', hadronServerId: host.id } as never });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const input = () => ({ memoryRef: memoryId, loc: 'clips:refused', content: '# Imported', contentType: 'text/markdown', taskRef: taskId, appRef: appId });

describe('#5023 importNode(taskRef:) at a zero balance', () => {
  it('is refused CREDITS_EXHAUSTED and writes no node, no run and no counter, and the gate wrote no ledger entry', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('BILLING_CREDIT_GATE_ENABLED', 'true');
    await expect(resolvers.Mutation.importNode({}, { input: input() }, ctx)).rejects.toMatchObject({ extensions: { code: 'CREDITS_EXHAUSTED' } });
    expect(await db.node.findUnique({ where: { loc_memoryId: { loc: 'clips:refused', memoryId } } }), 'a refused import must not persist its node').toBeNull();
    expect(await db.appRun.count()).toBe(0);
    expect(await db.quotaCounter.count()).toBe(0);
    expect(await db.creditLedgerEntry.count()).toBe(0);
    expect(writeNodeToGit).not.toHaveBeenCalled();
  });

  it('with the gate switch unset the same import is accepted (green on main: a guard pin)', async () => {
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    const res = await resolvers.Mutation.importNode({}, { input: input() }, ctx);
    expect(res).toBeTruthy();
    expect(await db.node.findUnique({ where: { loc_memoryId: { loc: 'clips:refused', memoryId } } })).not.toBeNull();
  });
});
