/**
 * #2969 (cor:agt:040:04, rendered-values bullet and S6): Worker.renderedSignature / renderedTrailer read the filled
 * lines, for exactly the callers Worker.prompt reaches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any, Q = resolvers.Query as any, W = resolvers.Worker as any;
let org: any, app: any, agent: any, admin: any, outsider: any, worker: any;
const ctx = (u = admin, extra: Partial<Context> = {}): Context => ({ db, userId: u.id, roles: ['READER'], ...extra });
const rendered = async (w: any, c: Context) => [await W.renderedSignature(w, {}, c), await W.renderedTrailer(w, {}, c)];
const bind = (llmModel: string | undefined = 'm-1') =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', appRef: app.id, workerRef: worker.id, force: true, llmModel } }, ctx());

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'Rendered', urn: `rnd-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 92969000, githubUsername: `rnd-a-${n}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 92969001, githubUsername: `rnd-o-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Engineer', personaRole: 'engineer' }, ctx());
  await serveAgentBootPrompt(db, agent.id, '{{worker.signature}}\n{{worker.trailer}}');
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Anne' }, ctx());
  worker = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
});

describe('#2969 rendered signature/trailer', () => {
  it('are defined fields', () => {
    expect(typeof W.renderedSignature).toBe('function');
    expect(typeof W.renderedTrailer).toBe('function');
  });

  it('equal the lines of the served boot prompt of the bound session, model included', async () => {
    const s = await bind('model-one');
    const c = ctx(admin, { sessionId: s.session?.id ?? s.id });
    const prompt = (await W.prompt(worker, {}, c)) as string;
    const [sig, trl] = await rendered(worker, c);
    expect(sig).toContain('model-one');
    expect(`${sig}\n${trl}`).toBe(prompt);
    expect(sig).not.toMatch(/\{\{/);
    expect(trl).not.toMatch(/\{\{/);
  });

  it('a role change after the bind does not move the bound session\'s lines (prompt placement)', async () => {
    const s = await bind();
    const c = ctx(admin, { sessionId: s.session?.id ?? s.id });
    const before = await rendered(worker, c);
    await db.worker.update({ where: { id: worker.id }, data: { role: 'reviewer' } });
    const live = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const after = await rendered(live, c);
    expect(after).toEqual(before);
    expect(`${after[0]}\n${after[1]}`).toBe(await W.prompt(live, {}, c));
  });

  it('a rename after the bind does not rewrite the bound session\'s lines (recorded values)', async () => {
    const s = await bind();
    const c = ctx(admin, { sessionId: s.session?.id ?? s.id });
    const before = await rendered(worker, c);
    expect(before[0]).toContain('Anne');
    await db.worker.update({ where: { id: worker.id }, data: { name: 'Renamed' } });
    const live = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await rendered(live, c)).toEqual(before);
    expect((await rendered(live, ctx()))[0]).toContain('Renamed');
  });

  it('an open session with no recorded serve keeps the role it was placed with (prompt placement)', async () => {
    const sess = await db.session.create({ data: { id: generateId(), workerId: worker.id, userId: admin.id, agentId: agent.id, role: 'engineer', type: 'DEVELOPER', tool: 'vitest', startedAt: new Date() } as never });
    await db.worker.update({ where: { id: worker.id }, data: { role: 'reviewer' } });
    const live = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((await rendered(live, ctx(admin, { sessionId: sess.id })))[0]).toContain('[Anne, engineer]');
    expect((await rendered(live, ctx()))[0]).toContain('[Anne, reviewer]');
  });

  it('a stored literal self-reference stays literal, as at bind', async () => {
    await db.worker.update({ where: { id: worker.id }, data: { signature: '{{worker.signature}}|{{worker.name}}', trailer: '{{worker.trailer}}' } });
    const w = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await rendered(w, ctx())).toEqual(['{{worker.signature}}|Anne', '{{worker.trailer}}']);
  });

  it('a worker with no session renders the empty model segment, identical to the prompt', async () => {
    const [sig, trl] = await rendered(worker, ctx());
    expect(sig).toMatch(/^— \[Anne, engineer\]\(.*\) · $/);
    expect(`${sig}\n${trl}`).toBe(await W.prompt(worker, {}, ctx()));
  });

  it('a reader without worker internals gets null for both', async () => {
    expect(await rendered(worker, ctx(outsider))).toEqual([null, null]);
    expect(await rendered(worker, ctx())).not.toEqual([null, null]);
  });

  it('via Query.worker the same caller sees the same values', async () => {
    const w = await Q.worker({}, { ref: worker.id }, ctx());
    expect(await rendered(w, ctx())).toEqual(await rendered(worker, ctx()));
  });
});

describe('#2969 user-owned Agent: exactly the callers Worker.prompt reaches', () => {
  let owner: any, member: any, uapp: any, uworker: any;
  beforeEach(async () => {
    owner = await db.user.create({ data: { githubId: 92969010, githubUsername: `rnd-ow-${generateId()}`, roles: ['READER'] } });
    member = await db.user.create({ data: { githubId: 92969011, githubUsername: `rnd-m-${generateId()}`, roles: ['READER'] } });
    uapp = await db.app.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'mine', urn: `u${generateId().toLowerCase()}:mine` } });
    await db.appMember.create({ data: { appId: uapp.id, userId: owner.id, role: 'owner' } });
    await db.appMember.create({ data: { appId: uapp.id, userId: member.id, role: 'reader' } });
    const uagent = await db.agent.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'Secret role', urn: `own${generateId().toLowerCase()}:secret`, visibility: 'ORGANIZATION' } as never });
    await serveAgentBootPrompt(db, uagent.id, '{{worker.signature}}');
    await db.appAgent.create({ data: { appId: uapp.id, agentId: uagent.id } });
    const mem = await db.memory.create({ data: { id: generateId(), class: 'app', appId: uapp.id, ownerUserId: owner.id, name: 'w', urn: `own${generateId().toLowerCase()}:w` } });
    uworker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, signature: 'sig {{agent.name}}', id: generateId(), appId: uapp.id, agentId: uagent.id, name: 'Uw', slug: 'uw', memoryId: mem.id, heldByUserId: owner.id, heldAt: new Date() } });
  });

  it('a member who is neither owner nor holder gets null although Worker.prompt is null too', async () => {
    expect(await W.prompt(uworker, {}, ctx(member))).toBeNull();
    expect(await rendered(uworker, ctx(member))).toEqual([null, null]);
  });
  it('the owner and the holder get the line', async () => {
    expect((await rendered(uworker, ctx(owner)))[0]).toBe('sig Secret role');
    await db.appMember.update({ where: { appId_userId: { appId: uapp.id, userId: member.id } }, data: { role: 'owner' } });
    await db.worker.update({ where: { id: uworker.id }, data: { heldByUserId: member.id } });
    const held = await db.worker.findUniqueOrThrow({ where: { id: uworker.id } });
    expect((await rendered(held, ctx(member)))[0]).toBe('sig Secret role');
  });
});

describe('#2969 MCP parity', () => {
  it('hadron_get_worker prints the same two values as GraphQL for the same caller', async () => {
    const auth = { userId: admin.id, appId: app.id, roles: ['READER'], clientId: `user:${admin.id}` } as any;
    const out = await createTestableMcpServer(auth).callToolText('hadron_get_worker', { workerRef: 'Anne' });
    const [sig, trl] = await rendered(worker, ctx());
    expect(out).toContain(`\nRendered signature:\n${sig}\n`);
    expect(out).toContain(`\nRendered trailer:\n${trl}\n`);
  });
  it('a non-internals reader sees neither line', async () => {
    const auth = { userId: outsider.id, appId: app.id, roles: ['READER'], clientId: `user:${outsider.id}` } as any;
    const out = await createTestableMcpServer(auth).callToolText('hadron_get_worker', { workerRef: worker.id }).catch((e: Error) => String(e));
    expect(out).not.toContain('Rendered signature');
    expect(out).not.toContain('Rendered trailer');
  });
});
