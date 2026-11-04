/**
 * #3423: `updateApp` takes the App-layer action-policy link (cor:acl:040:02, #510).
 *
 * The resolver always read `policy` ("explicit null clears; omitted preserves"), but the SDL never
 * declared the argument, so every real GraphQL document that sent it failed validation and the App
 * layer's link could only be set at createApp. These pins go through the real schema
 * (Apollo `executeOperation` over `typeDefs`), not a direct resolver call, which is how the old pin
 * (resolvers.adminSurface.test.ts) missed it.
 *
 * Who may set or clear: the existing updateApp gate, unchanged (`requireOwnerOrOrgRole(ctx, app,
 * 'ADMIN')`): an org ADMIN (or platform ADMIN) for an org-owned App, the owner for a user-owned App
 * (`chk_app_owner_xor`: an App has exactly one of the two). Whether to tighten that is an open
 * ruling on the issue; this build exposes the argument under the existing gate.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const server = new ApolloServer({ typeDefs, resolvers });
afterAll(async () => { await server.stop(); });

const ctx = (userId: string): Context => ({ db, roles: ['READER'], userId }) as Context;

const UPDATE = `mutation($ref: ID!, $policy: JSON, $name: String) {
  updateApp(ref: $ref, policy: $policy, name: $name) { id policy }
}`;
const UPDATE_NAME_ONLY = `mutation($ref: ID!, $name: String) { updateApp(ref: $ref, name: $name) { id } }`;

async function run(query: string, variables: Record<string, unknown>, userId: string) {
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx(userId) });
  const body = (res.body as { kind: 'single'; singleResult: { data?: any; errors?: any[] } }).singleResult;
  return body;
}
/** The public shape of a refusal: message, code and path, nothing environment-specific. */
const shape = (errors: any[] | undefined) =>
  JSON.stringify((errors ?? []).map((e) => ({ message: e.message, code: e.extensions?.code, path: e.path })));
const policyOf = async (id: string) => (await db.app.findUniqueOrThrow({ where: { id } })).policy;

let orgAdmin: { id: string };
let orgMember: { id: string };
let outsider: { id: string };
let soloOwner: { id: string };
let orgApp: { id: string };
let soloApp: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Org 3423', urn: 'org3423.test' } });
  orgAdmin = await db.user.create({ data: { id: generateId(), handle: 'admin3423' } });
  orgMember = await db.user.create({ data: { id: generateId(), handle: 'member3423' } });
  outsider = await db.user.create({ data: { id: generateId(), handle: 'outsider3423' } });
  soloOwner = await db.user.create({ data: { id: generateId(), handle: 'solo3423' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: orgMember.id, role: 'CONTRIBUTOR' },
  ] });
  orgApp = await db.app.create({ data: { id: generateId(), name: 'org app', urn: 'org3423.test:app', organizationId: org.id } });
  soloApp = await db.app.create({ data: { id: generateId(), name: 'solo app', urn: 'solo3423:app', ownerUserId: soloOwner.id } });
});

describe('#3423 updateApp(policy) through the real schema', () => {
  it('an org ADMIN sets the link with a real document', async () => {
    const out = await run(UPDATE, { ref: orgApp.id, policy: { allow: ['run.execute'] } }, orgAdmin.id);
    expect(out.errors).toBeUndefined();
    expect(out.data.updateApp.policy).toEqual({ allow: ['run.execute'] });
    expect(await policyOf(orgApp.id)).toEqual({ allow: ['run.execute'] });
  });

  it('an explicit null clears the link (a literal null in the document, not only a variable)', async () => {
    await db.app.update({ where: { id: orgApp.id }, data: { policy: { allow: ['run.execute'] } } });
    const out = await run(`mutation($ref: ID!) { updateApp(ref: $ref, policy: null) { id policy } }`, { ref: orgApp.id }, orgAdmin.id);
    expect(out.errors).toBeUndefined();
    expect(out.data.updateApp.policy).toBeNull();
    expect(await policyOf(orgApp.id)).toBeNull();
  });

  it('a literal object in the document validates too', async () => {
    const out = await run(`mutation($ref: ID!) { updateApp(ref: $ref, policy: { allow: ["llm.invoke"] }) { id policy } }`,
      { ref: orgApp.id }, orgAdmin.id);
    expect(out.errors).toBeUndefined();
    expect(await policyOf(orgApp.id)).toEqual({ allow: ['llm.invoke'] });
  });

  it('CONTROL: omitting policy preserves the stored link', async () => {
    await db.app.update({ where: { id: orgApp.id }, data: { policy: { allow: ['run.execute'] } } });
    const out = await run(UPDATE_NAME_ONLY, { ref: orgApp.id, name: 'renamed' }, orgAdmin.id);
    expect(out.errors).toBeUndefined();
    expect(await policyOf(orgApp.id)).toEqual({ allow: ['run.execute'] });
  });

  it('a malformed link reaches the resolver and is refused BAD_USER_INPUT, nothing stored', async () => {
    const out = await run(UPDATE, { ref: orgApp.id, policy: { allow: 'oops' } }, orgAdmin.id);
    expect(out.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(out.errors?.[0]?.message).toBe('policy must be { allow: string[] } or null.');
    expect(await policyOf(orgApp.id)).toBeNull();
  });

  it('the owner of a user-owned App sets and clears its link (the existing gate, unchanged)', async () => {
    const set = await run(UPDATE, { ref: soloApp.id, policy: { allow: ['memory.*'] } }, soloOwner.id);
    expect(set.errors).toBeUndefined();
    expect(await policyOf(soloApp.id)).toEqual({ allow: ['memory.*'] });
    const cleared = await run(UPDATE, { ref: soloApp.id, policy: null }, soloOwner.id);
    expect(cleared.errors).toBeUndefined();
    expect(await policyOf(soloApp.id)).toBeNull();
  });

  for (const who of ['orgMember', 'outsider', 'soloOwner'] as const) {
    it(`${who} cannot set or clear an org-owned App's link: the same refusal as for any other updateApp field`, async () => {
      const caller = { orgMember, outsider, soloOwner }[who].id;
      await db.app.update({ where: { id: orgApp.id }, data: { policy: { allow: ['run.execute'] } } });
      const baseline = await run(UPDATE_NAME_ONLY, { ref: orgApp.id, name: 'x' }, caller);
      expect(baseline.errors?.length).toBe(1);
      for (const policy of [{ allow: ['*'] }, null]) {
        const out = await run(UPDATE, { ref: orgApp.id, policy }, caller);
        expect(shape(out.errors)).toBe(shape(baseline.errors));
      }
      expect(await policyOf(orgApp.id)).toEqual({ allow: ['run.execute'] });
    });
  }

  for (const who of ['orgAdmin', 'outsider'] as const) {
    it(`${who} cannot set or clear a user-owned App's link: the same refusal as for any other updateApp field`, async () => {
      const caller = { orgAdmin, outsider }[who].id;
      await db.app.update({ where: { id: soloApp.id }, data: { policy: { allow: ['run.execute'] } } });
      const baseline = await run(UPDATE_NAME_ONLY, { ref: soloApp.id, name: 'x' }, caller);
      expect(baseline.errors?.length).toBe(1);
      for (const policy of [{ allow: ['*'] }, null]) {
        const out = await run(UPDATE, { ref: soloApp.id, policy }, caller);
        expect(shape(out.errors)).toBe(shape(baseline.errors));
      }
      expect(await policyOf(soloApp.id)).toEqual({ allow: ['run.execute'] });
    });
  }

  it('SDL: the explicit-null wording sits on updateApp.policy, not on createApp.policy', async () => {
    const { buildSchema } = await import('graphql');
    const mutation = buildSchema(typeDefs).getMutationType()!.getFields();
    const update = mutation.updateApp.args.find((a) => a.name === 'policy');
    const create = mutation.createApp.args.find((a) => a.name === 'policy');
    expect(update?.type.toString()).toBe('JSON');
    expect(update?.description).toMatch(/Explicit null clears; omitted preserves/);
    expect(create?.description ?? '').not.toMatch(/omitted preserves/);
  });
});
