/** #435 — the agent task symptom search is free text that reaches the keyword half without passing findNodes: the same 512-character bound applies at its validation, before any search. */
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const Q = resolvers.Query as any;
let ctx: Context;
let agentId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { urn: 'symptom435.example', name: 'symptom' } });
  const user = await db.user.create({ data: { handle: 'reader435', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'READER' } });
  ctx = { db, userId: user.id, roles: ['READER'] };
  const memory = await db.memory.create({ data: { urn: 'symptom435.example:a', name: 'a', class: 'system', organizationId: org.id } });
  const a = await db.agent.create({ data: { urn: 'symptom435.example:a', name: 'a', visibility: 'ORGANIZATION', organizationId: org.id, systemMemoryId: memory.id } });
  agentId = a.id;
  const app = await db.app.create({ data: { urn: 'symptom435.example:app', name: 'app', organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: a.id } });
  await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
  await db.node.create({ data: { memoryId: memory.id, loc: 'tasks:one', name: 'one', isRunnable: true, abstract: 'recover the unicorn' } });
});
const list = (symptom: string) => Q.agentTaskList({}, { ref: agentId, symptom }, ctx);
const code = (p: Promise<unknown>) => p.then(() => undefined, (e: any) => e?.extensions?.code);

it('a 513-character symptom is BAD_USER_INPUT; 512 is searched', async () => {
  expect(await code(list('x'.repeat(513)))).toBe('BAD_USER_INPUT');
  expect(await code(list('x'.repeat(512)))).toBeUndefined();
});
it('a normal symptom still finds its task, and a refused 513-character one never reaches the embed call', async () => {
  const embed = vi.fn(async (t: string[]) => t.map(() => new Array(768).fill(0)));
  setEmbeddingClientForTests({ model: 'test', dim: 768, embed } as never);
  try {
    expect((await list('recover the unicorn')).map((e: any) => e.node.loc)).toEqual(['tasks:one']);
    embed.mockClear();
    expect(await code(list('x'.repeat(513)))).toBe('BAD_USER_INPUT');
    expect(embed).not.toHaveBeenCalled();
  } finally { resetEmbeddingClientForTests(); }
});
it.each([
  ['a ~70-word natural-language symptom (over the 64-leaf cap, under 512 characters)', Array.from({ length: 70 }, (_, i) => `w${i}`).join(' ')],
  ['a nested-parenthesis symptom (over the depth cap)', '((((((((( unicorn )))))))))'],
])('%s degrades to the literal fallback instead of throwing', async (_n, symptom) => {
  expect(symptom.length).toBeLessThanOrEqual(512);
  expect(await code(list(symptom))).toBeUndefined();
});
it('an unindexable symptom (only negation) is BAD_USER_INPUT, never a silent empty list', async () => {
  expect(await code(list('-unicorn'))).toBe('BAD_USER_INPUT');
});
