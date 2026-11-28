/**
 * #5412 section 5 (gate ruling issuecomment-7238581276 condition 2): the structural drift pin for the branch-only Node guard. Every
 * field of the SDL `type Node` (definition and extensions, read from the parsed AST) is in exactly one of BRANCH_GUARDED_FIELDS and
 * BRANCH_OWN_FIELDS, so a field the Node type gains later fails here until someone decides what a branch-only node answers for it.
 */
import { describe, expect, it } from 'vitest';
import { typeDefs } from './typeDefs.js';
import { nodeFieldNamesFromSdl } from './installMemory.js';
import { BRANCH_GUARDED_FIELDS, BRANCH_OWN_FIELDS } from './branchNodeFields.js';
import { resolvers } from './resolvers.js';

const sdl = String((typeDefs as { loc?: { source?: { body?: string } } }).loc?.source?.body ?? typeDefs);
const fields = nodeFieldNamesFromSdl(sdl);
const own = Object.keys(BRANCH_OWN_FIELDS);

describe('#5412 branch-only Node guard: every Node field is decided', () => {
  it('no Node field is in neither map', () => {
    expect(fields.filter((f) => !BRANCH_GUARDED_FIELDS.includes(f) && !own.includes(f))).toEqual([]);
  });
  it('no field is in both maps', () => {
    expect(BRANCH_GUARDED_FIELDS.filter((f) => own.includes(f))).toEqual([]);
  });
  it('no map names a field the Node type does not have (a stale entry hides a rename)', () => {
    expect([...BRANCH_GUARDED_FIELDS, ...own].filter((f) => !fields.includes(f))).toEqual([]);
  });
  it('every guarded field is wrapped on the served Node resolver map', () => {
    const N = (resolvers as unknown as { Node: Record<string, unknown> }).Node;
    expect(BRANCH_GUARDED_FIELDS.filter((f) => typeof N[f] !== 'function')).toEqual([]);
  });
});
