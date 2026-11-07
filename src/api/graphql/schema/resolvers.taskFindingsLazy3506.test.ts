/**
 * #3506 (split from #3263 row 5, Andi's blind P3-1 on #3244): an App key reads a finished task's
 * findings through the LAZY list/relation result path. Wide rows omit `resultFindings`
 * (`omit: { resultFindings: true }` in `agentTasks` and `relationPages`), so `AgentTask.result`
 * re-gates the read through `withReadableTask` at this field, not trusting the row that carried
 * us here (cor:acl:110:02); the findings ride the result (cor:agt:050:30) inside the task's App
 * scope (cor:agt:050:01). Tests only; production behavior unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = (resolvers as any).AgentTask;
const RF = (resolvers as any).AgentTaskResult;

let member: { id: string };
let appX: { id: string; urn: string };
let appY: { id: string };
let keyX: { id: string };
let keyY: { id: string };

const userCtx = (): Context => ({ db, userId: member.id, roles: ['READER'] });
const keyXCtx = (extra: Partial<Context> = {}): Context => ({ db, appId: appX.id, appKeyId: keyX.id, roles: [], ...extra });
const keyYCtx = (): Context => ({ db, appId: appY.id, appKeyId: keyY.id, roles: [] });

/** A lazy list/relation row of `t`: the wide loaders' shape, the payload key absent. */
const lazyRow = async (id: string) => {
  const full = await db.agentTask.findUniqueOrThrow({ where: { id } });
  const row = { ...full };
  delete (row as any).resultFindings;
  return row as any;
};

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const org = await db.organization.create({ data: { id: generateId(), name: 'lazy-org', urn: `lazy-org-${suffix}.com` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 98_350, githubUsername: `lazy-${suffix}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'ADMIN' } });
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` } });
  await db.appMember.create({ data: { appId: appX.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: appY.id, userId: member.id, role: 'member' } });
  keyX = await db.appKey.create({ data: { id: generateId(), appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'xk1' }, select: { id: true } });
  keyY = await db.appKey.create({ data: { id: generateId(), appId: appY.id, keyHash: `h-${generateId()}`, keyPreview: 'yk1' }, select: { id: true } });
});

/** A finished task on X carrying one finding, created and finished by `member`. */
async function finishedWithFindings(findings: unknown[] = [{ severity: 'P1', text: 'lazy path finding' }]) {
  const t = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'T', source: 's', assignee: { user: member.id } } }, userCtx());
  await M.startAgentTask({}, { taskId: t.id }, userCtx());
  await M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded', summary: 'S', evidence: 'E', findings } }, userCtx());
  return t;
}

/** Read the findings the way GraphQL would: result view, then the paginated findings field. */
const findingsVia = async (row: any, ctx: Context) => RF.findings(await F.result(row, {}, ctx), {}, ctx);

describe('#3506 the App\'s own key reads findings through the lazy path', () => {
  it('pin 1 (list): agentTasks rows omit resultFindings and the key reads the stored findings', async () => {
    const t = await finishedWithFindings();
    const rows = await Q.agentTasks({}, { appRef: appX.id }, keyXCtx());
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(t.id);
    // The lazy path, not the eager one: the wide row omits the payload key entirely.
    expect(Object.hasOwn(rows[0], 'resultFindings')).toBe(false);
    const result = await F.result(rows[0], {}, keyXCtx());
    expect(result).toMatchObject({ outcome: 'succeeded', summary: 'S', evidence: 'E' });
    expect(await RF.findings(result, {}, keyXCtx())).toEqual({ items: [{ id: 'F1', severity: 'P1', text: 'lazy path finding' }], total: 1, hasMore: false });
  });

  it('pin 2 (relation): clones items omit resultFindings and the key reads the clone\'s findings', async () => {
    const parent = await M.createAgentTask({}, { input: { appRef: appX.id, title: 'P', source: 's' } }, userCtx());
    const clone = await M.cloneAgentTask({}, { taskId: parent.id, input: { assignee: { user: member.id } } }, userCtx());
    await M.startAgentTask({}, { taskId: clone.id }, userCtx());
    await M.finishAgentTask({}, { taskId: clone.id, result: { outcome: 'succeeded', summary: 'CS', evidence: 'CE', findings: [{ severity: 'note', text: 'clone finding' }] } }, userCtx());
    const page = await F.clones(await lazyRow(parent.id), {}, keyXCtx());
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([clone.id]);
    expect(Object.hasOwn(page.items[0], 'resultFindings')).toBe(false);
    expect(await findingsVia(page.items[0], keyXCtx())).toEqual({ items: [{ id: 'F1', severity: 'note', text: 'clone finding' }], total: 1, hasMore: false });
  });
});

describe('#3506 no findings through the lazy path for a caller the direct read refuses', () => {
  it('pin 3: another App\'s key, a revoked key and a key with no row read result: null, like the direct read', async () => {
    const t = await finishedWithFindings();
    const row = await lazyRow(t.id);
    const refused = [
      ['another App\'s key', keyYCtx()],
      ['a revoked key', keyXCtx({ appKeyId: (await db.appKey.create({ data: { appId: appX.id, keyHash: `h-${generateId()}`, keyPreview: 'rk', revokedAt: new Date() }, select: { id: true } })).id })],
      ['a key with no row', keyXCtx({ appKeyId: generateId() })],
    ] as const;
    for (const [name, ctx] of refused) {
      expect(await F.result(row, {}, ctx as unknown as Context), name).toBeNull();
      expect(await Q.agentTask({}, { id: t.id }, ctx as unknown as Context), name).toBeNull();
    }
    // …and a key revoked after the fact, the revocation racing nothing here
    await db.appKey.update({ where: { id: keyX.id }, data: { revokedAt: new Date() } });
    expect(await F.result(row, {}, keyXCtx())).toBeNull();
    expect(await Q.agentTask({}, { id: t.id }, keyXCtx())).toBeNull();
  });

  it('pin 4: a non-App principal who cannot read the task gets no findings through the lazy path', async () => {
    const t = await finishedWithFindings();
    const outsider = await db.user.create({ data: { id: generateId(), githubId: 98_351, githubUsername: `out-${generateId()}`, roles: ['READER'] }, select: { id: true } });
    const ctx: Context = { db, userId: outsider.id, roles: ['READER'] };
    const row = await lazyRow(t.id);
    expect(await F.result(row, {}, ctx)).toBeNull();
    expect(await Q.agentTask({}, { id: t.id }, ctx)).toBeNull();
  });
});
