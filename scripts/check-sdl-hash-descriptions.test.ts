/**
 * Tests for the #1232 SDL hash-comment gate.
 *
 * These exercise `findHashBlocks` against small synthetic SDL strings rather
 * than the real `typeDefs.ts`, so a legitimate edit to the schema never turns
 * one of them red. What they pin is the CLASSIFIER — which is where every bug
 * in this gate has been so far:
 *
 *   1. a `#` inside a `"""` block was read as a comment (inflated the
 *      population by ~30 sites);
 *   2. a description ABOVE the comment was not seen, so a documented field was
 *      reported as undocumented — and "fixing" it emitted a second description
 *      block, a syntax error `check-graphql-sdl` caught on the first run;
 *   3. an argument inside a multi-line argument list was attributed to the
 *      enclosing type (`Mutation.name`), which would have made an allow-list
 *      entry a key for a symbol that does not exist.
 *
 * Each of those is a case below. A gate whose scanner is wrong does not fail
 * loudly — it reports the wrong sites, which reads exactly like working.
 */

import { describe, it, expect } from 'vitest';
import { findHashBlocks } from './check-sdl-hash-descriptions.mjs';

/** Wrap SDL in the template-literal shape the scanner expects to find. */
const sdl = (body: string) => 'export const typeDefs = `#graphql\n' + body + '\n`;';

describe('#1232 — findHashBlocks', () => {
  it('reports a `#` comment above a field with no description', () => {
    const blocks = findHashBlocks(
      sdl(`  type Query {
    # Message history for a saved chat.
    chatHistory(chatId: String!): [ChatMessage!]!
  }`),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ symbol: 'Query.chatHistory', documented: false });
    expect(blocks[0].text).toBe('Message history for a saved chat.');
  });

  it('does NOT report one above a field that already has a """description"""', () => {
    const blocks = findHashBlocks(
      sdl(`  type Query {
    # Implementation note for a reader of this file.
    """
    The published description.
    """
    chatHistory(chatId: String!): [ChatMessage!]!
  }`),
    );
    expect(blocks[0]).toMatchObject({ documented: true });
    expect(blocks.filter((b) => !b.documented && b.symbol)).toHaveLength(0);
  });

  it('does not report one where the description comes FIRST (the syntax-error case)', () => {
    // GraphQL treats comments as ignored tokens, so the description still
    // attaches to the field across the comment. Reporting this and converting
    // it produces two adjacent description blocks, which will not parse.
    const blocks = findHashBlocks(
      sdl(`  type Mutation {
    """
    The published description.
    """
    # A note that follows it.
    startChat(agentId: ID!): ChatStartResult!
  }`),
    );
    expect(blocks[0]).toMatchObject({ documented: true });
    expect(blocks.filter((b) => !b.documented && b.symbol)).toHaveLength(0);
  });

  it('treats a `#` INSIDE a """ block as text, not as a comment', () => {
    const blocks = findHashBlocks(
      sdl(`  type Query {
    """
    A description that mentions #1115 and starts a line with it:
    #1115 — this is prose, not a comment.
    """
    me: User
  }`),
    );
    expect(blocks).toHaveLength(0);
  });

  it('attributes an argument in a multi-line arg list to the argument, not the type', () => {
    const blocks = findHashBlocks(
      sdl(`  type Mutation {
    castWorker(
      appRef: ID!
      # Mandatory in effect, nullable in the schema.
      name: String
    ): Worker!
  }`),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].symbol).toBe('Mutation.castWorker(name:)');
  });

  it('reports a `#` comment above an enum VALUE (@codex, PR #1244)', () => {
    // An enum value is a bare name with no colon, so it matches neither the
    // type nor the field pattern. Before this it resolved to no symbol and the
    // block was dropped SILENTLY — the gate passing exactly the invisible
    // documentation it exists to reject. No such site exists in typeDefs.ts
    // today, which is the only reason it was not already a live miss.
    const blocks = findHashBlocks(
      sdl(`  enum MemoryVisibility {
    PUBLIC
    # Only the owning organization's members can read it.
    ORGANIZATION
  }`),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ symbol: 'MemoryVisibility.ORGANIZATION', documented: false });
  });

  it('does not mistake a field for an enum value once the enum block closes', () => {
    const blocks = findHashBlocks(
      sdl(`  enum Role {
    OWNER
  }

  type Query {
    # A note on a field, after an enum.
    me: User
  }`),
    );
    expect(blocks[0].symbol).toBe('Query.me');
  });

  it('names a type declaration by its type name', () => {
    const blocks = findHashBlocks(
      sdl(`  # Uniform paginated list shape.
  type SecretsPage {
    items: [Secret!]!
  }`),
    );
    expect(blocks[0].symbol).toBe('SecretsPage');
  });

  it('keeps two `#` runs separated by a blank line as ONE block', () => {
    // Splitting them reports the same note twice and, on conversion, wraps
    // each half in its own description.
    const blocks = findHashBlocks(
      sdl(`  type Query {
    # First paragraph.
    #
    # Second paragraph.
    me: User
  }`),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('First paragraph.');
    expect(blocks[0].text).toContain('Second paragraph.');
  });

  it('resolves the enclosing type per block, not globally', () => {
    const blocks = findHashBlocks(
      sdl(`  type Query {
    # A query note.
    me: User
  }

  type Mutation {
    # A mutation note.
    recordUsage(event: UsageEventInput!): Boolean!
  }`),
    );
    expect(blocks.map((b) => b.symbol)).toEqual(['Query.me', 'Mutation.recordUsage']);
  });

  it('throws rather than silently scanning nothing when the literal is not found', () => {
    // A scanner that returns [] on an unparseable file is a gate that passes
    // for the wrong reason — the failure mode this whole check exists to avoid.
    expect(() => findHashBlocks('const notTypeDefs = 1;')).toThrow(/SDL template literal/);
  });
});

describe('#1232 — the real typeDefs.ts', () => {
  it('has no `#` comment above an undocumented symbol outside the allow-list', async () => {
    // The gate itself, run in-process, so a PR that reintroduces one fails in
    // the suite and not only in CI.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../src/api/graphql/schema/typeDefs.ts', import.meta.url),
      'utf8',
    );
    const allowed = new Set(
      readFileSync(new URL('./sdl-hash-descriptions-allowed.txt', import.meta.url), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(/\s+—\s+/)[0].trim()),
    );
    const offenders = findHashBlocks(source)
      .filter((b) => !b.documented && b.symbol && !allowed.has(b.symbol))
      .map((b) => `${b.symbol} (typeDefs.ts:${b.line})`);
    expect(offenders).toEqual([]);
  });
});
