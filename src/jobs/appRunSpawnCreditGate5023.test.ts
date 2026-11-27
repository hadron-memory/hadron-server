/**
 * hadron-server#5023 (Billing A3): `hadron_spawn` mints its children through the real launch gate, so an item refused for want of
 * credit is recorded among the denials as `CREDITS_EXHAUSTED: ...` (a denial is data, D-SP-5; a fan-out that fans out nothing
 * is a malfunction and throws with the reasons).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { serveAgentBootPrompt } from '../test/servedBootPrompt.js';
import { CREDITS_EXHAUSTED_MESSAGE } from '../lib/metering/gate.js';

vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

import { mintAppRun } from './appRuns.js';
import { runContext } from './appRunDeps.js';
import { hadronSpawn } from '../lib/runner/tools/index.js';

let orgId: string, appId: string, agentId: string;
beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'spawn-cg-org', urn: 'spawn-cg-org' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: orgId, name: 'spawn-cg-app', urn: 'spawn-cg-org::spawn-cg-app' } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'spawn-cg-agent', urn: 'spawn-cg-org:spawn-cg-agent' } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await serveAgentBootPrompt(db, agentId, 'Test boot prompt.');
  const host = await db.hadronServer.create({ data: { id: generateId(), url: 'https://spawn-cg.hadron.local' } });
  await db.aiServiceConfig.create({ data: { name: 'default', provider: 'anthropic', model: 'test', hadronServerId: host.id } as never });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('#5023 hadron_spawn at a zero balance', () => {
  it('every item is refused CREDITS_EXHAUSTED: the fan-out throws, naming the code, and mints no child', async () => {
    // the parent launches while the gate is off, as a run that started with credit would have
    const parent = await mintAppRun(db, { organizationId: orgId, appId, agentId, triggerKind: 'MANUAL', entryNodeUrn: 'spawn-cg-org::m::flow:digest', eventData: { topic: 'x' } });
    vi.stubEnv('BILLING_DEBIT_ENABLED', 'true');
    vi.stubEnv('BILLING_CREDIT_GATE_ENABLED', 'true');
    const ctx = { log: vi.fn(), db, run: parent, principal: runContext(db, parent) };
    await expect(hadronSpawn.execute(ctx, { items: ['a', 'b'], process_item: 'spawn-cg-org::m::flow:item', item_key: 'note' } as never))
      .rejects.toThrow(`CREDITS_EXHAUSTED: ${CREDITS_EXHAUSTED_MESSAGE}`);
    expect(await db.appRun.count({ where: { parentRunId: parent.id } })).toBe(0);
  });
});
