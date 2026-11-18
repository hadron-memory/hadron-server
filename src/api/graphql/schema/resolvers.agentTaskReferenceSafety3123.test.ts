/** #3123 / hrn:node:hadronmemory.com:specs:cor:agt:050:01 V27: reject deceptive stored references atomically. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { normalizeTaskReferences } from '../../../lib/agentTasks/references.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let appId: string, userId: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const good = { kind: 'URL', target: 'https://example.com/keep', label: 'keep' };
const create = (references: unknown) => M.createAgentTask({}, { input: { appRef: appId, title: 'Keep', references } }, ctx());
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Safety', urn: `safety-${generateId()}.test` } });
  const user = await db.user.create({ data: { handle: `safety-${generateId()}` } }); userId = user.id;
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Safety', urn: `${org.urn}:safety` } }); appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'owner' } });
});
const bases = [
  ['ISSUE', 'https://github.com/o/r/issues/1'], ['PULL_REQUEST', 'https://github.com/o/r/pull/1'],
  ['NODE', 'hrn:node:example.com:memory:leaf'], ['TASK', 'hrn:agenttask:example.com:team:AT1.2'],
  ['URL', 'https://example.com/path'],
] as const;
const cases = bases.flatMap(([kind, target]) => ['\u202e', '\u200b', '\ufeff'].map(char => ({
  name: `${kind} target U+${char.codePointAt(0)!.toString(16)}`, ref: { kind, target: target + char + 'secret' }, rule: 'invisible format character',
})));
for (const [kind, target] of bases) cases.push({ name: `${kind} label U+202E`, ref: { kind, target, label: 'private\u202elabel' } as any, rule: 'invisible format character' });
for (const [kind, target] of [
  ['ISSUE', 'https://user:pass@github.com/o/r/issues/1'],
  ['PULL_REQUEST', 'https://github.com@evil.example/o/r/pull/1'],
  ['URL', 'https://@example.com/'],
]) cases.push({ name: `${kind} written userinfo`, ref: { kind, target } as any, rule: 'user name or password' });
describe('#3123 refusal atomicity', () => {
  for (const mode of ['create', 'update'] as const) it.each(cases)(`${mode} refuses $name without any write or echo`, async ({ ref, rule }) => {
    const task = mode === 'update' ? await create([good]) : null;
    const beforeTasks = await db.agentTask.findMany({ where: { appId }, orderBy: { id: 'asc' } });
    const beforeEvents = await db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } });
    const references = [good, ref];
    const result = await (mode === 'create' ? create(references) :
      M.updateAgentTask({}, { taskId: task.id, input: { title: 'Changed', references } }, ctx())).catch((e: unknown) => e);
    expect(result).toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(result.message).toContain('Reference 2:');
    expect(result.message).toContain(rule);
    expect(result.message).not.toContain(ref.target);
    if ('label' in ref) expect(result.message).not.toContain(ref.label);
    expect(await db.agentTask.findMany({ where: { appId }, orderBy: { id: 'asc' } })).toEqual(beforeTasks);
    expect(await db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } })).toEqual(beforeEvents);
  });
});
it('accepts ASCII/non-Cf Unicode labels and @ outside the written authority, through both writers', async () => {
  const refs = ['ASCII', 'Bühne — ü', '🙂'].map(label => ({ kind: 'URL', target: 'https://example.com/u/@name?x=a@b#@fragment', label }));
  const task = await create(refs);
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).references).toEqual(refs.map(r => ({ ...r, kind: 'url' })));
  const reversed = [...refs].reverse();
  await M.updateAgentTask({}, { taskId: task.id, input: { references: reversed } }, ctx());
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).references).toEqual(reversed.map(r => ({ ...r, kind: 'url' })));
});
it('covers Cf beyond the three examples and written authority delimiters directly', () => {
  for (const char of ['\u00ad', '\u200e', '\u2066', '\u{e0001}']) {
    expect(() => normalizeTaskReferences([{ ...good, target: good.target + char }])).toThrow(/invisible format character/);
    expect(() => normalizeTaskReferences([{ ...good, label: 'label' + char }])).toThrow(/invisible format character/);
  }
  for (const kind of ['ISSUE', 'PULL_REQUEST', 'URL']) {
    for (const suffix of ['/', '?x=1', '#fragment', '']) {
      expect(() => normalizeTaskReferences([{ kind, target: `https://host@evil.example${suffix}` }])).toThrow(/user name or password/);
    }
    for (const target of ['https://example.com/?x=@other', 'https://example.com/#@other', 'https://example.com/@other']) {
      expect(normalizeTaskReferences([{ kind, target }])[0].target).toBe(target);
    }
  }
});
