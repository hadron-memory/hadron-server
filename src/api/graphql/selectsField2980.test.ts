/**
 * #2980 — `selectsField` decides whether a filtered chat read may skip its exact count. It must find `total` however
 * a selection spells it, and when it cannot tell it must answer "selected", so the count stays exact.
 */
import { describe, it, expect } from 'vitest';
import { parse, type FieldNode, type GraphQLResolveInfo, type OperationDefinitionNode, type FragmentDefinitionNode } from 'graphql';
import { selectsField } from './selectsField.js';

function infoFor(doc: string): GraphQLResolveInfo {
  const parsed = parse(doc);
  const op = parsed.definitions.find((d) => d.kind === 'OperationDefinition') as OperationDefinitionNode;
  const fragments = Object.fromEntries(
    parsed.definitions.filter((d): d is FragmentDefinitionNode => d.kind === 'FragmentDefinition').map((f) => [f.name.value, f]),
  );
  return { fieldNodes: [op.selectionSet.selections[0] as FieldNode], fragments } as unknown as GraphQLResolveInfo;
}
const WITH_TOTAL = infoFor('{ c { items { seq } total } }');
const ITEMS_ONLY = infoFor('{ c { items { seq } } }');

describe('selectsField', () => {
  it('finds a direct field, one inside an inline fragment, and one inside a named fragment', () => {
    expect(selectsField(WITH_TOTAL, 'total')).toBe(true);
    expect(selectsField(ITEMS_ONLY, 'total')).toBe(false);
    expect(selectsField(infoFor('{ c { items { seq } ... on TeamChatMessagesPage { total } } }'), 'total')).toBe(true);
    expect(selectsField(infoFor('query { c { ...P } } fragment P on TeamChatMessagesPage { items { seq } total }'), 'total')).toBe(true);
    expect(selectsField(infoFor('query { c { ...P } } fragment P on TeamChatMessagesPage { items { seq } }'), 'total')).toBe(false);
  });

  it('errs toward selected: no info, an unknown fragment, or a nested total that is not the page\'s own', () => {
    expect(selectsField(undefined, 'total')).toBe(true);
    expect(selectsField(infoFor('query { c { ...Missing } }'), 'total')).toBe(true);
    expect(selectsField(infoFor('{ c { total: items { seq } } }'), 'total')).toBe(false);
    expect(selectsField(infoFor('{ c { items { total } } }'), 'total')).toBe(false);
    expect(selectsField(infoFor('{ c { n: total } }'), 'total')).toBe(true);
    expect(selectsField(infoFor('{ c { total @skip(if: true) items { seq } } }'), 'total')).toBe(true);
  });
});
