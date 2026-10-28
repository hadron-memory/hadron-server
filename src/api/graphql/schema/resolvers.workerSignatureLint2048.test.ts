/** #2048 S11c: Worker.signatureLint warns, never blocks, when a signature or trailer lacks the worker link (cor:agt:040:04 S3, cor:agt:040:13 S5). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any, W = resolvers.Worker as any;
let org: any, app: any, agent: any, admin: any, member: any, outsider: any, worker: any;
const ctx = (u = admin, extra: Partial<Context> = {}): Context => ({ db, userId: u.id, roles: ['READER'], ...extra });
const update = (args: object, c = ctx()) => M.updateWorker({}, { workerRef: worker.id, ...args }, c);
const row = () => db.worker.findUniqueOrThrow({ where: { id: worker.id } }) as Promise<any>;
const lint = async (c = ctx(), args: object = {}) => W.signatureLint(await row(), args, c);
const fields = (page: any) => page.items.map((w: any) => `${w.kind}:${w.workerField}`);

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().toLowerCase();
  org = await db.organization.create({ data: { name: 'SigLint', urn: `siglint-${n}.example` } });
  const user = (i: number) => db.user.create({ data: { githubId: 92048000 + i, githubUsername: `siglint-${i}`, roles: ['READER'] } });
  [admin, member, outsider] = await Promise.all([0, 1, 2].map(user));
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Engineer', personaRole: 'engineer', systemPrompt: 'x' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const made = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Anne' }, ctx());
  worker = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
});

describe('#2048 S11c Worker.signatureLint', () => {
  it('the cast defaults carry the link: an empty page, not null', async () => {
    expect(await lint()).toEqual({ items: [], total: 0, nextCursor: null });
  });

  it('a signature that drops the link warns for the signature only, and the edit is saved', async () => {
    const saved = await update({ signature: 'AI worker for Acme' });
    expect(saved.signature).toBe('AI worker for Acme');
    const page = await lint();
    expect(fields(page)).toEqual(['WORKER_LINK_MISSING:signature']);
    expect(page.items[0]).toMatchObject({ position: 0, targetUrn: null, pinnedRevision: null, newerRevision: null, overriddenNodeLoc: null });
    expect(page.total).toBe(1);
  });

  it('a trailer that drops the link warns for the trailer only', async () => {
    await update({ trailer: 'Worker: Anne' });
    expect(fields(await lint())).toEqual(['WORKER_LINK_MISSING:trailer']);
  });

  it('both missing: signature first, then trailer', async () => {
    await update({ signature: 'a', trailer: 'b' });
    expect(fields(await lint())).toEqual(['WORKER_LINK_MISSING:signature', 'WORKER_LINK_MISSING:trailer']);
  });

  it('a blank value delivers nothing, so the link is missing (cor:agt:040:04 D8)', async () => {
    await update({ signature: '  ', trailer: '' });
    expect(fields(await lint())).toEqual(['WORKER_LINK_MISSING:signature', 'WORKER_LINK_MISSING:trailer']);
  });

  it('the link variable anywhere in the value counts', async () => {
    await update({ signature: 'prefix {{worker.url}} suffix', trailer: 'x' });
    expect(fields(await lint())).toEqual(['WORKER_LINK_MISSING:trailer']);
  });

  it('the edit payload carries the same warnings as the later read (R19)', async () => {
    const saved = await update({ signature: 'no link' });
    expect(await W.signatureLint(saved, {}, ctx())).toEqual(await lint());
  });

  it('stale warnings clear when the link comes back (R46)', async () => {
    await update({ signature: 'no link' });
    expect((await lint()).total).toBe(1);
    await update({ signature: 'back [{{worker.name}}]({{worker.url}})' });
    expect(await lint()).toEqual({ items: [], total: 0, nextCursor: null });
  });

  it('pages: first clamps and the cursor is deterministic', async () => {
    await update({ signature: 'a', trailer: 'b' });
    const one = await lint(ctx(), { first: 1 });
    expect(one.items).toHaveLength(1);
    expect(one.total).toBe(2);
    expect(one.nextCursor).toBeTruthy();
    const two = await lint(ctx(), { first: 1, after: one.nextCursor });
    expect(fields(two)).toEqual(['WORKER_LINK_MISSING:trailer']);
    expect(two.nextCursor).toBeNull();
  });

  it('a reader who cannot see the working-state fields gets null (unavailable), never an empty page or the warnings', async () => {
    await update({ signature: 'no link' });
    expect(await lint(ctx(outsider))).toBeNull();
    expect(await W.signature(await row(), {}, ctx(outsider))).toBeNull();
  });

  it('a lint fault is null, never an empty page, and never fails the read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...(await row()), signature: undefined, trailer: undefined, slug: 'x'.repeat(1) };
    const out = await W.signatureLint({ ...broken, appId: app.id, signature: 5 as any }, {}, ctx());
    expect(out).toBeNull();
    spy.mockRestore();
  });

  it('a fault in the read-gate lookup is null too, and a committed update stays saved', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await update({ signature: 'no link' });
    const spy = vi.spyOn(db.app, 'findUnique').mockRejectedValueOnce(new Error('GATE_LOOKUP_FAULT'));
    try {
      await expect(W.signatureLint(await row(), {}, ctx())).resolves.toBeNull();
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
    expect((await row()).signature).toBe('no link');
    expect(fields(await lint())).toEqual(['WORKER_LINK_MISSING:signature']);
  });

  it('a retired worker still reads its lint (history is readable)', async () => {
    await update({ signature: 'no link' });
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    expect(fields(await lint())).toEqual(['WORKER_LINK_MISSING:signature']);
  });
});
