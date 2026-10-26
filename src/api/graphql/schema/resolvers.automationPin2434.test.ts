/**
 * #2434: the one FORBIDDEN "requires its manager" message hid two read-access causes behind a message that blames who
 * the caller is. Red first: the unreadable-memory refusals fail on main, where all five causes share one text
 * (cor:agt:010:01, "Who re-adopts").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { automationPinQueries, automationPinMutations } from './resolvers.automationPin.js';

const gate = vi.hoisted(() => ({ armed: false, captured: false }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
// The caller's reach can change between the capture and the later memory check: once armed, a direct caller loses
// read access the moment the capture returns. A run principal's reach is untouched.
vi.mock('../../../lib/automation/pins.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../../lib/automation/pins.js')>();
  return { ...real, captureAutomationPin: async (...args: Parameters<typeof real.captureAutomationPin>) => {
    const pin = await real.captureAutomationPin(...args);
    if (gate.armed) gate.captured = true;
    return pin;
  } };
});
vi.mock('../../../mcp/access-control.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../../mcp/access-control.js')>();
  return { ...real, canReadMemory: async (...args: Parameters<typeof real.canReadMemory>) =>
    !(gate.captured && !String(args[1].clientId ?? '').startsWith('run:')) && await real.canReadMemory(...args) };
});
beforeEach(async () => { await cleanDb(db); gate.armed = false; gate.captured = false; });

const Q = automationPinQueries as any;
const M = automationPinMutations as any;
const WHO_MAY_TEXT = /Only the trigger's run-as user may adopt/;

async function fixture() {
  const admin = await db.user.create({ data: { handle: 'readopt-admin' } });
  const org = await db.organization.create({ data: { name: 'Readopt', urn: 'readopt.test' } });
  await db.orgMember.create({ data: { userId: admin.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Readopt', urn: 'readopt.test:app', organizationId: org.id } });
  const memory = await db.memory.create({ data: { name: 'Flow', urn: 'readopt.test:flow', class: 'knowledge', organizationId: org.id } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'entry', name: 'Entry', isRunnable: true, content: 'approved' } });
  const entryNodeUrn = 'hrn:node:readopt.test:flow:entry';
  const appOnly = await db.agentSchedule.create({ data: { id: generateId(), organizationId: org.id, appId: app.id, userId: null, name: 'App-only', cron: '* * * * *', entryNodeUrn } });
  const input = { triggerKind: 'SCHEDULE' as const, triggerRef: appOnly.id };
  const ctx = { db, userId: admin.id, roles: [] as never[] };
  return { admin, org, app, memory, appOnly, input, ctx };
}

describe('#2434 re-adopt refusals name their own cause', () => {
  it('the App cannot read a graph memory: the refusal names the memory and the next step, not a manager role', async () => {
    const f = await fixture();
    const pin = await Q.previewAutomation({}, f.input, f.ctx);
    const err = await M.reAdoptAutomation({}, { ...f.input, expectedHash: pin.hash }, f.ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(err.message).toContain(f.memory.urn);
    expect(err.message).toMatch(/grant the App read access/i);
    expect(err.message).not.toMatch(WHO_MAY_TEXT);
    expect(await db.agentSchedule.findUniqueOrThrow({ where: { id: f.appOnly.id }, select: { automationPin: true } })).toMatchObject({ automationPin: null });
  });

  it('the App\'s reach is the refusal: once the App can read the memory the same call adopts', async () => {
    const f = await fixture();
    await db.memory.update({ where: { id: f.memory.id }, data: { class: 'app', appId: f.app.id } });
    const pin = await Q.previewAutomation({}, f.input, f.ctx);
    expect(await M.reAdoptAutomation({}, { ...f.input, expectedHash: pin.hash }, f.ctx)).toBe(true);
  });

  it('a caller who cannot read the memory is refused without the memory being named', async () => {
    const f = await fixture();
    const pin = await Q.previewAutomation({}, f.input, f.ctx);
    gate.armed = true;
    const err = await Q.previewAutomation({}, f.input, f.ctx).catch((e: unknown) => e);
    gate.armed = false; gate.captured = false;
    expect(err).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(err.message).not.toContain(f.memory.urn);
    expect(err.message).toMatch(/you cannot read/i);
    expect(err.message).not.toMatch(WHO_MAY_TEXT);
    expect(pin.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('a run principal that cannot read a memory the caller cannot read does not learn its name either', async () => {
    const f = await fixture();
    const pin = await Q.previewAutomation({}, f.input, f.ctx);
    gate.armed = true;
    const err = await M.reAdoptAutomation({}, { ...f.input, expectedHash: pin.hash }, f.ctx).catch((e: unknown) => e);
    gate.armed = false; gate.captured = false;
    expect(err).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(err.message).not.toContain(f.memory.urn);
  });

  it('the causes about who the caller is keep the who-may-adopt refusal', async () => {
    const f = await fixture();
    const stranger = await db.user.create({ data: { handle: 'readopt-stranger' } });
    await db.orgMember.create({ data: { userId: stranger.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
    const pin = await Q.previewAutomation({}, f.input, f.ctx);
    for (const ctx of [{ db, userId: stranger.id, roles: [] }, { ...f.ctx, impersonation: { orgId: f.org.id } }, { db, roles: [] }]) {
      const err = await M.reAdoptAutomation({}, { ...f.input, expectedHash: pin.hash }, ctx).catch((e: unknown) => e);
      expect(err).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(err.message).toMatch(WHO_MAY_TEXT);
    }
  });

  it('an unreadable definition at capture stays AUTOMATION_CHANGED and never names the memory', async () => {
    const f = await fixture();
    const other = await db.user.create({ data: { handle: 'readopt-other' } });
    const hidden = await db.memory.create({ data: { name: 'Hidden', urn: 'readopt.test:hidden', class: 'personal', userId: other.id, organizationId: f.org.id } });
    const secret = await db.node.create({ data: { memoryId: hidden.id, loc: 'secret', name: 'Secret', isRunnable: true, content: 'x' } });
    const entry = await db.node.findFirstOrThrow({ where: { memoryId: f.memory.id, loc: 'entry' } });
    await db.edge.create({ data: { memoryId: f.memory.id, sourceId: entry.id, targetId: secret.id, name: 'next', loc: 'entry:next:secret' } });
    const err = await Q.previewAutomation({}, f.input, f.ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'AUTOMATION_CHANGED' });
    expect(err.message).not.toContain(hidden.urn);
  });

  it('the MCP re-adopt tool no longer says only the run-as user can adopt', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../mcp/automationPinTools.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Only the run-as user can adopt/);
    expect(src).toMatch(/App-only trigger/);
  });
});
