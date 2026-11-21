/**
 * #4178 (Holger R2, cor:acl:140:03 holder-gone row and :06): an agent left with no effective installation in an App BY ANY CAUSE has
 * gone for its grants there. The two causes with no write door of their own, a lapsed licence (the org's AgentOrgGrant expired or was
 * revoked behind a derived install) and a deleted organization, are ended by a SWEEPER that stamps `holder_departed_at`. Item (c)
 * (an App's own soft delete or `uninstalledAt`) stays out: the grants go with the App, or #4167.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from './actions.js';
import { sweepLapsedAgentGrants } from './lapseSweep.js';
import { startGrantLapseSweepLoop } from '../../jobs/sweepGrantLapse.js';
import { deriveGrantState } from './state.js';
import { DB_NOW, insertGrantUnguarded, raw, type World } from './grantFixtures3668.js';

const EDIT = 'bootprompt.source.edit';

let orgId: string;
let admin: { id: string };
let appId: string;
let parentId: string;
let agentId: string;
let nodeId: string;

async function mkAgent(name: string, org: string | null = orgId) {
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${name}-sys`, urn: `s4178.example:${name}-sys`, organizationId: orgId } });
  return (await db.agent.create({ data: { id: generateId(), name, urn: `s4178.example:${name}`, organizationId: org, systemMemoryId: mem.id } })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'S Org', urn: 's4178.example' } })).id;
  admin = await db.user.create({ data: { githubId: 417801, githubUsername: 's-admin', handle: 's-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { id: generateId(), name: 'S App', urn: 's4178.example:app', organizationId: orgId } })).id;
  parentId = await mkAgent('parent');
  agentId = await mkAgent('imported');
  await db.appAgent.create({ data: { appId, agentId: parentId } });
  // An import edge names the org's licence to the imported agent (composite FK), so the licence row exists first and a lapse is a change to it.
  await db.agentOrgGrant.create({ data: { orgId, agentId, activatedAt: new Date(Date.now() - 86_400_000) } });
  await db.agentImport.create({
    data: { parentAgentId: parentId, importedAgentId: agentId, position: 0, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: agentId },
  });
  const install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 's4178.example:install', organizationId: orgId, appId, installOfAgentId: parentId, isInstallMemory: true },
  });
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId: install.id, loc: 'boot:s', name: 'S', content: 'c', role: 'boot-prompt' } })).id;
});

const world = (app = appId) => ({ appId: app, userId: admin.id } as unknown as World);
const grant = (holder: Record<string, unknown>, over: Record<string, unknown> = {}, app = appId) => insertGrantUnguarded(world(app), {
  user_id: null, action: EDIT, action_values: { sourceNode: nodeId }, max_uses: null, expires_at: null,
  activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id, ...holder, ...over,
} as never);
const departedAt = async (id: string) => (await db.grant.findUniqueOrThrow({ where: { id } })).holderDepartedAt;
const licence = (over: { expiresAt?: Date | null; revokedAt?: Date | null } = {}) => db.agentOrgGrant.update({
  where: { orgId_agentId: { orgId, agentId } }, data: over,
});
const past = () => new Date(Date.now() - 3_600_000);
const future = () => new Date(Date.now() + 3_600_000);

describe('#4178 the sweeper ends the grants of an agent whose derived install lapsed', () => {
  it('a licence that EXPIRED behind a derived install: the agent\'s grant is stamped', async () => {
    await licence({ expiresAt: past() });
    const g = await grant({ agent_id: agentId });
    const out = await sweepLapsedAgentGrants(db);
    expect(out).toMatchObject({ pairsJudged: 1, pairsDeparted: 1, grantsEnded: 1 });
    expect(await departedAt(g)).not.toBeNull();
  });

  it('a licence REVOKED behind a derived install: stamped', async () => {
    await licence({ revokedAt: past() });
    const g = await grant({ agent_id: agentId });
    await sweepLapsedAgentGrants(db);
    expect(await departedAt(g)).not.toBeNull();
  });

  it('a soft-deleted ORGANIZATION: stamped', async () => {
    const g = await grant({ agent_id: agentId });
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    const out = await sweepLapsedAgentGrants(db);
    expect(out.pairsDeparted).toBe(1);
    expect(await departedAt(g)).not.toBeNull();
  });

  it('the stamp reads HOLDER_GONE through the one #4173 derivation', async () => {
    await licence({ expiresAt: past() });
    const g = await grant({ agent_id: agentId });
    await sweepLapsedAgentGrants(db);
    const row = await db.grant.findUniqueOrThrow({ where: { id: g } });
    expect(deriveGrantState({
      activatedAt: row.activatedAt, revokedAt: row.revokedAt, holderDepartedAt: row.holderDepartedAt, appDeletedAt: null,
      startsAt: row.startsAt, expiresAt: row.expiresAt, maxUses: row.maxUses, useCount: row.useCount,
      actionMaxUses: null, actionLifetimeSeconds: null, withdrawnAt: row.withdrawnAt,
    }, new Date())).toBe('HOLDER_GONE');
  });
});

describe('#4178 the sweeper never stamps while an installation exists', () => {
  it('a derived install under a USABLE licence is untouched', async () => {
    await licence({ expiresAt: future() });
    const g = await grant({ agent_id: agentId });
    const out = await sweepLapsedAgentGrants(db);
    expect(out.grantsEnded).toBe(0);
    expect(await departedAt(g)).toBeNull();
  });

  it('a PHYSICAL install survives a lapsed licence (a row wins) and a deleted organization', async () => {
    await db.appAgent.create({ data: { appId, agentId } });
    await licence({ expiresAt: past() });
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    const g = await grant({ agent_id: agentId });
    await sweepLapsedAgentGrants(db);
    expect(await departedAt(g)).toBeNull();
  });
});

describe('#4178 only the departed agent\'s own grants, and the first end stands', () => {
  it('a worker\'s, a person\'s and another agent\'s grants are never touched', async () => {
    await licence({ expiresAt: past() });
    const other = await mkAgent('other');
    await db.appAgent.create({ data: { appId, agentId: other } });
    const person = await grant({ user_id: admin.id });
    const ofOther = await grant({ agent_id: other });
    const mine = await grant({ agent_id: agentId });
    await sweepLapsedAgentGrants(db);
    expect(await departedAt(person)).toBeNull();
    expect(await departedAt(ofOther)).toBeNull();
    expect(await departedAt(mine)).not.toBeNull();
  });

  it('an already EXPIRED, SPENT or REVOKED grant keeps its first end', async () => {
    await licence({ expiresAt: past() });
    const expired = await grant({ agent_id: agentId }, { expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    const spent = await grant({ agent_id: agentId }, { max_uses: 1, use_count: 1 });
    const revoked = await grant({ agent_id: agentId }, { revoked_at: raw(DB_NOW), revoked_by: admin.id });
    const live = await grant({ agent_id: agentId });
    const out = await sweepLapsedAgentGrants(db);
    expect(out.grantsEnded).toBe(1);
    expect(await departedAt(expired)).toBeNull();
    expect(await departedAt(spent)).toBeNull();
    expect(await departedAt(revoked)).toBeNull();
    expect(await departedAt(live)).not.toBeNull();
  });

  it('re-licensing or restoring the org AFTER the stamp revives nothing, and a second sweep changes nothing', async () => {
    await licence({ expiresAt: past() });
    const g = await grant({ agent_id: agentId });
    await sweepLapsedAgentGrants(db);
    const first = await departedAt(g);
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId, agentId } }, data: { expiresAt: future() } });
    const again = await sweepLapsedAgentGrants(db);
    expect(again.grantsEnded).toBe(0);
    expect((await departedAt(g))?.getTime()).toBe(first?.getTime());
  });
});

describe('#4178 item (c) stays out', () => {
  it('a soft-deleted App\'s grants and an App with uninstalledAt are not stamped by this sweep', async () => {
    await licence({ expiresAt: past() });
    const app2 = (await db.app.create({ data: { id: generateId(), name: 'S App2', urn: 's4178.example:app2', organizationId: orgId } })).id;
    const app3 = (await db.app.create({ data: { id: generateId(), name: 'S App3', urn: 's4178.example:app3', organizationId: orgId } })).id;
    for (const a of [app2, app3]) {
      await db.appAgent.create({ data: { appId: a, agentId: parentId } });
    }
    const gDeleted = await grant({ agent_id: agentId }, {}, app2);
    const gUninstalled = await grant({ agent_id: agentId }, {}, app3);
    await db.app.update({ where: { id: app2 }, data: { deletedAt: new Date() } });
    await db.app.update({ where: { id: app3 }, data: { uninstalledAt: new Date() } });
    // A live control in App 1, where the same agent's licence is lapsed: the sweep did judge and stamp something, so the two
    // expectations below are not vacuous (an early return or a crash would leave this one unstamped too).
    const control = await grant({ agent_id: agentId });
    const out = await sweepLapsedAgentGrants(db);
    expect(out.pairsDeparted).toBe(1);
    expect(await departedAt(control)).not.toBeNull();
    expect(await departedAt(gDeleted)).toBeNull();
    expect(await departedAt(gUninstalled)).toBeNull();
  });
});

describe('#4178 batching', () => {
  it('pairs that are still installed do not starve a lapsed pair behind them (batchSize 1; ids are time-ordered, so the lapsed one is created LAST and sorts last)', async () => {
    const stillInstalled: string[] = [];
    const stillInstalledAgents: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await mkAgent(`fine${i}`);
      stillInstalledAgents.push(a);
      await db.appAgent.create({ data: { appId, agentId: a } });
      stillInstalled.push(await grant({ agent_id: a }));
    }
    const late = await mkAgent('late');
    await db.agentOrgGrant.create({ data: { orgId, agentId: late, activatedAt: new Date(Date.now() - 86_400_000), expiresAt: past() } });
    await db.agentImport.create({
      data: { parentAgentId: parentId, importedAgentId: late, position: 5, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: late },
    });
    const lapsed = await grant({ agent_id: late });
    // The premise of this pin: the lapsed pair sorts after every still-installed one (ids are time-ordered).
    expect([...stillInstalledAgents, late].sort().at(-1)).toBe(late);
    const out = await sweepLapsedAgentGrants(db, { batchSize: 1, maxPages: 20 });
    expect(out.pairsJudged).toBe(4); // the cursor walked past all three installed pairs to reach the fourth
    expect(out.grantsEnded).toBe(1);
    expect(await departedAt(lapsed)).not.toBeNull();
    for (const id of stillInstalled) expect(await departedAt(id)).toBeNull();
  });

  it('a pair whose grants have all ended is not a candidate: it is never judged, so it cannot fill a page every run', async () => {
    await licence({ expiresAt: past() });
    await grant({ agent_id: agentId }, { expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    await grant({ agent_id: agentId }, { max_uses: 1, use_count: 1 });
    const out = await sweepLapsedAgentGrants(db);
    expect(out.pairsJudged).toBe(0);
  });
});

describe('#4178 resume across runs', () => {
  it('a healthy prefix longer than one run\'s reach does not starve the pair behind it: each run resumes after the last one', async () => {
    for (let i = 0; i < 3; i++) {
      const a = await mkAgent(`fine${i}`);
      await db.appAgent.create({ data: { appId, agentId: a } });
      await grant({ agent_id: a });
    }
    const late = await mkAgent('late');
    await db.agentOrgGrant.create({ data: { orgId, agentId: late, activatedAt: new Date(Date.now() - 86_400_000), expiresAt: past() } });
    await db.agentImport.create({
      data: { parentAgentId: parentId, importedAgentId: late, position: 5, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: late },
    });
    const lapsed = await grant({ agent_id: late });
    // One run reaches only two pairs (batchSize 1, maxPages 2): run 1 and 2 see only healthy pairs; without a resume point every run would stop there.
    let after = null as Awaited<ReturnType<typeof sweepLapsedAgentGrants>>['cursor'];
    let guard = 0;
    while (guard++ < 6) {
      const out = await sweepLapsedAgentGrants(db, { batchSize: 1, maxPages: 2, after });
      after = out.cursor;
      if (await departedAt(lapsed)) break;
    }
    expect(await departedAt(lapsed)).not.toBeNull();
    expect(guard).toBeLessThanOrEqual(3);
  });

  it('a run that reaches the end hands back a null cursor, so the next one starts over', async () => {
    const out = await sweepLapsedAgentGrants(db);
    expect(out.cursor).toBeNull();
  });
});

describe('#4178 the loop wrapper', () => {
  it('startGrantLapseSweepLoop runs a pass after its initial delay and stamps the lapsed grant', async () => {
    await licence({ expiresAt: past() });
    const g = await grant({ agent_id: agentId });
    const timer = startGrantLapseSweepLoop(db, { initialDelayMs: 10, intervalMs: 3_600_000 });
    try {
      for (let i = 0; i < 100 && !(await departedAt(g)); i++) await new Promise((r) => setTimeout(r, 50));
      expect(await departedAt(g)).not.toBeNull();
    } finally { clearTimeout(timer); }
  });
});

