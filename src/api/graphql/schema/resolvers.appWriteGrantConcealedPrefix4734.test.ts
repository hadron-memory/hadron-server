/**
 * #4734 (Holger's ruling on the issue, extending ruling 0222, hrn:node:hadronmemory.com:specs:cor:agt:010:01:18; the twin
 * of #3526 for READ grants): an App write grant row never shows a `prefix` or a `registerNodeUrn` without its `memoryUrn`.
 * Both name content inside the target memory (a node path, a node URN), so where the projection conceals the memory it
 * withholds them with the URN. A viewer who may see the memory keeps all three.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { GRANT_MEMORY_SELECT } from '../../../lib/appWriteGrant.js';
import { resolvers } from './resolvers.js';
import { project } from './resolvers.appWriteGrant.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
beforeEach(async () => { await cleanDb(db); });

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const PREFIX = 'secret:plans';
const REGISTER = 'concealed4734.test:mine:secret:plans:register';

async function fixture() {
  const org = await db.organization.create({ data: { name: 'Conceal Org', urn: 'concealed4734.test' } });
  const owner = await db.user.create({ data: { handle: 'conceal-owner' } });
  await db.orgMember.create({ data: { userId: owner.id, organizationId: org.id, role: 'ADMIN' } });
  const peer = await db.user.create({ data: { handle: 'conceal-peer' } });
  await db.orgMember.create({ data: { userId: peer.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Conceal App', urn: 'concealed4734.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: peer.id, role: 'owner' } });
  const personal = await db.memory.create({ data: { name: 'mine', urn: 'concealed4734.test:mine', class: 'personal', userId: owner.id, organizationId: org.id } as never });
  const shared = await db.memory.create({ data: { name: 'shared', urn: 'concealed4734.test:shared', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id } as never });
  return { org, owner, peer, app, personal, shared };
}
type F = Awaited<ReturnType<typeof fixture>>;

const rowOn = (f: F, memoryId: string, extra: Record<string, unknown> = {}) =>
  db.appMemoryWriteGrant.create({ data: { appId: f.app.id, memoryId, prefix: PREFIX, registerNodeUrn: REGISTER, grantedBy: f.owner.id, ...extra } });
const as = (u: { id: string }) => ({ db, userId: u.id, roles: [] as never[] });
const projectionInputs = async (f: F, memoryId: string) => ({
  memory: await db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { ...GRANT_MEMORY_SELECT, urn: true } }),
  app: await db.app.findUniqueOrThrow({ where: { id: f.app.id }, select: { id: true, organizationId: true, ownerUserId: true } }),
});

describe('#4734 a concealed write-grant target shows neither prefix nor registerNodeUrn', () => {
  it('revoke by an App manager who cannot see the owner\'s personal memory: row listed, URN, prefix and register URN all null', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    const r = await M.revokeAppMemoryWriteGrant({}, { id: row.id }, as(f.peer));
    expect(r).toMatchObject({ id: row.id, memoryUrn: null, prefix: null, registerNodeUrn: null });
    expect(r.revokedAt).toBeInstanceOf(Date);
  });

  it('the projection withholds both whatever the grant holds: a prefixed grant with a register URN, and one with neither', async () => {
    const f = await fixture();
    const { memory, app } = await projectionInputs(f, f.personal.id);
    const full = await rowOn(f, f.personal.id);
    expect(project(full, memory, app, f.peer.id)).toMatchObject({ memoryUrn: null, prefix: null, registerNodeUrn: null });
    const bare = { ...full, registerNodeUrn: null };
    expect(project(bare, memory, app, f.peer.id)).toMatchObject({ memoryUrn: null, prefix: null, registerNodeUrn: null });
  });

  it('the concealed row keeps its non-content fields (id, grantedBy, createdAt), so the row still lists', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    const { memory, app } = await projectionInputs(f, f.personal.id);
    expect(project(row, memory, app, f.peer.id)).toMatchObject({ id: row.id, appId: f.app.id, grantedBy: f.owner.id, createdAt: row.createdAt });
  });
});

describe('#4734 CONTROLS: a viewer who may see the memory keeps URN, prefix and register URN', () => {
  it('the memory\'s own owner: revoke and list both show all three', async () => {
    const f = await fixture();
    const row = await rowOn(f, f.personal.id);
    const listed = await Q.appMemoryWriteGrants({}, { appRef: f.app.id, includeRevoked: false }, as(f.owner)) as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER });
    expect(listed[0].memoryUrn).not.toBeNull();
    const r = await M.revokeAppMemoryWriteGrant({}, { id: row.id }, as(f.owner));
    expect(r).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER });
    expect(r.memoryUrn).not.toBeNull();
  });

  it('a shared (org) memory: a peer App manager sees all three through list and the projection', async () => {
    const f = await fixture();
    await rowOn(f, f.shared.id);
    const listed = await Q.appMemoryWriteGrants({}, { appRef: f.app.id, includeRevoked: false }, as(f.peer)) as any[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER });
    expect(listed[0].memoryUrn).not.toBeNull();
  });

  it('give returns all three to the owner of a personal memory, and a grant with no register URN shows null for it', async () => {
    const f = await fixture();
    const made = await M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: f.shared.urn, prefix: 'notes:plans' }, as(f.owner));
    expect(made.prefix).toBe('notes:plans');
    expect(made.registerNodeUrn ?? null).toBeNull();
    expect(made.memoryUrn).not.toBeNull();
  });
});
