/**
 * #3262 / hrn:node:hadronmemory.com:specs:cor:agt:050:01: a reference label or http(s) target holding U+0000 or an
 * unpaired UTF-16 surrogate cannot be stored (gate widened to targets: Ada #67922, Xanthos 6588859404) (PostgreSQL text and jsonb represent neither), so it is refused up front as
 * BAD_USER_INPUT on create and update, atomically and without echoing the input, instead of failing at the
 * jsonb write as INTERNAL_SERVER_ERROR. A well-formed surrogate pair is ordinary text and stays accepted.
 * C0/C1 labels such as U+0001 or U+0085 are out of scope (no ruling), so this file does not judge them.
 */
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
  const org = await db.organization.create({ data: { name: 'Unstorable', urn: `unstorable-${generateId()}.test` } });
  const user = await db.user.create({ data: { handle: `unstorable-${generateId()}` } }); userId = user.id;
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Unstorable', urn: `${org.urn}:unstorable` } }); appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'owner' } });
});

const RULE = 'may not contain U+0000 or an unpaired surrogate';
const LABELS: Array<[string, string]> = [
  ['U+0000', 'a\u0000b'],
  ['a lone high surrogate', 'a\ud800b'],
  ['a lone low surrogate', 'a\udc00b'],
  ['a high surrogate at the end', 'tail\udbff'],
  ['a reversed pair (low then high)', 'x\udc00\ud800y'],
];

type Case = { name: string; ref: { kind: string; target: string; label?: string } };
const cases: Case[] = LABELS.map(([name, label]) => ({ name: `a label with ${name}`, ref: { kind: 'URL', target: 'https://example.com/ok', label } }));
// NUL in a target is already refused by the C0 check; a lone surrogate passed every http(s) target check on main.
for (const [name, c] of [['a lone high surrogate', '\ud800'], ['a lone low surrogate', '\udc00']] as const) {
  cases.push({ name: `a URL path with ${name}`, ref: { kind: 'URL', target: `https://example.com/a${c}b` } });
  cases.push({ name: `an ISSUE fragment with ${name}`, ref: { kind: 'ISSUE', target: `https://github.com/o/r/issues/1#x${c}` } });
  cases.push({ name: `a PULL_REQUEST query with ${name}`, ref: { kind: 'PULL_REQUEST', target: `https://github.com/o/r/pull/1?q=${c}` } });
}

describe('#3262 refusal atomicity, both writers', () => {
  for (const mode of ['create', 'update'] as const) it.each(cases)(`${mode} refuses $name, without any write or echo`, async ({ ref }) => {
    const task = mode === 'update' ? await create([good]) : null;
    const beforeTasks = await db.agentTask.findMany({ where: { appId }, orderBy: { id: 'asc' } });
    const beforeEvents = await db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } });
    const references = [good, ref];
    const result = await (mode === 'create' ? create(references) :
      M.updateAgentTask({}, { taskId: task.id, input: { title: 'Changed', references } }, ctx())).catch((e: unknown) => e);
    expect(result).toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(result.message).toContain('Reference 2:');
    expect(result.message).toContain(RULE);
    expect(result.message).not.toContain(ref.target);
    if (ref.label) expect(result.message).not.toContain(ref.label);
    expect(await db.agentTask.findMany({ where: { appId }, orderBy: { id: 'asc' } })).toEqual(beforeTasks);
    expect(await db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } })).toEqual(beforeEvents);
  });
});

it('accepts well-formed surrogate pairs (emoji, a supplementary ideograph) in a label and a target, through both writers', async () => {
  const refs = ['🙂', 'flag 🇩🇪 here', '𠀀 ideograph'].map((label, i) => ({ kind: 'URL', target: `https://example.com/pair/${['🙂', '𠀀', 'x'][i]}`, label }));
  const task = await create(refs);
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).references).toEqual(refs.map(r => ({ ...r, kind: 'url' })));
  const reversed = [...refs].reverse();
  await M.updateAgentTask({}, { taskId: task.id, input: { references: reversed } }, ctx());
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).references).toEqual(reversed.map(r => ({ ...r, kind: 'url' })));
});

it('the normalizer refuses each unstorable label and target directly, with fixed text', () => {
  for (const { ref } of cases) expect(() => normalizeTaskReferences([ref])).toThrow(RULE);
});
