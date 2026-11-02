/**
 * #3252 / hrn:node:hadronmemory.com:specs:cor:agt:050:01 (References → Refusals; ruling 0086 A): blank-looking
 * characters are refused in targets and labels, and variation selectors in targets only, on create and update,
 * atomically and without echoing the input.
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
  const org = await db.organization.create({ data: { name: 'Blanks', urn: `blanks-${generateId()}.test` } });
  const user = await db.user.create({ data: { handle: `blanks-${generateId()}` } }); userId = user.id;
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Blanks', urn: `${org.urn}:blanks` } }); appId = app.id;
  await db.appMember.create({ data: { appId, userId, role: 'owner' } });
});

const hex = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
/** Ruling 0086 A: refused in targets AND labels. */
const BLANKS = ['\u115f', '\u1160', '\u3164', '\uffa0', '\u2800', '\u034f'];
/** Ruling 0086 A: refused in targets only (both ends of both ranges, and one inside each). */
const SELECTORS = ['\ufe00', '\ufe07', '\ufe0f', '\u{e0100}', '\u{e0150}', '\u{e01ef}'];
const BLANK_RULE = 'blank-looking character';
const SELECTOR_RULE = 'variation selector';

type Case = { name: string; ref: { kind: string; target: string; label?: string }; rule: string };
// Placed in the path and in the fragment of an https target, where main accepts them (gate note 1), and in a label.
const cases: Case[] = [];
for (const c of BLANKS) {
  cases.push({ name: `${hex(c)} in a URL path`, ref: { kind: 'URL', target: `https://example.com/a${c}b` }, rule: BLANK_RULE });
  cases.push({ name: `${hex(c)} in an ISSUE fragment`, ref: { kind: 'ISSUE', target: `https://github.com/o/r/issues/1#x${c}` }, rule: BLANK_RULE });
  cases.push({ name: `${hex(c)} in a label`, ref: { kind: 'URL', target: 'https://example.com/ok', label: `see${c}this` }, rule: BLANK_RULE });
}
for (const c of SELECTORS) {
  cases.push({ name: `${hex(c)} in a URL path`, ref: { kind: 'URL', target: `https://example.com/a${c}b` }, rule: SELECTOR_RULE });
  cases.push({ name: `${hex(c)} in a PULL_REQUEST fragment`, ref: { kind: 'PULL_REQUEST', target: `https://github.com/o/r/pull/1#y${c}` }, rule: SELECTOR_RULE });
}

describe('#3252 refusal atomicity, both writers', () => {
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
    if (ref.label) expect(result.message).not.toContain(ref.label);
    expect(await db.agentTask.findMany({ where: { appId }, orderBy: { id: 'asc' } })).toEqual(beforeTasks);
    expect(await db.agentTeamEvent.findMany({ where: { appId }, orderBy: { id: 'asc' } })).toEqual(beforeEvents);
  });
});

it('accepts a variation selector in a label (an emoji label with U+FE0F round-trips) through both writers', async () => {
  const refs = ['❤\ufe0f', '☺\ufe0f ok', 'text\ufe0e', 'ideograph\u{e0100}'].map(label => ({ kind: 'URL', target: 'https://example.com/ok', label }));
  const task = await create(refs);
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).references).toEqual(refs.map(r => ({ ...r, kind: 'url' })));
  const reversed = [...refs].reverse();
  await M.updateAgentTask({}, { taskId: task.id, input: { references: reversed } }, ctx());
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).references).toEqual(reversed.map(r => ({ ...r, kind: 'url' })));
});

it('refuses every ruled blank in every kind, target and label, and selectors in every kind of target (direct)', () => {
  const bases = [
    ['ISSUE', 'https://github.com/o/r/issues/1'], ['PULL_REQUEST', 'https://github.com/o/r/pull/1'],
    ['NODE', 'hrn:node:example.com:memory:leaf'], ['TASK', 'hrn:agenttask:example.com:team:AT1.2'],
    ['URL', 'https://example.com/path'],
  ] as const;
  for (const [kind, target] of bases) {
    for (const c of BLANKS) {
      expect(() => normalizeTaskReferences([{ kind, target: target + c }])).toThrow(BLANK_RULE);
      expect(() => normalizeTaskReferences([{ kind, target, label: c }])).toThrow(BLANK_RULE);
    }
    for (const c of SELECTORS) {
      expect(() => normalizeTaskReferences([{ kind, target: target + c }])).toThrow(SELECTOR_RULE);
      expect(normalizeTaskReferences([{ kind, target, label: `x${c}` }])[0].label).toBe(`x${c}`);
    }
  }
});

it('leaves the neighbours of each ruled range alone (targets and labels)', () => {
  // The code points either side of each ruled character or range are outside the ruling and stay accepted.
  for (const c of ['\u115e', '\u1161', '\u3163', '\u3165', '\uff9f', '\uffa1', '\u27ff', '\u2801', '\u034e', '\u0350', '\ufdff', '\ufe10', '\u{e00ff}', '\u{e01f0}']) {
    expect(normalizeTaskReferences([{ ...good, label: `x${c}` }])[0].label).toBe(`x${c}`);
    expect(normalizeTaskReferences([{ kind: 'URL', target: `https://example.com/a${c}b` }])[0].target).toBe(`https://example.com/a${c}b`);
  }
});

it('rows already stored are not rewritten: a legacy row reads back unchanged and stays until an edit replaces the list', async () => {
  const task = await create([good]);
  const legacy = [{ kind: 'url', target: 'https://example.com/a\u2800b', label: 'old\u3164' }];
  await db.agentTask.update({ where: { id: task.id }, data: { references: legacy } });
  // An unrelated edit that leaves references alone does not touch them.
  await M.updateAgentTask({}, { taskId: task.id, input: { title: 'Renamed' } }, ctx());
  expect((await db.agentTask.findUniqueOrThrow({ where: { id: task.id } })).references).toEqual(legacy);
});
