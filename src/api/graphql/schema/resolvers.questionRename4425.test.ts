/** #4425 S1: the public question names replace decision names, without aliases or a payload migration. */
import { describe, expect, it, vi } from 'vitest';
import { buildASTSchema, parse } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { governedKindsOf } from '../../../lib/governedRole.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const schema = buildASTSchema(parse(typeDefs));
describe('#4425 clean question rename', () => {
  it('exposes the new GraphQL doors and types, with no decision aliases', () => {
    const query = schema.getQueryType()!.getFields();
    const mutation = schema.getMutationType()!.getFields();
    for (const name of ['question', 'questionLog', 'questions', 'verifyQuestion']) expect(query[name], name).toBeDefined();
    for (const name of ['decision', 'decisionLog', 'decisions', 'verifyDecision']) expect(query[name], name).toBeUndefined();
    for (const name of ['createQuestionLog', 'setQuestionLogDeciders', 'askQuestion', 'amendQuestion', 'withdrawQuestion', 'purgeUnansweredQuestion']) expect(mutation[name], name).toBeDefined();
    for (const name of ['createDecisionLog', 'setDecisionLogDeciders', 'askDecision', 'amendDecision', 'withdrawDecision', 'purgeUnansweredDecision']) expect(mutation[name], name).toBeUndefined();
    expect(schema.getType('Question')).toBeDefined();
    expect(schema.getType('QuestionLog')).toBeDefined();
    expect(schema.getType('Decision')).toBeUndefined();
    expect(schema.getType('DecisionLog')).toBeUndefined();
    expect(schema.getType('BootPromptServeDecision')).toBeDefined();
  });

  it('governs question roles and frees the old decision roles', () => {
    expect(governedKindsOf({ role: 'question' }).map((e) => e.kind)).toEqual(['question']);
    expect(governedKindsOf({ role: 'question.log' }).map((e) => e.kind)).toEqual(['question']);
    expect(governedKindsOf({ role: 'decision' })).toEqual([]);
    expect(governedKindsOf({ role: 'decision.log' })).toEqual([]);
  });

  it('ignores old rows in question reads and lets a memory writer edit them as ordinary nodes', async () => {
    await cleanDb(db);
    const org = await db.organization.create({ data: { name: 'Legacy questions', urn: 'rename4425.example' } });
    const user = await db.user.create({ data: { githubId: 4425001, githubUsername: 'rename4425', roles: [] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
    const ctx: Context = { db, userId: user.id, roles: [] };
    const M = resolvers.Mutation as any;
    const Q = resolvers.Query as any;
    const memory = await M.createMemory(null, { orgId: org.id, name: 'Legacy' }, ctx);
    const log = await db.node.create({ data: { memoryId: memory.id, loc: 'old', name: 'Old log', role: 'decision.log', nodeType: 'info' } });
    const node = await db.node.create({ data: { memoryId: memory.id, loc: 'old:DA', name: 'Old ask', role: 'decision', nodeType: 'info' } });
    expect(Q.question).toBeTypeOf('function');
    expect(await Q.question(null, { ref: node.id }, ctx)).toBeNull();
    expect(await Q.questions(null, { logRef: log.id }, ctx)).toEqual({ items: [], total: 0 });
    await M.updateNode(null, { id: node.id, name: 'Ordinary editable node' }, ctx);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe('Ordinary editable node');
  });
});
