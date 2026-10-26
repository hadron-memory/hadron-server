import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'graphql';
import { typeDefs } from './typeDefs.js';

// #389: two comments that still described superseded behaviour.

function edgeModelComment(): string {
  const lines = readFileSync(new URL('../../../../prisma/schema.prisma', import.meta.url), 'utf8').split('\n');
  const at = lines.findIndex(l => l.startsWith('model Edge {'));
  if (at < 0) throw new Error('model Edge not found');
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i].startsWith('///'); i--) block.unshift(lines[i]);
  return block.join('\n');
}

function userUrnDescription(): string {
  const def = parse(typeDefs).definitions.find(n => 'name' in n && n.name?.value === 'User');
  if (!def || !('fields' in def)) throw new Error('Missing User');
  return def.fields!.find(f => f.name.value === 'urn')?.description?.value ?? '';
}

describe('#389 residual doc comments', () => {
  it("the Edge model comment no longer calls the relationship name a `label`", () => {
    const text = edgeModelComment();
    expect(text).toContain('Directed edge between two Nodes');
    expect(text).not.toContain('The `label`');
    expect(text).toContain('`name`');
  });
  it('User.urn names both null cases: no handle and a not-URN-legal handle', () => {
    const text = userUrnDescription();
    expect(text).toContain('handle-less');
    expect(text).toContain('not-URN-legal');
  });
});
