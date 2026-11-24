/**
 * #4995 item 4: `assertAppRunRefShape` and `resolveAppRunRef` each decide whether a ref can name a run. One fixture binds
 * the two: what the shape check accepts, the resolver goes on to look up; what it refuses, the resolver answers as a miss
 * without any lookup.
 */
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { resolveAppRunRef } from './appRunRef.js';
import { assertAppRunRefShape } from './appRunRefShape.js';
import { AppRunNotFoundError } from './errors.js';

const RUN = generateId();
const ACCEPTED = [
  RUN,
  'c' + 'a1'.repeat(12),
  `hrn:apprun:acme:app:${RUN}`,
  `hrn:apprun:acme.com:my-app:${RUN}`,
  `urn:apprun:acme:app:${RUN}`, // the parser still reads the old prefix
];
const REFUSED = [
  '',
  ' ',
  'not a ref',
  RUN.toUpperCase(),
  RUN.slice(1),
  'hrn:apprun:::',
  'hrn:apprun:acme:app',
  `hrn:apprun:acme:app:${RUN}:extra`,
  `hrn:apprun:acme::${RUN}`,
  `acme:app:${RUN}`,
  `hrn:nosuchtype:acme:app:${RUN}`,
  // Well formed, but another type.
  'hrn:app:acme:app',
  `hrn:node:acme:app:${RUN}`,
];

class LookupReached extends Error {}

/** Any method call on any model is the lookup. */
const tripwire = new Proxy({}, {
  get: () => new Proxy({}, { get: () => async () => { throw new LookupReached(); } }),
}) as unknown as PrismaClient;

describe('#4995 one AppRun ref predicate, two readers', () => {
  it.each(ACCEPTED)('both accept %j', async (ref) => {
    expect(() => assertAppRunRefShape(ref)).not.toThrow();
    await expect(resolveAppRunRef(tripwire, ref)).rejects.toBeInstanceOf(LookupReached);
  });

  it.each(REFUSED)('both refuse %j', async (ref) => {
    expect(() => assertAppRunRefShape(ref)).toThrow();
    await expect(resolveAppRunRef(tripwire, ref)).rejects.toBeInstanceOf(AppRunNotFoundError);
  });
});
