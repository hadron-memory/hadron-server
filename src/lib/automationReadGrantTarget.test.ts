/**
 * #2883: which memories an automation's read grant may target (cor:agt:010:01 read-grant rule; Vera, team chat
 * #66533 Q5 and #66572 Q7). Every case is judged by the one function the give door and the read arm share.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../test/helpers.js';
import { generateId } from './id.js';
import { READ_GRANT_MEMORY_SELECT, readGrantTargetRefusal, type ReadGrantApp } from './automationReadGrant.js';
import { WORKER_SIGNATURE_DEFAULTS } from './workerSignature.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
let org: { id: string };
let other: { id: string };
let app: ReadGrantApp;
let otherApp: { id: string };
let installed: { id: string; systemMemoryId: string };
let notInstalled: { id: string; systemMemoryId: string };
let user: { id: string };

const mem = (data: Record<string, unknown>) => db.memory.create({ data: { id: generateId(), name: 'm', urn: `t:${generateId().toLowerCase()}`, ...data } as never });
const refusal = async (memoryId: string) => readGrantTargetRefusal(db, app,
  (await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: READ_GRANT_MEMORY_SELECT })) as never);

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'TG Org', urn: `tg-${generateId().toLowerCase()}.example` } });
  other = await db.organization.create({ data: { id: generateId(), name: 'TG Other', urn: `tgo-${generateId().toLowerCase()}.example` } });
  user = await db.user.create({ data: { id: generateId(), name: 'admin', handle: `tg-${generateId().slice(-6).toLowerCase()}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  const ctx = { db, userId: user.id, roles: ['READER'] } as unknown as Context;
  installed = await M.createAgent({}, { orgId: org.id, name: 'Installed' }, ctx);
  notInstalled = await M.createAgent({}, { orgId: org.id, name: 'Not installed' }, ctx);
  const created = await createDbAppWithKey(db, 'tg-app', org.id);
  app = { id: created.app.id, organizationId: org.id, ownerUserId: null };
  ({ app: otherApp } = await createDbAppWithKey(db, 'tg-other-app', org.id));
  await createDbAppAgent(db, app.id, installed.id);
});

describe('#2883 readGrantTargetRefusal', () => {
  it('system: the own definition of an Agent installed in the App only; judged live (uninstall refuses)', async () => {
    expect(await refusal(installed.systemMemoryId)).toBeNull();
    expect(await refusal(notInstalled.systemMemoryId)).toBe('system-not-installed');
    await db.appAgent.deleteMany({ where: { appId: app.id, agentId: installed.id } });
    expect(await refusal(installed.systemMemoryId)).toBe('system-not-installed');
  });

  it('system: an installed Agent whose pointer names ANOTHER tenant\'s system row admits nothing', async () => {
    const foreignSys = await mem({ class: 'system', organizationId: other.id });
    const rogue = await db.agent.create({ data: { id: generateId(), name: 'Rogue', urn: `${org.id.toLowerCase()}:rogue`, organizationId: org.id, systemMemoryId: foreignSys.id } });
    await createDbAppAgent(db, app.id, rogue.id);
    expect(await refusal(foreignSys.id)).toBe('system-not-installed');
  });

  it('a deleted Agent\'s system memory is refused', async () => {
    await db.agent.update({ where: { id: installed.id }, data: { deletedAt: new Date() } });
    expect(await refusal(installed.systemMemoryId)).toBe('system-not-installed');
  });

  it('an install memory, an encrypted memory, a deleted memory, personal and private are refused', async () => {
    const install = await mem({ class: 'system', organizationId: org.id, appId: app.id, installOfAgentId: installed.id, isInstallMemory: true });
    expect(await refusal(install.id)).toBe('install-memory');
    const enc = await mem({ class: 'knowledge', organizationId: org.id, visibility: 'ORGANIZATION', isEncrypted: true });
    expect(await refusal(enc.id)).toBe('encrypted');
    const gone = await mem({ class: 'knowledge', organizationId: org.id, visibility: 'ORGANIZATION', deletedAt: new Date() });
    expect(await refusal(gone.id)).toBe('deleted');
    const personal = await mem({ class: 'personal', userId: user.id, ownerUserId: user.id });
    const priv = await mem({ class: 'private', userId: user.id, ownerUserId: user.id });
    expect(await refusal(personal.id)).toBe('strict-owner');
    expect(await refusal(priv.id)).toBe('strict-owner');
  });

  it('app class: own team space allowed; a Worker memory, a session memory and another App\'s team space refused', async () => {
    const team = await mem({ class: 'app', organizationId: org.id, appId: app.id });
    expect(await refusal(team.id)).toBeNull();
    const otherTeam = await mem({ class: 'app', organizationId: org.id, appId: otherApp.id });
    expect(await refusal(otherTeam.id)).toBe('other-app-team-space');
    const workerMem = await mem({ class: 'app', organizationId: org.id, appId: app.id });
    await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: installed.id, name: 'W', slug: 'w', memoryId: workerMem.id } });
    expect(await refusal(workerMem.id)).toBe('worker-memory');
    const session = await mem({ class: 'app', organizationId: org.id, appId: app.id, userMemoryOfAgentId: installed.id });
    expect(await refusal(session.id)).toBe('session-memory');
  });

  it('knowledge and group: never past the App tenant\'s own reach (the cap)', async () => {
    const own = await mem({ class: 'knowledge', organizationId: org.id, visibility: 'ORGANIZATION' });
    expect(await refusal(own.id)).toBeNull();
    const foreignOrg = await mem({ class: 'knowledge', organizationId: other.id, visibility: 'ORGANIZATION' });
    expect(await refusal(foreignOrg.id)).toBe('cap');
    const foreignPublic = await mem({ class: 'knowledge', organizationId: other.id, visibility: 'PUBLIC' });
    expect(await refusal(foreignPublic.id)).toBeNull();
    const group = await mem({ class: 'group', organizationId: org.id, visibility: 'GROUP' });
    expect(await refusal(group.id)).toBe('cap');
  });
});
