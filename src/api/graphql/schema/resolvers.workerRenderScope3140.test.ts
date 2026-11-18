/**
 * #3140 Slice A (test-only): pins on the recorded-serve lookups behind Worker.prompt / renderedSignature / renderedTrailer.
 * No production line changes here; every pin below names the mutant that turns it red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any, W = resolvers.Worker as any;
let org: any, app: any, agent: any, admin: any, workerA: any, workerB: any;
const ctx = (extra: Partial<Context> = {}): Context => ({ db, userId: admin.id, roles: ['READER'], ...extra });
const bind = async (worker: any, llmModel: string) => {
  const s = await M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: worker.id, force: true, llmModel } }, ctx());
  return (s.session?.id ?? s.id) as string;
};
const outputs = async (w: any, c: Context) => ({
  signature: await W.renderedSignature(w, {}, c) as string | null,
  trailer: await W.renderedTrailer(w, {}, c) as string | null,
  prompt: await W.prompt(w, {}, c) as string | null,
});
const cast = async (name: string) => {
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name }, ctx());
  return db.worker.findUniqueOrThrow({ where: { id: made.id } });
};

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Scope3140', urn: `s3140-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 93140000, githubUsername: `s3140-a-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Engineer', personaRole: 'engineer' }, ctx());
  await serveAgentBootPrompt(db, agent.id, '{{worker.signature}}\n{{worker.trailer}}');
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  workerA = await cast('Anna');
  workerB = await cast('Berta');
});

describe('#3140 item 1: the recorded serve is scoped to the worker being read (workerId, both lookup sites)', () => {
  // Mutants: (m1) drop `workerId` from the servedPrompt.findFirst in renderWorkerLines; (m2) drop it from the one in
  // readServedWorkerText; (m3) fill B's {{session.llmModel}} from the reading session's model.
  for (const withOwnSession of [false, true]) {
    it(`reading B under A's bound session shows B (${withOwnSession ? 'B has its own open session, model-B' : 'B has no open session, empty model segment'}), never A's record`, async () => {
      const sessionA = await bind(workerA, 'model-A');
      const sessionB = withOwnSession ? await bind(workerB, 'model-B') : null;
      const asA = ctx({ sessionId: sessionA });
      const readB = await outputs(workerB, asA);
      // The control: B read with no session at all, or under its own session.
      const expected = await outputs(workerB, ctx(sessionB ? { sessionId: sessionB } : {}));
      expect(readB.signature).toContain('Berta');
      expect(readB.signature).toContain('engineer');
      expect(readB.signature).not.toContain('Anna');
      expect(readB.signature).toMatch(withOwnSession ? / · model-B$/ : / · $/);
      for (const text of [readB.signature, readB.trailer, readB.prompt]) {
        expect(text).not.toContain('model-A');
        expect(text).not.toContain('Anna');
      }
      expect(readB).toEqual(expected);
      expect(readB.prompt).toBe(`${readB.signature}\n${readB.trailer}`);
      // A under the same ctx still reads its own recorded values.
      const readA = await outputs(workerA, asA);
      expect(readA.signature).toContain('Anna');
      expect(readA.signature).toContain('model-A');
      expect(readA.prompt).toBe(`${readA.signature}\n${readA.trailer}`);
    });
  }
});

describe('#3140 item 2: an ENDED session read straight through the resolver (built-as, outside cor:agt:040:04)', () => {
  // Current built behaviour that cor:agt:040:04 does not decide (the rule speaks of a bound session and of the worker's
  // newest open session, not an ended one). Direct-resolver defence-in-depth only: validateSessionBinding admits only
  // live, owned, non-dormant sessions, so this is not a reachable principal, not a lifecycle or admission rule, and no
  // evidence for either answer if the state ever becomes reachable. Changing this undefined state needs no spec change.
  it('built-as: an ended session with a record still fills signature, trailer and prompt from the record', async () => {
    const sessionA = await bind(workerA, 'model-A');
    const before = await outputs(workerA, ctx({ sessionId: sessionA }));
    await db.session.update({ where: { id: sessionA }, data: { endedAt: new Date() } });
    await db.worker.update({ where: { id: workerA.id }, data: { name: 'Renamed', role: 'reviewer' } });
    const live = await db.worker.findUniqueOrThrow({ where: { id: workerA.id } });
    const ended = await outputs(live, ctx({ sessionId: sessionA }));
    // No `endedAt` filter on the recorded lookup: the record's variables still win over today's values.
    expect(ended.signature).toBe(before.signature);
    expect(ended.trailer).toBe(before.trailer);
    expect(ended.prompt).toBe(before.prompt);
    expect(ended.signature).toContain('model-A');
    expect(ended.signature).not.toContain('Renamed');
    expect(ended.prompt).not.toContain('Renamed');
    // Only the recorded-value behaviour is pinned; the live row is what an unbound read shows, observed here without
    // describing it as the served prompt's lines.
    const open = await outputs(live, ctx());
    expect(open.signature).toContain('Renamed');
  });

  it('built-as: an ended session with no record falls through to the live serve, not SESSION_UNRECORDED', async () => {
    const sess = await db.session.create({ data: { id: generateId(), workerId: workerA.id, userId: admin.id, agentId: agent.id, role: 'engineer', type: 'DEVELOPER', tool: 'vitest', startedAt: new Date() } as never });
    // Control: while OPEN with no record the read is the typed no-briefing notice.
    expect((await outputs(workerA, ctx({ sessionId: sess.id }))).prompt).toBeNull();
    await db.session.update({ where: { id: sess.id }, data: { endedAt: new Date() } });
    const ended = await outputs(workerA, ctx({ sessionId: sess.id }));
    expect(ended.prompt).not.toBeNull();
    expect(ended.prompt).toBe((await outputs(workerA, ctx())).prompt);
  });
});
