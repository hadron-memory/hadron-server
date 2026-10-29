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


describe('#2689 served-prompt and Chat description ownership', () => {
  const definitions = parse(typeDefs).definitions;
  const description = (name: string) => {
    const def = definitions.find(node => 'name' in node && node.name?.value === name);
    return def && 'description' in def ? def.description?.value ?? '' : '';
  };
  it('attaches the existing chat-scope prose to Chat', () => {
    expect(description('Chat')).toContain('A saved chat in one of the chat-scope tiers.');
    expect(description('Chat')).toContain('scope is set at chat creation and immutable');
    expect(description('Chat')).toContain('readable by every AppMember of that App.');
  });
  it('describes ServedPromptKind as bind/chat/run rather than chat storage', () => {
    expect(description('ServedPromptKind')).toMatch(/kind of served prompt/i);
    expect(description('ServedPromptKind')).toMatch(/bind.*chat.*run/i);
    expect(description('ServedPromptKind')).not.toContain('chat-scope tiers');
  });
});
