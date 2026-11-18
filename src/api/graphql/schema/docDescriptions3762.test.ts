import { expect, it } from 'vitest';
import { parse, type ObjectTypeDefinitionNode } from 'graphql';
import { typeDefs } from './typeDefs.js';
const field = (type: string, name: string) => {
  const node = parse(typeDefs).definitions.find(d => d.kind === 'ObjectTypeDefinition' && d.name.value === type) as ObjectTypeDefinitionNode;
  return node.fields!.find(f => f.name.value === name)!;
};
it('#3762: a late report preserves the current state, including PASS', () => {
  const description = field('NodeContentValidationReportReceipt', 'state').description?.value ?? '';
  expect(description).toContain('without changing');
  expect(description).not.toContain('leaves it UNVALIDATED or STALE');
});
it('#3762: readiness state describes task statuses and the missing-seat case without an enum change', () => {
  const f = field('ReviewSlotReadiness', 'state');
  expect(f.description?.value).toContain('MISSING');
  expect(f.description?.value).toContain('uppercased');
  expect(f.type).toMatchObject({kind:'NonNullType',type:{kind:'NamedType',name:{value:'String'}}});
});
it('#3762: counts describes the frozen-head, finished, positive and independent verdict requirements', () => {
  const d = field('ReviewSlotReadiness', 'counts').description?.value ?? '';
  for (const word of ['FINISHED', 'frozen head', 'APPROVE', 'PASS', 'CARRY', 'freezer', 'negative']) expect(d).toContain(word);
});
