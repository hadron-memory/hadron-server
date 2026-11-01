/**
 * #2086 — resuming an OPEN session refreshes its model and family (cor:agt:020:03, cor:agt:060:04, #1931/#1948).
 *
 * `resumeOpen` is the one tail of the shed claim, the `session` pick of a live session and the claimless fast
 * path, and it never read the resume input, so a resumed worker kept a null family and read as NO_FAMILY. Pinned
 * per Xylon's CHECKED stamp on the issue:
 *  - all three open paths refresh a supplied model/family after the lifecycle gate permits, in its transaction;
 *  - null or omitted input never clears; tool/host/transcriptPath/plan are never replaced by resume transport values;
 *  - NOTHING_TO_RESUME for an App key or impersonation stays first, even with an invalid family;
 *  - an invalid family from the eligible caller refuses BAD_USER_INPUT BEFORE the claim is consumed;
 *  - a valid request the lifecycle gate refuses still spends its claim, and refreshes nothing;
 *  - a claim lost to a race rolls the refresh back with the touch;
 *  - the rotation control is unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, appId?: string): Context => ({ db, userId, appId, roles: ['READER'] }) as Context;

async function envelope(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return JSON.stringify({ message: g.message, extensions: g.extensions });
  }
  throw new Error('expected a refusal');
}

let app: { id: string; urn: string };
let holder: string;
let other: string;
let ada: string;
let bea: string;

const start = (userId: string, workerRef: string, extra: Record<string, unknown> = {}) =>
  M.startSession({}, { input: { id: generateId(), tool: 'claude-code', appRef: app.id, workerRef, plan: 'work', ...extra } }, ctx(userId));
const claim = (userId: string, sessionId: string) => M.createResumeClaim({}, { sessionId }, ctx(userId));
const resume = (c: Context, input?: Record<string, unknown>) => M.resumeSession({}, { input: input ?? null }, c);
const row = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
const claimRow = (sessionId: string) => db.resumeClaim.findFirstOrThrow({ where: { sessionId }, orderBy: { issuedAt: 'desc' } });
const model = { tool: 'claude-code', llmModel: 'claude-opus-5-5' };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `r2086-${name}-${n}`, roles: ['READER'] }, select: { id: true } }).then((r) => r.id);
  const admin = await u(91, 'admin');
  holder = await u(92, 'holder');
  other = await u(93, 'other');
  const org = await db.organization.create({ data: { name: 'Tenant', urn: `r2086-${n}.example` }, select: { id: true, urn: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  const agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: app.id, userId: holder, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: other, role: 'member' } });
  const w = (name: string) => db.worker.create({ data: { appId: app.id, agentId, name, slug: name.toLowerCase(), signature: '', trailer: '' }, select: { id: true } }).then((r) => r.id);
  ada = await w('Ada');
  bea = await w('Bea');
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

describe('refresh on each open-session path', () => {
  it('1: a shed claim with a model records llmModel and the derived family on the SAME session', async () => {
    const s = await start(holder, ada);
    expect(await row(s.id)).toMatchObject({ llmModel: null, family: null });
    await claim(holder, s.id);
    const r = await resume(ctx(holder), model);
    expect(r.outcome).toBe('RESUMED');
    expect(r.session.id).toBe(s.id);
    expect(await row(s.id)).toMatchObject({ llmModel: 'claude-opus-5-5', family: 'claude', tool: 'claude-code' });
  });

  it('2: an explicit family alone is recorded (normalized)', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    await resume(ctx(holder), { family: ' Claude ' });
    expect(await row(s.id)).toMatchObject({ llmModel: null, family: 'claude' });
  });

  it('3: the claimless fast path refreshes the one live session', async () => {
    const s = await start(holder, ada);
    const r = await resume(ctx(holder), model);
    expect(r.outcome).toBe('RESUMED');
    expect(await row(s.id)).toMatchObject({ llmModel: 'claude-opus-5-5', family: 'claude' });
  });

  it('4: a `session` pick of a live session refreshes it, and only it', async () => {
    const s = await start(holder, ada);
    const t = await start(holder, bea);
    await resume(ctx(holder), { ...model, session: s.id });
    expect(await row(s.id)).toMatchObject({ family: 'claude' });
    expect(await row(t.id)).toMatchObject({ llmModel: null, family: null });
  });

  it('6: a refresh replaces an existing value, and an explicit family wins over the model\'s', async () => {
    const s = await start(holder, ada, { llmModel: 'gpt-5', family: 'codex' });
    expect(await row(s.id)).toMatchObject({ family: 'codex' });
    await resume(ctx(holder), model);
    expect(await row(s.id)).toMatchObject({ llmModel: 'claude-opus-5-5', family: 'claude' });
    await resume(ctx(holder), { llmModel: 'claude-opus-5-5', family: 'glm' });
    expect(await row(s.id)).toMatchObject({ family: 'glm' });
  });

  it('#2252: a resumed model is a report (modelReportedAt stamped, refreshed on a repeat); a model-less resume leaves it alone', async () => {
    const reportedAt = (id: string) => db.session.findUniqueOrThrow({ where: { id }, select: { modelReportedAt: true } }).then((r) => r.modelReportedAt);
    const s = await start(holder, ada);
    expect(await reportedAt(s.id)).toBeNull();
    await resume(ctx(holder), { family: 'claude' });
    expect(await reportedAt(s.id)).toBeNull();
    await resume(ctx(holder), model);
    const first = await reportedAt(s.id);
    expect(first).toBeInstanceOf(Date);
    const old = new Date(Date.now() - 3_600_000);
    await db.session.update({ where: { id: s.id }, data: { modelReportedAt: old } });
    await resume(ctx(holder), { llmModel: null });
    expect(await reportedAt(s.id)).toEqual(old);
    await resume(ctx(holder), model);
    expect((await reportedAt(s.id))!.getTime()).toBeGreaterThan(old.getTime());
  });

  it('a model nothing classifies keeps the existing family rather than guessing', async () => {
    const s = await start(holder, ada, { family: 'claude' });
    await resume(ctx(holder), { llmModel: 'mystery-7' });
    expect(await row(s.id)).toMatchObject({ llmModel: 'mystery-7', family: 'claude' });
  });
});

describe('never clears, never replaces transport provenance', () => {
  it('5: omitted or null model/family leave an existing value alone on all three paths', async () => {
    const s = await start(holder, ada, { llmModel: 'claude-opus-5-5', family: 'claude' });
    await claim(holder, s.id);
    await resume(ctx(holder), { llmModel: null, family: null });
    await resume(ctx(holder));
    await resume(ctx(holder), { session: s.id, llmModel: null });
    expect(await row(s.id)).toMatchObject({ llmModel: 'claude-opus-5-5', family: 'claude' });
    const t = await start(holder, bea);
    await resume(ctx(holder), { session: t.id });
    expect(await row(t.id)).toMatchObject({ llmModel: null, family: null });
  });

  it('8: MCP-shaped transport values never replace tool, host, transcript or plan; family derives from the STORED tool', async () => {
    const s = await start(holder, ada, { host: 'orca', transcriptPath: '/t/a.jsonl' });
    await claim(holder, s.id);
    const before = await row(s.id);
    await resume(ctx(holder), { tool: 'mcp', host: 'elsewhere', transcriptPath: '/t/b.jsonl', description: 'other', llmModel: 'claude-opus-5-5' });
    const after = await row(s.id);
    expect(after).toMatchObject({ tool: 'claude-code', host: before.host, transcriptPath: before.transcriptPath, plan: before.plan });
    expect(after.family).toBe('claude');
  });

  it('a transport tool alone derives nothing: family comes from a supplied model and the STORED tool', async () => {
    const s = await start(holder, ada);
    await resume(ctx(holder), { tool: 'codex', llmModel: null, family: null });
    expect((await row(s.id)).family).toBeNull();
  });
});

describe('stored tool, not transport tool, classifies a model-less derivation', () => {
  it('a blank model falls through to the STORED tool (codex), never the transport tool', async () => {
    const s = await start(holder, ada, { tool: 'codex' });
    await db.session.update({ where: { id: s.id }, data: { family: null } });
    await resume(ctx(holder), { tool: 'claude-code', llmModel: '  ' });
    expect(await row(s.id)).toMatchObject({ family: 'codex' });
  });
});

describe('refusal order and the claim', () => {
  it('12: an App key and an impersonation get NOTHING_TO_RESUME even with an invalid family; nothing changes, the claim survives', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    const none = await envelope(resume(ctx(generateId())));
    const before = await row(s.id);
    for (const input of [{ family: '!!bad!!' }, model]) {
      expect(await envelope(resume({ db, appId: app.id, roles: [] } as unknown as Context, input))).toBe(none);
      expect(await envelope(resume({ ...ctx(holder), impersonation: { actorUserId: other } } as unknown as Context, input))).toBe(none);
    }
    expect(await row(s.id)).toMatchObject({ llmModel: before.llmModel, family: before.family, updatedAt: before.updatedAt });
    expect((await claimRow(s.id)).consumedAt).toBeNull();
  });

  it('7: an invalid family from the eligible caller is BAD_USER_INPUT, writes nothing and does NOT spend the claim', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    const before = await row(s.id);
    expect(await envelope(resume(ctx(holder), { family: '!!bad!!', llmModel: 'claude-opus-5-5' }))).toContain('BAD_USER_INPUT');
    expect(await row(s.id)).toMatchObject({ llmModel: null, family: null, updatedAt: before.updatedAt });
    expect((await claimRow(s.id)).consumedAt).toBeNull();
    const ok = await resume(ctx(holder), model);
    expect(ok.session.id).toBe(s.id);
    expect(await row(s.id)).toMatchObject({ family: 'claude' });
  });

  it('9: a valid request the lifecycle gate refuses still SPENDS its claim and refreshes nothing', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    await db.appMember.deleteMany({ where: { appId: app.id, userId: holder } });
    const before = await row(s.id);
    expect(await envelope(resume(ctx(holder), model))).toContain('RESUME_REFUSED');
    expect((await claimRow(s.id)).consumedAt).not.toBeNull();
    expect(await row(s.id)).toMatchObject({ llmModel: null, family: null, updatedAt: before.updatedAt });
  });

  it('13: a claim lost to a racing redemption rolls the refresh and the touch back', async () => {
    const s = await start(holder, ada);
    await claim(holder, s.id);
    const claimId = (await claimRow(s.id)).id;
    const before = await row(s.id);
    // The rival spends the claim after it was read and before the redemption's transaction consumes it.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== '$transaction') return typeof v === 'function' ? v.bind(target) : v;
        return async (fn: unknown, opts: unknown) => {
          await target.resumeClaim.update({ where: { id: claimId }, data: { consumedAt: new Date() } });
          return (target.$transaction as any)(fn, opts);
        };
      },
    });
    expect(await envelope(resume({ ...ctx(holder), db: racing } as unknown as Context, model))).toContain('NOTHING_TO_RESUME');
    expect(await row(s.id)).toMatchObject({ llmModel: null, family: null, updatedAt: before.updatedAt });
  });
});

describe('controls', () => {
  it('10: a rotation still STARTS a new session carrying the model and family', async () => {
    const s = await start(holder, ada);
    await M.endSession({}, { id: s.id, handoff: 'h', resumeClaim: true }, ctx(holder));
    const r = await resume(ctx(holder), { ...model, description: 'next' });
    expect(r.outcome).toBe('STARTED');
    expect(r.session.id).not.toBe(s.id);
    expect(await row(r.session.id)).toMatchObject({ tool: 'claude-code', llmModel: 'claude-opus-5-5', family: 'claude' });
  });

  it('11: resumeSession and updateSession derive the same family for the same tuples', async () => {
    const tuples: Array<{ tool: string; llmModel?: string; family?: string }> = [
      { tool: 'claude-code', llmModel: 'claude-opus-5-5' },
      { tool: 'claude-code', llmModel: 'glm-4.6' },
      { tool: 'codex', llmModel: 'gpt-5' },
      { tool: 'claude-code', llmModel: 'mystery-7' },
      { tool: 'claude-code', llmModel: 'claude-opus-5-5', family: 'Codex' },
    ];
    for (const t of tuples) {
      const a = await start(holder, ada, { tool: t.tool });
      await resume(ctx(holder), { tool: 'mcp', llmModel: t.llmModel ?? null, family: t.family ?? null });
      const viaResume = await row(a.id);
      await M.endSession({}, { id: a.id }, ctx(holder));
      const b = await start(holder, ada, { tool: t.tool });
      await M.updateSession({}, { id: b.id, llmModel: t.llmModel, family: t.family }, ctx(holder));
      const viaUpdate = await row(b.id);
      expect({ m: viaResume.llmModel, f: viaResume.family }).toEqual({ m: viaUpdate.llmModel, f: viaUpdate.family });
      await M.endSession({}, { id: b.id }, ctx(holder));
    }
  });


});
