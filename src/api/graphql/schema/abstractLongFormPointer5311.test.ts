/**
 * #5311 (hrn:node:hadronmemory.com:specs:cor:dmo:020:02, follow-up to #377 / PR #5306): every authoring surface that
 * states the abstract's 2000-character cap also says where the long text goes ("for the long form use `content`").
 * The wording names a place for the author's text; it never says the server moves or truncates an over-long abstract
 * into `content` (020:02 "no derivation between them"). The cap and its refusal are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { parse, type InputObjectTypeDefinitionNode } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { hadronCreateNode, hadronUpdateNode } from '../../../lib/runner/tools/nodeTools.js';

const POINTER = 'for the long form use `content`';

const inputAbstractDescription = (typeName: string): string => {
  const input = parse(typeDefs).definitions.find(
    (d): d is InputObjectTypeDefinitionNode => d.kind === 'InputObjectTypeDefinition' && d.name.value === typeName,
  );
  const field = input?.fields?.find((f) => f.name.value === 'abstract');
  return (field?.description?.value ?? '').replace(/\s+/g, ' ');
};

const toolAbstractDescription = (tool: typeof hadronCreateNode): string => {
  const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
  return props.abstract?.description ?? '';
};

describe('#5311: the abstract cap names where the long form goes', () => {
  for (const typeName of ['NodeInput', 'CreateNodeInput', 'UpdateNodeInput']) {
    it(`${typeName}.abstract states the cap and the pointer`, () => {
      const text = inputAbstractDescription(typeName);
      expect(text).toContain('2000 characters');
      expect(text).toContain(POINTER);
      expect(text).not.toMatch(/truncat|moved? (in)?to|overflow/i);
    });
  }

  for (const tool of [hadronCreateNode, hadronUpdateNode]) {
    it(`runner tool ${tool.name} abstract states the cap and the pointer`, () => {
      const text = toolAbstractDescription(tool);
      expect(text).toContain('max 2000 chars');
      expect(text).toContain(POINTER);
    });
  }
});
