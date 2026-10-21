import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #2022 — the stop-signal tools on the MCP surface. The rules are pinned in src/lib/stopSignals/stopSignals2022.test.ts;
 * this covers the SURFACE: a person's write requires a plain session and refuses without one (never inferred,
 * #1697/#1701); a worker's session is refused by the resolver with the GraphQL code; the list reads without a session;
 * refusals arrive as `[code] message` envelopes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';
import { STOP_SIGNAL_WRITE_TOOLS } from './stopSignalTools.js';
import { setS6NoticesAvailableForTest } from '../lib/stopSignals/delivery.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let admin: { id: string };
let holder: { id: string };
let app: { id: string };
let agentId: string;
let anne: { id: string };

const authOf = (userId: string) => ({ userId, roles: ['READER'], clientId: `user:${userId}` }) as AuthContext;
const mcp = (auth: AuthContext) => createTestableMcpServer(auth, { sessionId: `ss-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const code = (t: string) => /^\[([a-z_]+)\]/.exec(t)?.[1].toUpperCase() ?? 'NO_ERROR';
const session = (data: { userId: string; appId?: string; workerId?: string }) =>
  db.session.create({ data: { id: generateId(), ...data, ...(data.workerId ? { agentId } : {}) }, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  const org = await db.organization.create({ data: { id: generateId(), name: 'Stop MCP', urn: `stopmcp-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 182_001, githubUsername: `ss-admin-${n}`, roles: [] } });
  holder = await db.user.create({ data: { githubId: 182_002, githubUsername: `ss-holder-${n}`, roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: admin.id, roles: ['READER'] } as Context)).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Anne', slug: 'anne', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  setS6NoticesAvailableForTest(true); // #2173: setting a signal is refused while the notice lane is off; these tests need it on
});
afterEach(() => setS6NoticesAvailableForTest(false));

describe('stop-signal tools', () => {
  it('every write refuses without a session, and writes nothing', async () => {
    const s = mcp(authOf(admin.id));
    for (const tool of STOP_SIGNAL_WRITE_TOOLS) {
      const r = text(await s.callTool(tool, { appRef: app.id, level: 'PAUSE', scope: 'WORKER', worker: anne.id, id: generateId() }));
      expect({ tool, code: code(r) }).toEqual({ tool, code: 'SESSION_REQUIRED' });
    }
    expect(await db.teamStopSignal.count()).toBe(0);
  });

  it('a plain session sets, lists and lifts as the person; the list reads without a session', async () => {
    const s = mcp(authOf(admin.id));
    const plain = await session({ userId: admin.id });
    const set = text(await s.callTool('hadron_stop_signal_set', { appRef: app.id, level: 'PAUSE', scope: 'WORKER', worker: 'Anne', session: plain.id }));
    expect(set).toMatch(/· PAUSE · worker Anne \(hrn:worker:[^)]*:anne\) · set .* by (@\S+|user \S+) · LIVE · until lifted$/);
    const id = /^- (\S+)/.exec(set)![1];
    expect(text(await s.callTool('hadron_stop_signal_list', { appRef: app.id }))).toContain(id);
    expect(text(await s.callTool('hadron_stop_signal_lift', { appRef: app.id, id, session: plain.id }))).toMatch(/^lifted\n/);
    expect(text(await s.callTool('hadron_stop_signal_lift', { appRef: app.id, id, session: plain.id }))).toMatch(/^unchanged \(already ended\)\n/);
    expect(text(await s.callTool('hadron_stop_signal_list', { appRef: app.id }))).toBe('No stop signals.');
  });

  it('a worker\'s session is refused APP_MANAGER_REQUIRED, though its holder owns the App', async () => {
    const asAnne = await session({ userId: holder.id, appId: app.id, workerId: anne.id });
    const r = text(await mcp(authOf(holder.id)).callTool('hadron_stop_signal_set', { appRef: app.id, level: 'PAUSE_DISPATCH', scope: 'TEAM', worker: 'Anne', session: asAnne.id }));
    expect(code(r)).toBe('APP_MANAGER_REQUIRED');
    expect(await db.teamStopSignal.count()).toBe(0);
  });

  it('#2173: with the notice lane off, hadron_stop_signal_set answers [stop_signal_unavailable] (the GraphQL code), writes nothing, and lift still works', async () => {
    const s = mcp(authOf(admin.id));
    const plain = await session({ userId: admin.id });
    const made = text(await s.callTool('hadron_stop_signal_set', { appRef: app.id, level: 'PAUSE', scope: 'WORKER', worker: 'Anne', session: plain.id })); // lane on
    const id = /^- (\S+)/.exec(made)![1];
    setS6NoticesAvailableForTest(false);
    for (const level of ['PAUSE_DISPATCH', 'PAUSE', 'HALT']) {
      const r = text(await s.callTool('hadron_stop_signal_set', { appRef: app.id, level, scope: 'TEAM', worker: 'Anne', session: plain.id }));
      expect({ level, code: code(r) }).toEqual({ level, code: 'STOP_SIGNAL_UNAVAILABLE' });
    }
    expect(await db.teamStopSignal.count()).toBe(1); // only the one recorded before
    expect(text(await s.callTool('hadron_stop_signal_lift', { appRef: app.id, id, session: plain.id }))).toMatch(/^lifted\n/);
  });
});
