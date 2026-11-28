/**
 * #5356 (hrn:node:hadronmemory.com:specs:cor:sec:070:02): the `createSecret` description names each staged-change cap by
 * its scope, with the number the code enforces, and attributes each refusal code to the caps that raise it. Vera's FIT:
 * SECRET_CHANGE_REQUESTER_LIMIT covers BOTH requester caps (per secret name and across the App), so it is named once,
 * for both. The numbers come from the constants, so a changed bound turns this red until the text follows.
 */
import { describe, expect, it } from 'vitest';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import {
  MAX_OPEN_SECRET_CHANGES,
  MAX_OPEN_SECRET_CHANGES_PER_APP,
  MAX_OPEN_SECRET_CHANGES_PER_REQUESTER,
  MAX_OPEN_SECRET_CHANGES_PER_REQUESTER_PER_APP,
} from './changeRequests.js';

/** The `createSecret` field description, whitespace collapsed (the SDL wraps its prose). */
function createSecretDescription(): string {
  const at = typeDefs.indexOf('\n    createSecret(');
  expect(at).toBeGreaterThan(0);
  const close = typeDefs.lastIndexOf('"""', at);
  const open = typeDefs.lastIndexOf('"""', close - 1);
  return typeDefs.slice(open + 3, close).replace(/\s+/g, ' ').trim();
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('#5356 createSecret SDL: staged-change caps', () => {
  const text = createSecretDescription();

  it('names each cap by its scope with the enforced number, and the code that refuses it', () => {
    expect(text).toContain(`at most ${MAX_OPEN_SECRET_CHANGES} per secret name (SECRET_CHANGE_REQUEST_LIMIT)`);
    expect(text).toContain(
      `at most ${MAX_OPEN_SECRET_CHANGES_PER_REQUESTER} per requester for one secret name and at most `
      + `${MAX_OPEN_SECRET_CHANGES_PER_REQUESTER_PER_APP} per requester across the App, both refused with `
      + 'SECRET_CHANGE_REQUESTER_LIMIT',
    );
    expect(text).toContain(`at most ${MAX_OPEN_SECRET_CHANGES_PER_APP} across the App (SECRET_CHANGE_APP_LIMIT)`);
  });

  it('names each code once, so no code is attached to two different numbers', () => {
    for (const code of ['SECRET_CHANGE_REQUEST_LIMIT', 'SECRET_CHANGE_REQUESTER_LIMIT', 'SECRET_CHANGE_APP_LIMIT']) {
      expect(count(text, code), code).toBe(1);
    }
  });

  it('keeps the engineering-bound sentence and the 500-secret sentence, once each', () => {
    expect(count(text, 'engineering bounds, not ruled values')).toBe(1);
    expect(count(text, "toward the App's 500-secret limit")).toBe(1);
  });
});
