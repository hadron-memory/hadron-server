/** #2951: source comments feed generated reference docs; keep these two contracts explicit. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const prisma = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const sdl = readFileSync(new URL('../api/graphql/schema/typeDefs.ts', import.meta.url), 'utf8');

function revisionHashComment(): string {
  const model = prisma.match(/model NodeRevision \{([\s\S]*?)\n\}/)?.[1];
  expect(model, 'NodeRevision model must be present').toBeDefined();
  const comment = model!.match(/((?:[ \t]*\/\/\/[^\n]*\n)+)[ \t]*abstractOriginHash\b/)?.[1];
  expect(comment, 'abstractOriginHash must have a generated-doc comment').toBeDefined();
  return comment!.replace(/^\s*\/\/\/ ?/gm, '').replace(/\s+/g, ' ').trim();
}

function searchPageDescription(): string {
  const description = sdl.match(/"""((?:(?!""")[\s\S])*)"""\s*type TeamChatSearchPage\b/)?.[1];
  expect(description, 'TeamChatSearchPage must have an SDL description, not a discarded # comment').toBeDefined();
  return description!.replace(/\s+/g, ' ').trim();
}

describe('#2951 generated-reference source comments', () => {
  it('restoring a NULL origin hash preserves the unverified state when both texts exist', () => {
    const text = revisionHashComment();
    expect(text).not.toContain('short-circuits');
    expect(text).toContain('snapshot of `Node.abstractOriginHash`');
    expect(text).toContain('Restored verbatim by `restoreNodeRevision`');
    expect(text).toContain('both an abstract and content');
    expect(text).toContain('unverified, neither stale nor fresh');
    expect(text).toContain('no abstract or no content needs no check');
  });

  it('no matches describes every page, not just an empty terminal page', () => {
    const text = searchPageDescription();
    expect(text).not.toContain('No matches is only ever an empty page');
    expect(text).toContain('only when every page it returned was empty and the last one has complete true');
    expect(text).toContain('A final empty page with complete true can follow pages that had matches');
    expect(text).toContain('An empty page with complete false means the scan bound fired');
    expect(text).toContain('continue with the cursor');
  });
});
