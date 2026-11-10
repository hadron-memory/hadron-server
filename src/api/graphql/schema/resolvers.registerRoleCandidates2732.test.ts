/** #2732: one roster Agent membership batch, with revocation as a sole gate. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { requireReadableAgent } from './resolvers.helpers.js';
import { registerReadableAgents, type RosterGateAgent } from './registerReadableAgents2732.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any;
let userId: string, appId: string, teamId: string, memoryId: string;
const context = (client = db): Context => ({ db: client, userId, roles: ['READER'] });
const pick = (client = db) => resolvers.Query.registerRoleCandidates({}, { appRef: appId, code: 'finish', limit: 200 }, context(client));
beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { handle: `batch-${generateId()}` } })).id;
  const org = await db.organization.create({ data: { name: 'Team', urn: `batch-${generateId().toLowerCase()}.example` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const a = await M.createAgent({}, { orgId: org.id, name: 'Team' }, context());
  teamId = a.id; memoryId = (await db.agent.findUniqueOrThrow({ where: { id: teamId } })).systemMemoryId!;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Batch', urn: `${org.urn}:batch` } })).id;
  await db.appAgent.create({ data: { appId, agentId: teamId } });
  for (const [loc, data, isRunnable] of [['roles', undefined, false], ['register:finish', { registerEntry: { code: 'finish', taskLoc: 'tasks:finish' } }, false], ['tasks:finish', undefined, true]] as const)
    await db.node.create({ data: { memoryId, loc, name: loc, data, isRunnable } });
});
async function rosterOrg(label: string) {
  const org = await db.organization.create({ data: { name: label, urn: `org-${generateId().toLowerCase()}.example` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  return org;
}
async function rosterAgent(orgId: string, name: string) {
  const a = await M.createAgent({}, { orgId, name }, context());
  // Memory gate admits the Team root; the private Agent gate alone distinguishes live membership.
  await db.agent.update({ where: { id: a.id }, data: { systemMemoryId: null, extendsAgentId: teamId } });
  const w = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId: a.id, name, slug: name.toLowerCase() } });
  return { agentId: a.id, workerId: w.id };
}
it('bounds org-membership gate reads to one for twelve distinct Agents across six orgs', async () => {
  const orgIds: string[] = [], wanted: string[] = [];
  for (let i = 0; i < 6; i++) {
    const org = await rosterOrg(`Org ${i}`); orgIds.push(org.id);
    for (let j = 0; j < 2; j++) wanted.push((await rosterAgent(org.id, `w${i}${j}`)).workerId);
  }
  const reads: unknown[] = [];
  const traced = db.$extends({ query: { orgMember: { $allOperations: async ({ args, query }) => {
    const filter = (args as { where?: { organizationId?: string | { in?: string[] } } }).where?.organizationId;
    if (typeof filter === 'string' ? orgIds.includes(filter) : filter?.in?.some(id => orgIds.includes(id))) reads.push(args);
    return query(args);
  } } } }) as unknown as typeof db;
  const result = await pick(traced);
  expect(result.candidates.map(x => x.worker.id).sort()).toEqual(wanted.sort());
  expect(result.depth).toBe(1); expect(result.total).toBe(12);
  expect(reads).toHaveLength(1);
});
it('omits only the Agent behind a revoked membership, with a live admission control', async () => {
  const liveOrg = await rosterOrg('Live'), revokedOrg = await rosterOrg('Revoked');
  const live = await rosterAgent(liveOrg.id, 'live'), revoked = await rosterAgent(revokedOrg.id, 'revoked');
  expect((await pick()).candidates.map(x => x.worker.id).sort()).toEqual([live.workerId, revoked.workerId].sort());
  await db.orgMember.update({ where: { organizationId_userId: { organizationId: revokedOrg.id, userId } }, data: { deletedAt: new Date() } });
  expect((await pick()).candidates.map(x => x.worker.id)).toEqual([live.workerId]);
  await db.orgMember.update({ where: { organizationId_userId: { organizationId: revokedOrg.id, userId } }, data: { deletedAt: null } });
  expect((await pick()).total).toBe(2);
});

it('matches the unchanged singular gate for public, deleted, owner, platform, impersonation and org arms', async () => {
  const live = await rosterOrg('Parity live'), revoked = await rosterOrg('Parity revoked'), deleted = await rosterOrg('Parity deleted');
  await db.orgMember.update({ where: { organizationId_userId: { organizationId: revoked.id, userId } }, data: { deletedAt: new Date() } });
  await db.organization.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
  const row = (id: string, extra: Partial<RosterGateAgent> = {}): RosterGateAgent => ({
    id, visibility: 'ORGANIZATION', deletedAt: null, organizationId: live.id, ownerUserId: null, ...extra,
  });
  const rows = [row('live'), row('revoked', { organizationId: revoked.id }), row('deleted-org', { organizationId: deleted.id }),
    row('foreign', { organizationId: generateId() }), row('own', { organizationId: null, ownerUserId: userId }),
    row('other-owner', { organizationId: null, ownerUserId: generateId() }), row('public', { visibility: 'PUBLIC' }),
    row('deleted-public', { visibility: 'PUBLIC', deletedAt: new Date() })];
  const impersonation = (orgId: string) => ({ sessionId: generateId(), actorUserId: generateId(), orgId, expiresAt: new Date(Date.now() + 60000) });
  const contexts: Context[] = [context(), { db, roles: [] }, { db, userId: generateId(), roles: ['READER'] },
    { db, userId, roles: ['ADMIN'] }, { db, userId, roles: ['OWNER'] },
    { db, userId, roles: [], impersonation: impersonation(live.id) },
    { db, userId, roles: [], impersonation: impersonation(revoked.id) }];
  for (const c of contexts) {
    const canRead = await registerReadableAgents(c, rows);
    for (const a of [...rows, null]) {
      let singular = true;
      try { await requireReadableAgent(c, a, a?.id ?? 'missing'); }
      catch (error) { if (!(error instanceof AgentNotFoundError)) throw error; singular = false; }
      expect(canRead(a?.id ?? 'missing'), `${a?.id ?? 'missing'} / ${JSON.stringify({ user: c.userId, roles: c.roles, impersonation: c.impersonation?.orgId })}`).toBe(singular);
    }
  }
});
it('propagates a failed membership batch instead of concealing an outage as no candidates', async () => {
  const org = await rosterOrg('Outage'); await rosterAgent(org.id, 'outage');
  const broken = db.$extends({ query: { orgMember: { findMany: async ({ args, query }) => {
    if (args.select?.role) throw new Error('membership batch unavailable');
    return query(args);
  } } } }) as unknown as typeof db;
  await expect(pick(broken)).rejects.toThrow('membership batch unavailable');
});
