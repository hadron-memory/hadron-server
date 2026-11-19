/**
 * #2883: a run's root trigger, the automation a read grant belongs to (Vera, team chat #66533, Q1 and Q2).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from './id.js';
import { rootTriggerOfRun } from './automationReadGrant.js';
import { testRunAgentId } from '../test/runAgent.js';

let org: { id: string };
let app: { id: string };
let otherApp: { id: string };
const ENTRY = 'hrn:node:example.com:m:flows:entry';

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'RT Org', urn: `rt-${generateId().toLowerCase()}.example` } });
  ({ app } = await createDbAppWithKey(db, 'rt-app', org.id));
  ({ app: otherApp } = await createDbAppWithKey(db, 'rt-other', org.id));
});

const schedule = (appId = app.id) => db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId, name: 'S', cron: '* * * * *', entryNodeUrn: ENTRY } });
const webhook = (appId = app.id) => db.agentWebhook.create({ data: { id: generateId(), organizationId: org.id, appId, name: 'W', secret: generateId(), entryNodeUrn: ENTRY } });
const run = async (triggerKind: 'SCHEDULE' | 'WEBHOOK' | 'MANUAL' | 'SPAWN' | 'INTEGRATION', triggerId: string | null, parentRunId: string | null = null, appId = app.id) =>
  db.appRun.create({ data: { id: generateId(), organizationId: org.id, appId, agentId: await testRunAgentId(db, org.id, appId), triggerKind, triggerId, parentRunId, entryNodeUrn: ENTRY } });

describe('#2883 rootTriggerOfRun', () => {
  it('a schedule run and a webhook run resolve to their own live trigger', async () => {
    const s = await schedule();
    const w = await webhook();
    expect(await rootTriggerOfRun(db, (await run('SCHEDULE', s.id)).id)).toEqual({ kind: 'SCHEDULE', id: s.id });
    expect(await rootTriggerOfRun(db, (await run('WEBHOOK', w.id)).id)).toEqual({ kind: 'WEBHOOK', id: w.id });
  });

  it('SPAWN and INTEGRATION descendants carry the ROOT trigger, through several hops', async () => {
    const s = await schedule();
    const root = await run('SCHEDULE', s.id);
    const child = await run('SPAWN', root.id, root.id);
    const routed = await run('INTEGRATION', generateId(), child.id);
    const grandchild = await run('SPAWN', routed.id, routed.id);
    for (const r of [child, routed, grandchild]) expect(await rootTriggerOfRun(db, r.id)).toEqual({ kind: 'SCHEDULE', id: s.id });
  });

  it('a MANUAL run, and anything descending from one, has no trigger', async () => {
    const manual = await run('MANUAL', null);
    const child = await run('SPAWN', manual.id, manual.id);
    expect(await rootTriggerOfRun(db, manual.id)).toBeNull();
    expect(await rootTriggerOfRun(db, child.id)).toBeNull();
  });

  it('a MANUAL run is its own trigger even when it records a parent: it never inherits a schedule\'s grant', async () => {
    const s = await schedule();
    const root = await run('SCHEDULE', s.id);
    const manual = await run('MANUAL', null, root.id);
    expect(await rootTriggerOfRun(db, manual.id)).toBeNull();
  });

  it('an ancestor run of another App never lends this App\'s trigger, even when its trigger id names one', async () => {
    const mine = await schedule();
    const foreignRoot = await run('SCHEDULE', mine.id, null, otherApp.id);
    const child = await run('SPAWN', foreignRoot.id, foreignRoot.id);
    expect(await rootTriggerOfRun(db, child.id)).toBeNull();
  });

  it('a deleted trigger, a missing trigger id, a missing run, or a trigger of another App resolves to null', async () => {
    const s = await schedule();
    const r = await run('SCHEDULE', s.id);
    await db.agentSchedule.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
    expect(await rootTriggerOfRun(db, r.id)).toBeNull();
    expect(await rootTriggerOfRun(db, (await run('WEBHOOK', null)).id)).toBeNull();
    expect(await rootTriggerOfRun(db, generateId())).toBeNull();
    const foreign = await schedule(otherApp.id);
    expect(await rootTriggerOfRun(db, (await run('SCHEDULE', foreign.id)).id)).toBeNull();
  });

  it('a lineage that crosses into another App, or loops, resolves to null', async () => {
    const s = await schedule(otherApp.id);
    const foreignRoot = await run('SCHEDULE', s.id, null, otherApp.id);
    const child = await run('SPAWN', foreignRoot.id, foreignRoot.id);
    expect(await rootTriggerOfRun(db, child.id)).toBeNull();
    const a = await run('SPAWN', null);
    const b = await run('SPAWN', a.id, a.id);
    await db.appRun.update({ where: { id: a.id }, data: { parentRunId: b.id } });
    expect(await rootTriggerOfRun(db, b.id)).toBeNull();
  });
});
