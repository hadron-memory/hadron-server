/**
 * #4210 main merge (#4171/#4172 x #4163): the two new departure doors keep the first end of a grant its ACTION's limits ended
 * (cor:acl:140:03, ruling 0259), as the worker door does on main. A boot-prompt edit grant used once (the action's count) or past
 * its hour (the action's lifetime) has already ended, so a person leaving the organization (#4171, endHeldGrants with a scope)
 * and an agent losing its installation (#4172, endAgentGrantsAtApps) stamp only the live grant. The merge first placed main's
 * action-limits clause in endAgentGrantsAtApps alone (the two functions end with the same text), so the org-leave door lost it;
 * both now read one shared fragment.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from './actions.js';
import { endAgentGrantsAtApps, endHeldGrants } from './departure.js';
import { DB_NOW, insertGrantUnguarded, raw, type World } from './grantFixtures3668.js';

const EDIT = 'bootprompt.source.edit';

let admin: { id: string };
let member: { id: string };
let orgId: string;
let appId: string;
let agentId: string;
let nodeId: string;

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'D Org', urn: 'd4210.example' } })).id;
  admin = await db.user.create({ data: { githubId: 421001, githubUsername: 'd-admin', handle: 'd-admin', roles: [] } });
  member = await db.user.create({ data: { githubId: 421002, githubUsername: 'd-member', handle: 'd-member', roles: [] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: member.id, role: 'CONTRIBUTOR' } });
  appId = (await db.app.create({ data: { id: generateId(), name: 'D App', urn: 'd4210.example:app', organizationId: orgId } })).id;
  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'd4210.example:agent-sys', organizationId: orgId } });
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'D agent', urn: 'd4210.example:agent', organizationId: orgId, systemMemoryId: agentMem.id } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  const install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'd4210.example:install', organizationId: orgId, appId, installOfAgentId: agentId, isInstallMemory: true },
  });
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId: install.id, loc: 'boot:s', name: 'S', content: 'c', role: 'boot-prompt' } })).id;
});

const world = () => ({ appId, userId: admin.id } as unknown as World);
/** An activated edit grant with NO count of its own (max_uses NULL): only the ACTION's limits can end it. */
const grant = (holder: Record<string, unknown>, over: Record<string, unknown> = {}) => insertGrantUnguarded(world(), {
  user_id: null, action: EDIT, action_values: { sourceNode: nodeId }, max_uses: null, expires_at: null,
  activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id, ...holder, ...over,
} as never);
const departedAt = async (id: string) => (await db.grant.findUniqueOrThrow({ where: { id } })).holderDepartedAt;

/** Three grants of one holder: used once (the action's count), past its hour (the action's lifetime), and live. */
async function threeGrants(holder: Record<string, unknown>) {
  return {
    used: await grant(holder, { use_count: 1 }),
    timedOut: await grant(holder, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`) }),
    live: await grant(holder),
  };
}
async function expectOnlyLiveEnded(g: Awaited<ReturnType<typeof threeGrants>>, ended: number) {
  expect(ended).toBe(1);
  expect(await departedAt(g.used)).toBeNull();
  expect(await departedAt(g.timedOut)).toBeNull();
  expect(await departedAt(g.live)).not.toBeNull();
}

describe('#4210: the new departure doors keep the first end of a grant its action\'s limits ended', () => {
  it('#4171 org leave: a person\'s used and timed-out edit grants keep their first end; the live one is stamped', async () => {
    const g = await threeGrants({ user_id: member.id });
    await db.orgMember.updateMany({ where: { organizationId: orgId, userId: member.id }, data: { deletedAt: new Date() } });
    const ended = await db.$transaction((tx) => endHeldGrants(tx, 'user', member.id, { organizationId: orgId }));
    await expectOnlyLiveEnded(g, ended);
  });

  it('#4172 uninstall: an agent\'s used and timed-out edit grants keep their first end; the live one is stamped', async () => {
    const g = await threeGrants({ agent_id: agentId });
    await db.appAgent.deleteMany({ where: { appId, agentId } });
    const ended = await db.$transaction((tx) => endAgentGrantsAtApps(tx, [{ appId, agentId }]));
    await expectOnlyLiveEnded(g, ended);
  });
});
