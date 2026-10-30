import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { generateId } from '../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

export const tickNow2733 = new Date('2026-10-30T02:00:00.000Z');
export const tickTaskLoc2733 = 'tasks:on-tick';
const M = resolvers.Mutation as any;

/** Synthetic, real-Postgres topology: one Team Agent, two roles and a base, no platform-admin principal. */
export async function tickFixture2733() {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  const org = await db.organization.create({ data: { name: 'Tick register', urn: 'tick-' + suffix + '.example' } });
  const admin = await db.user.create({ data: { githubId: 273301, githubUsername: 'tick-admin', roles: ['READER'] } });
  const member = await db.user.create({ data: { githubId: 273302, githubUsername: 'tick-member', roles: ['READER'] } });
  const outside = await db.user.create({ data: { githubId: 273303, githubUsername: 'tick-outside', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const context = (userId = admin.id, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
  async function agent(name: string) {
    const made = await M.createAgent({}, { orgId: org.id, name }, context());
    const row = await db.agent.findUniqueOrThrow({ where: { id: made.id } });
    if (!row.systemMemoryId) throw new Error('Fixture agent has no system memory');
    const memory = await db.memory.findUniqueOrThrow({ where: { id: row.systemMemoryId } });
    return { ...row, systemMemoryId: row.systemMemoryId, memory };
  }
  const team = await agent('Team');
  const base = await agent('Base');
  const roleA = await agent('Role A');
  const roleB = await agent('Role B');
  await db.agent.updateMany({ where: { id: { in: [roleA.id, roleB.id] } }, data: { extendsAgentId: base.id } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Tick team', urn: org.urn + ':team' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  for (const a of [team, base, roleA, roleB]) await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
  const node = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) =>
    db.node.create({ data: { memoryId, loc, name: loc, content: '# Synthetic task', ...extra } });
  await node(team.systemMemoryId, 'roles');
  const entry = (code: string, taskLoc: unknown = tickTaskLoc2733, memoryId = team.systemMemoryId, entryCode = code) =>
    node(memoryId, 'register:' + code, { data: { registerEntry: { code: entryCode, taskLoc } } });
  const worker = (name: string, agentId = roleA.id, heldByUserId: string | null = member.id) =>
    db.worker.create({ data: {
      ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(),
      heldByUserId, heldAt: heldByUserId ? new Date() : null,
    } });
  const ticker = (name: string, extra: Record<string, unknown> = {}, c = context()) =>
    M.createTicker({}, { appRef: app.id, input: {
      name, cadenceSeconds: 600, reasons: ['EVERY_TICK'],
      anchorAt: new Date(tickNow2733.getTime() - 600_000).toISOString(), ...extra,
    } }, c);
  return { org, app, admin, member, outside, team, base, roleA, roleB, context, node, entry, worker, ticker };
}
