/**
 * #3526 (ruling 0222 option 1, cor:agt:010:01): a read grant never shows a prefix without its URN. On the approval
 * (`AutomationApproval.readGrants`) a target the adopter cannot read has `memoryUrn: null`, and the prefix, a node path inside
 * that memory, is null with it. The rule sits in the shared projection, so the give, revoke and list doors (which pass the
 * target's own row to someone who manages it) keep showing both.
 *
 * Red on main: the approval returns the prefix string next to a null URN. CONTROL cases are green on main by design: they pin
 * what must NOT change.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { automationPinQueries } from './resolvers.automationPin.js';
import { automationReadGrantMutations, automationReadGrantQueries } from './resolvers.automationReadGrant.js';
import { projectAutomationReadGrant } from './automationReadGrantProjection.js';

const Q = automationPinQueries as any;
const GM = automationReadGrantMutations as any;
const GQ = automationReadGrantQueries as any;

async function fixture() {
  const user = await db.user.create({ data: { handle: 'rg3526-owner' } });
  const org = await db.organization.create({ data: { name: 'RG3526', urn: 'rg3526.test' } });
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'RG3526', urn: 'rg3526.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'owner' } });
  const schedule = await db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, userId: user.id, name: 'S', cron: '0 6 * * 1', entryNodeUrn: 'hrn:node:rg3526.test:flow:entry' } });
  const foreign = await db.organization.create({ data: { name: 'Foreign3526', urn: 'foreign3526.test' } });
  const readable = await db.memory.create({ data: { name: 'Know', urn: 'rg3526.test:know', class: 'knowledge', organizationId: org.id } });
  const hidden = await db.memory.create({ data: { name: 'Hid', urn: 'foreign3526.test:hid', class: 'knowledge', organizationId: foreign.id } });
  const ctx = { db, userId: user.id, roles: [] as never[] };
  const base = { appId: app.id, triggerKind: 'SCHEDULE' as const, triggerId: schedule.id, grantedBy: user.id };
  return { user, org, app, schedule, readable, hidden, ctx, base };
}
type F = Awaited<ReturnType<typeof fixture>>;
const approval = (f: F) => Q.automationApproval({}, { triggerKind: 'SCHEDULE', triggerRef: f.schedule.id }, f.ctx);
const shape = (g: any) => [g.memoryUrn, g.prefix];

beforeEach(async () => { await cleanDb(db); });

describe('#3526 the approval: a concealed target shows neither URN nor prefix', () => {
  it('an unreadable target with a prefix returns memoryUrn null AND prefix null; the row is still listed, its other fields unchanged', async () => {
    const f = await fixture();
    const row = await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: f.hidden.id, prefix: 'secret:plans' } });
    const d = await approval(f);
    expect(d.readGrants).toHaveLength(1);
    expect(shape(d.readGrants[0])).toEqual([null, null]);
    expect(d.readGrants[0]).toMatchObject({ id: row.id, appId: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, grantedBy: f.user.id, revokedAt: null, revokedBy: null });
  });

  it('CONTROL: a readable target still returns both the URN and the prefix', async () => {
    const f = await fixture();
    await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: f.readable.id, prefix: 'tasks' } });
    expect((await approval(f)).readGrants.map(shape)).toEqual([['hrn:mem:rg3526.test:know', 'tasks']]);
  });

  it('CONTROL: a readable whole-memory grant (no prefix) shows a null prefix with its URN', async () => {
    const f = await fixture();
    await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: f.readable.id, prefix: null } });
    expect((await approval(f)).readGrants.map(shape)).toEqual([['hrn:mem:rg3526.test:know', null]]);
  });

  it('a prefixed and a whole-memory grant on concealed targets read the same: the adopter cannot tell them apart', async () => {
    const f = await fixture();
    await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: f.hidden.id, prefix: 'secret' } });
    const f2 = await db.memory.create({ data: { name: 'Hid2', urn: 'foreign3526.test:hid2', class: 'knowledge', organizationId: f.hidden.organizationId } });
    await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: f2.id, prefix: null } });
    expect((await approval(f)).readGrants.map(shape)).toEqual([[null, null], [null, null]]);
  });

  it('a soft-deleted target the adopter could otherwise read is concealed too: no URN, so no prefix', async () => {
    const f = await fixture();
    await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: f.readable.id, prefix: 'tasks' } });
    await db.memory.update({ where: { id: f.readable.id }, data: { deletedAt: new Date() } });
    expect((await approval(f)).readGrants.map(shape)).toEqual([[null, null]]);
  });
});

describe('#3526 the grant doors keep showing both to someone who manages the target (CONTROL, green on main)', () => {
  it('give: the answer names the URN and the prefix', async () => {
    const f = await fixture();
    const g = await GM.setAutomationReadGrant({}, { appRef: f.app.id, triggerKind: 'SCHEDULE', triggerId: f.schedule.id, memoryRef: f.readable.id, prefix: 'tasks' }, f.ctx);
    expect(shape(g)).toEqual(['hrn:mem:rg3526.test:know', 'tasks']);
  });

  it('revoke: the answer still names the URN and the prefix', async () => {
    const f = await fixture();
    const row = await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: f.readable.id, prefix: 'tasks' } });
    const g = await GM.revokeAutomationReadGrant({}, { id: row.id }, f.ctx);
    expect(shape(g)).toEqual(['hrn:mem:rg3526.test:know', 'tasks']);
    expect(g.revokedAt).not.toBeNull();
  });

  it('list: an App manager sees the URN and the prefix, including for a soft-deleted target (the historical projection)', async () => {
    const f = await fixture();
    await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: f.readable.id, prefix: 'tasks' } });
    const gone = await db.memory.create({ data: { name: 'Gone', urn: 'rg3526.test:gone', class: 'knowledge', organizationId: f.org.id, deletedAt: new Date() } });
    await db.appAutomationReadGrant.create({ data: { ...f.base, memoryId: gone.id, prefix: 'old:notes' } });
    const rows = await GQ.automationReadGrants({}, { appRef: f.app.id }, f.ctx);
    expect(rows.map(shape).sort()).toEqual([['hrn:mem:rg3526.test:gone', 'old:notes'], ['hrn:mem:rg3526.test:know', 'tasks']]);
  });
});

describe('#3526 the shared projection: the prefix follows the URN, not the caller', () => {
  const row = (prefix: string | null) => ({ id: 'g', appId: 'a', triggerKind: 'SCHEDULE', triggerId: 't', memoryId: 'm', prefix, grantedBy: 'u', createdAt: new Date(0), revokedAt: null, revokedBy: null }) as never;
  it('a null memory nulls the prefix; a present memory keeps it', () => {
    expect(shape(projectAutomationReadGrant(row('x:y'), null))).toEqual([null, null]);
    expect(shape(projectAutomationReadGrant(row('x:y'), { urn: 'rg3526.test:know' }))).toEqual(['hrn:mem:rg3526.test:know', 'x:y']);
    expect(shape(projectAutomationReadGrant(row(null), { urn: 'rg3526.test:know' }))).toEqual(['hrn:mem:rg3526.test:know', null]);
  });
});
