/** #4425 S1: the public question names replace decision names, without aliases or a payload migration. */
import { describe, expect, it } from 'vitest';
import { buildASTSchema, parse } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { governedKindsOf } from '../../../lib/governedRole.js';


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
    expect(Object.keys(schema.getTypeMap()).filter((name) => /^(Decision|AskDecision|AmendDecision)/.test(name))).toEqual([]);
    expect(schema.getType('BootPromptServeDecision')).toBeDefined();
  });

  it('governs question roles and frees the old decision roles', () => {
    expect(governedKindsOf({ role: 'question' }).map((e) => e.kind)).toEqual(['question']);
    expect(governedKindsOf({ role: 'question.log' }).map((e) => e.kind)).toEqual(['question']);
    expect(governedKindsOf({ role: 'decision' })).toEqual([]);
    expect(governedKindsOf({ role: 'decision.log' })).toEqual([]);
  });

});
