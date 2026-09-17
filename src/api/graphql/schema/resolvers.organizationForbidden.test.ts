/**
 * `Query.organization(ref:)`'s non-member refusal carries a TYPED code.
 *
 * The arm threw a bare `new Error('Forbidden')`, which reaches the wire as
 * INTERNAL_SERVER_ERROR. Two sibling refusals in the same file already threw
 * `GraphQLError` with `extensions.code = 'FORBIDDEN'`, so the odd one out was
 * indistinguishable — to any client — from the server having fallen over.
 *
 * It was not academic. hadron-portal#843: the portal could not tell "you may
 * not read this org" from "the API is down", so it mapped INTERNAL_SERVER_ERROR
 * to 404 and told users their organization did not exist whenever the backend
 * was unavailable. Requested by the portal engineer with the mapping already
 * merged on their side, so this closes that issue with a deletion there.
 *
 * Governed by conventions:the-error-code-is-the-contract-the-prose-is-not —
 * the CODE is what three surfaces branch on; the message is for humans.
 *
 * Scope: ONE call site. `new Error('Forbidden')` appears ~60 times across these
 * resolvers, and the sweep is a wire-contract change across every client. Not
 * this change.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string; urn: string };
let member: { id: string };
let outsider: { id: string };
let platformAdmin: { id: string };

const ctxFor = (userId: string, roles: string[] = []): Context =>
  ({ db, userId, roles }) as Context;

beforeEach(async () => {
  await cleanDb(db);

  org = await db.organization.create({
    data: { id: generateId(), name: 'forbidden-test-org', urn: 'forbidden-test-org.test' },
  });

  member = await db.user.create({
    data: { id: generateId(), githubId: 8401, githubUsername: 'fb-member', roles: [] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: member.id, role: 'READER' },
  });

  outsider = await db.user.create({
    data: { id: generateId(), githubId: 8402, githubUsername: 'fb-outsider', roles: [] },
  });

  platformAdmin = await db.user.create({
    data: { id: generateId(), githubId: 8403, githubUsername: 'fb-admin', roles: ['ADMIN'] },
  });
});

describe('Query.organization(ref:) — the non-member refusal is typed', () => {
  it('refuses a non-member with extensions.code FORBIDDEN, not a bare Error', async () => {
    const err = await resolvers.Query.organization(
      {},
      { ref: org.id },
      ctxFor(outsider.id),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GraphQLError);
    // The assertion that matters: the CODE, which is what clients branch on.
    // A bare Error reaches the wire as INTERNAL_SERVER_ERROR and is
    // indistinguishable from the server being down (hadron-portal#843).
    expect((err as GraphQLError).extensions?.code).toBe('FORBIDDEN');
    expect((err as GraphQLError).extensions?.code).not.toBe('INTERNAL_SERVER_ERROR');
  });

  it('still refuses — the change is the code, not the gate', async () => {
    // Guards the opposite failure: typing the error while accidentally letting
    // the caller through would satisfy an assertion about the code alone.
    await expect(
      resolvers.Query.organization({}, { ref: org.id }, ctxFor(outsider.id)),
    ).rejects.toThrow(/forbidden/i);
  });

  it('a MEMBER still reads the org', async () => {
    const result = await resolvers.Query.organization({}, { ref: org.id }, ctxFor(member.id));
    expect(result?.id).toBe(org.id);
  });

  it('a platform ADMIN still resolves any org by ref (spec 048)', async () => {
    // The `isAdmin` escape hatch above the refusal — every org is listable
    // since isVisible was dropped, so an admin is not a non-member for this.
    const result = await resolvers.Query.organization(
      {},
      { ref: org.id },
      ctxFor(platformAdmin.id, ['ADMIN']),
    );
    expect(result?.id).toBe(org.id);
  });
});
