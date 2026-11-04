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
 * (`chk_app_owner_xor`: an App has exactly one of the two). Ruling 0135 chose that gate as built, and
 * cor:acl:040:07 states it. The platform-ADMIN arm on an org-owned App is as built with no ruling of
 * its own (that rule's Edge Cases).
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

const ctx = (userId: string, roles: string[] = ['READER']): Context => ({ db, roles, userId }) as Context;

const UPDATE = `mutation($ref: ID!, $policy: JSON, $name: String) {
  updateApp(ref: $ref, policy: $policy, name: $name) { id policy }
}`;
const UPDATE_NAME_ONLY = `mutation($ref: ID!, $name: String) { updateApp(ref: $ref, name: $name) { id } }`;

async function run(query: string, variables: Record<string, unknown>, userId: string, roles?: string[]) {
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx(userId, roles) });
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

/**
 * #3428: the three P3 pins the #3425 seats asked for (Beckett BLIND, Rodolfo §10, Bruno LOCAL).
 * Test-only; the gate and the resolver are untouched. Same real-schema path as above: Apollo
 * `executeOperation` over `typeDefs`, so variable coercion is the server's, not a direct call.
 */
describe('#3428 updateApp(policy): variables, platform ADMIN, refusal order', () => {
  const STORED = { allow: ['run.execute'] };
  let platformAdmin: { id: string };
  beforeEach(async () => {
    // A platform ADMIN who is in no org and owns nothing: whatever it can do here comes from the
    // platform role alone.
    platformAdmin = await db.user.create({ data: { id: generateId(), handle: 'platform3428' } });
  });

  describe('pin 1: the nullable JSON variable', () => {
    it('a $policy object sets the link', async () => {
      const out = await run(UPDATE, { ref: orgApp.id, policy: { allow: ['memory.*'] } }, orgAdmin.id);
      expect(out.errors).toBeUndefined();
      expect(await policyOf(orgApp.id)).toEqual({ allow: ['memory.*'] });
    });

    it('$policy: null clears the link (the variable, not a literal)', async () => {
      await db.app.update({ where: { id: orgApp.id }, data: { policy: STORED } });
      const out = await run(UPDATE, { ref: orgApp.id, policy: null }, orgAdmin.id);
      expect(out.errors).toBeUndefined();
      expect(out.data.updateApp.policy).toBeNull();
      expect(await policyOf(orgApp.id)).toBeNull();
    });

    it('$policy declared in the document but omitted from the variables preserves the link', async () => {
      await db.app.update({ where: { id: orgApp.id }, data: { policy: STORED } });
      // UPDATE declares $policy; the variables carry no policy key at all.
      const out = await run(UPDATE, { ref: orgApp.id, name: 'renamed' }, orgAdmin.id);
      expect(out.errors).toBeUndefined();
      expect(out.data.updateApp.policy).toEqual(STORED);
      expect(await policyOf(orgApp.id)).toEqual(STORED);
      expect((await db.app.findUniqueOrThrow({ where: { id: orgApp.id } })).name).toBe('renamed');
    });
  });

  describe('pin 2: a platform ADMIN (platform role, no org membership)', () => {
    // Two arms admit here: requireOwnerOrOrgRole's platform bypass and requireOrgRole's own platform
    // short-circuit. Removing either alone leaves the other admitting (equivalent mutants); removing
    // both turns this red.
    it('sets and clears an org-owned App\'s link (as built, no ruling of its own: cor:acl:040:07 Edge Cases)', async () => {
      const set = await run(UPDATE, { ref: orgApp.id, policy: STORED }, platformAdmin.id, ['ADMIN']);
      expect(set.errors).toBeUndefined();
      expect(await policyOf(orgApp.id)).toEqual(STORED);
      const cleared = await run(UPDATE, { ref: orgApp.id, policy: null }, platformAdmin.id, ['ADMIN']);
      expect(cleared.errors).toBeUndefined();
      expect(await policyOf(orgApp.id)).toBeNull();
    });

    // BUILT-AS, NOT LAW (hadron-server#1734). cor:dmo:050:12 (Decided) counts platform admins among
    // those who manage a user-owned App too; its Built line records that as not built, tracked in
    // #1734, and cor:acl:040:07 lists whether a platform admin may write this link as open to change.
    // Today requireOwnerOrOrgRole runs spec 047's strict owner-only branch before the platform bypass,
    // so the platform ADMIN is refused. This pins that built boundary so a change to it is deliberate:
    // whoever builds #1734 (or a later ruling that changes the gate) flips this expectation knowingly.
    // It is not a guard on a platform rule.
    it('is refused on someone else\'s user-owned App, policy unchanged (gate as built under #1734)', async () => {
      await db.app.update({ where: { id: soloApp.id }, data: { policy: STORED } });
      const baseline = await run(UPDATE_NAME_ONLY, { ref: soloApp.id, name: 'x' }, platformAdmin.id, ['ADMIN']);
      expect(baseline.errors?.length).toBe(1);
      expect(baseline.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      for (const policy of [{ allow: ['*'] }, null]) {
        const out = await run(UPDATE, { ref: soloApp.id, policy }, platformAdmin.id, ['ADMIN']);
        expect(shape(out.errors)).toBe(shape(baseline.errors));
      }
      expect(await policyOf(soloApp.id)).toEqual(STORED);
    });
  });

  describe('pin 3: refusal before shape validation (no shape oracle; the cor:dmo:050:20 pattern)', () => {
    const MALFORMED = [{ allow: 'oops' }, { deny: ['x'] }, ['run.execute'], 'run.execute', 7];
    for (const [who, app] of [['orgMember', 'org'], ['outsider', 'org'], ['outsider', 'solo'], ['orgAdmin', 'solo']] as const) {
      it(`${who} sending a malformed link to the ${app}-owned App gets FORBIDDEN, never BAD_USER_INPUT, nothing stored`, async () => {
        const caller = { orgMember, outsider, orgAdmin }[who].id;
        const target = app === 'org' ? orgApp : soloApp;
        await db.app.update({ where: { id: target.id }, data: { policy: STORED } });
        const baseline = await run(UPDATE_NAME_ONLY, { ref: target.id, name: 'x' }, caller);
        expect(baseline.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
        for (const policy of MALFORMED) {
          const out = await run(UPDATE, { ref: target.id, policy }, caller);
          expect(shape(out.errors)).toBe(shape(baseline.errors));
        }
        expect(await policyOf(target.id)).toEqual(STORED);
      });
    }

    it('CONTROL: the same malformed links from an authorized caller are BAD_USER_INPUT (so the pins above are not vacuous)', async () => {
      for (const policy of MALFORMED) {
        const out = await run(UPDATE, { ref: orgApp.id, policy }, orgAdmin.id);
        expect(out.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
      }
      expect(await policyOf(orgApp.id)).toBeNull();
    });
  });
});
