/**
 * hadron-server#5012 (Billing A5): the BILLING platform role.
 *
 * A user whose only platform role is BILLING may write credit grants and
 * adjustments (`grantCredits`, `adjustCredits`) and nothing else; BILLING is
 * refused as an organization member's, a memory subscription's and an
 * invitation's role; it is never combined with another platform role; and every
 * change of a user's platform roles writes one `user.roles.changed` line.
 *
 * Spec: hrn:node:hadronmemory.com:specs:cor:api:010:01 (Proposed line: the ledger
 * writes are for a platform admin or the billing role and nobody else; the
 * billing role admits no other call and is never an organization, subscription
 * or invitation role). Gate rulings (issue #5012, CHECKED): 10.1 BILLING with any
 * other role is BAD_USER_INPUT; 10.2 code refusals plus the G1 inventory, no
 * CHECK constraints; 10.5 a role-unioning merge writes the line too; 10.6
 * inviteUser / acceptInvitation take no caller role.
 *
 * The resolver pins run on a context built THROUGH the auth middleware (an
 * `hdr_user_` key of a stored BILLING user), so they exercise the real role
 * filter, not a hand-made context.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { ApolloServer } from '@apollo/server';

import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import { generateId } from '../../../lib/id.js';
import { mintUserApiKey, resolveAuthContext } from '../../../middleware/auth.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function gql(query: string, ctx: Partial<Context>, variables?: Record<string, unknown>) {
  const res = await server.executeOperation(
    { query, variables },
    { contextValue: { db, ...ctx } as Context },
  );
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}
type Result = Awaited<ReturnType<typeof gql>>;
const code = (res: Result) => res.errors?.[0]?.extensions?.code;

/** The one fixed refusal for BILLING as a member, subscription or invitation role. */
const MEMBER_ROLE_REFUSAL =
  'BILLING is a platform role and cannot be given to a member, a subscription or an invitation.';
/** The one fixed refusal for BILLING combined with another platform role (ruling 10.1). */
const COMBINED_REFUSAL = 'BILLING cannot be combined with another platform role.';

const GRANT = `mutation($input: GrantCreditsInput!) { grantCredits(input: $input) { id amountMicroCents } }`;
const ADJUST = `mutation($input: AdjustCreditsInput!) { adjustCredits(input: $input) { id amountMicroCents } }`;
const BALANCE = `query($orgRef: String!) { creditBalance(orgRef: $orgRef) { balanceMicroCents } }`;
const PRICE = `mutation { setAiModelPrice(input: {
  provider: "anthropic", model: "claude-x", inputMicroCentsPerMTok: "1", outputMicroCentsPerMTok: "1"
}) { id } }`;
const USAGE = `query($m: ID!) { memoryUsageSummary(memoryRef: $m) { nodeLoc } }`;
const ROLES = `mutation($u: ID!, $r: [Role!]!) { updateUserRoles(userId: $u, roles: $r) { id roles } }`;

let billingUser: string, platformAdmin: string, orgAdmin: string, member: string, outsider: string;
let orgId: string, ownerOrgId: string, memoryId: string;
let billingKey: string;

const platformCtx = (): Partial<Context> => ({ userId: platformAdmin, roles: ['ADMIN'] });
const orgAdminCtx = (): Partial<Context> => ({ userId: orgAdmin, roles: ['READER'] });
const outsiderCtx = (): Partial<Context> => ({ userId: outsider, roles: ['READER'] });

/** The billing user's context, as the auth middleware builds it from the stored row. */
async function billingCtx(): Promise<Partial<Context>> {
  const req = { headers: { authorization: `Bearer ${billingKey}` } } as unknown as Request;
  const auth = await resolveAuthContext(req, db);
  expect(auth.userId).toBe(billingUser);
  return auth as Partial<Context>;
}

const grantInput = (over: Record<string, unknown> = {}) => ({
  orgRef: orgId, amountMicroCents: '1000', sourceType: 'stripe-checkout', sourceId: 'cs_1', ...over,
});
const adjustInput = (over: Record<string, unknown> = {}) => ({
  orgRef: orgId, amountMicroCents: '-300', sourceType: 'refund', sourceId: 'r1', note: 'partial refund', ...over,
});

async function balance(): Promise<string> {
  const res = await gql(BALANCE, platformCtx(), { orgRef: orgId });
  expect(res.errors).toBeUndefined();
  return (res.data as { creditBalance: { balanceMicroCents: string } }).creditBalance.balanceMicroCents;
}

let logSpy: ReturnType<typeof vi.spyOn>;
const roleLines = () =>
  logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('user.roles.changed'));

beforeEach(async () => {
  await cleanDb(db);
  logSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  const mkUser = (n: number, name: string, roles: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER' | 'BILLING')[]) =>
    db.user.create({ data: { id: generateId(), githubId: 50_120 + n, githubUsername: name, handle: name, roles } });
  billingUser = (await mkUser(1, 'bill-svc', ['BILLING'])).id;
  platformAdmin = (await mkUser(2, 'bill-platform', ['ADMIN'])).id;
  orgAdmin = (await mkUser(3, 'bill-orgadmin', ['READER'])).id;
  member = (await mkUser(4, 'bill-member', ['READER'])).id;
  outsider = (await mkUser(5, 'bill-outsider', ['READER'])).id;
  billingKey = (await mintUserApiKey(db, {
    userId: billingUser, label: 'billing-service', createdBy: billingUser, issuedVia: 'admin',
  })).rawKey;

  orgId = (await db.organization.create({ data: { id: generateId(), name: 'bill-org', urn: 'bill-org' } })).id;
  ownerOrgId = (await db.organization.create({ data: { id: generateId(), name: 'bill-owner', urn: 'bill-owner' } })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: orgAdmin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: member, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: ownerOrgId, userId: orgAdmin, role: 'ADMIN' } });
  memoryId = (await db.memory.create({
    data: {
      id: generateId(), organizationId: ownerOrgId, urn: 'bill-owner:pub', name: 'pub',
      class: 'knowledge', visibility: 'PUBLIC',
    },
  })).id;
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('R1: a BILLING-only user writes the ledger', () => {
  it('grantCredits and adjustCredits succeed with a context the middleware built', async () => {
    const ctx = await billingCtx();
    const g = await gql(GRANT, ctx, { input: grantInput() });
    expect(g.errors).toBeUndefined();
    const a = await gql(ADJUST, ctx, { input: adjustInput() });
    expect(a.errors).toBeUndefined();
    expect(await balance()).toBe('700');
  });
});

describe('R2: the BILLING-only user reaches nothing else', () => {
  it('setAiModelPrice is FORBIDDEN', async () => {
    const res = await gql(PRICE, await billingCtx());
    expect(code(res)).toBe('FORBIDDEN');
    expect(await db.aiModelPrice.count()).toBe(0);
  });

  it('creditBalance of an organization is FORBIDDEN', async () => {
    const res = await gql(BALANCE, await billingCtx(), { orgRef: orgId });
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('a READER-gated query (memoryUsageSummary) is FORBIDDEN', async () => {
    const res = await gql(USAGE, await billingCtx(), { m: memoryId });
    expect(code(res)).toBe('FORBIDDEN');
  });

  it('updateUserRoles on itself to ADMIN is FORBIDDEN (the unrelated admin mutation, and escalation)', async () => {
    const res = await gql(ROLES, await billingCtx(), { u: billingUser, r: ['ADMIN'] });
    expect(code(res)).toBe('FORBIDDEN');
    expect((await db.user.findUniqueOrThrow({ where: { id: billingUser } })).roles).toEqual(['BILLING']);
  });
});

describe('R4: BILLING never reaches the ledger through an impersonated session or an App key', () => {
  it('an impersonated context carrying BILLING is FORBIDDEN on grantCredits and adjustCredits', async () => {
    const ctx: Partial<Context> = {
      userId: billingUser,
      roles: ['BILLING'],
      impersonation: { sessionId: 'imp-1', actorUserId: platformAdmin, orgId, expiresAt: new Date(Date.now() + 60_000) },
    };
    expect(code(await gql(GRANT, ctx, { input: grantInput() }))).toBe('FORBIDDEN');
    expect(code(await gql(ADJUST, ctx, { input: adjustInput() }))).toBe('FORBIDDEN');
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });

  it('an App-key context carrying BILLING is FORBIDDEN', async () => {
    const ctx: Partial<Context> = { appId: generateId(), appKeyId: generateId(), roles: ['BILLING'] };
    expect(code(await gql(GRANT, ctx, { input: grantInput() }))).toBe('FORBIDDEN');
    expect(await db.creditLedgerEntry.count()).toBe(0);
  });
});

describe('grantCredits refuses a forbidden caller before resolving the organization (#5064 P3-1)', () => {
  it('an org ADMIN naming an organization that does not exist gets FORBIDDEN / Forbidden', async () => {
    const res = await gql(GRANT, orgAdminCtx(), { input: grantInput({ orgRef: 'no-such-org' }) });
    expect(code(res)).toBe('FORBIDDEN');
    expect(res.errors?.[0]?.message).toBe('Forbidden');
  });
});

describe('adjustCredits refuses a forbidden caller before resolving the organization (#5090 LOCAL P3-1)', () => {
  it('an org ADMIN naming an organization that does not exist gets FORBIDDEN / Forbidden', async () => {
    const res = await gql(ADJUST, orgAdminCtx(), { input: adjustInput({ orgRef: 'no-such-org' }) });
    expect(code(res)).toBe('FORBIDDEN');
    expect(res.errors?.[0]?.message).toBe('Forbidden');
  });
});

// ── R5 / R6: BILLING as a member, subscription or invitation role ──────────

const ADD_MEMBER = `mutation($o: ID!, $u: ID!, $r: Role!) { addOrgMember(orgRef: $o, userRef: $u, role: $r) { role } }`;
const UPDATE_MEMBER = `mutation($o: ID!, $u: ID!, $r: Role!) { updateOrgMember(orgRef: $o, userRef: $u, role: $r) { role } }`;
const INVITE = `mutation($o: ID!, $r: Role!) { createUserInvitation(orgRef: $o, memberRole: $r, email: "x@example.com") { id } }`;
const CREATE_SUB = `mutation($m: ID!, $o: ID!, $r: Role!) { createMemorySubscription(memoryRef: $m, orgRef: $o, role: $r) { role } }`;
const UPDATE_SUB = `mutation($m: ID!, $o: ID!, $r: Role!) { updateMemorySubscription(memoryRef: $m, orgRef: $o, role: $r) { role } }`;

function expectMemberRoleRefusal(res: Result) {
  expect(code(res)).toBe('BAD_USER_INPUT');
  expect(res.errors?.[0]?.message).toBe(MEMBER_ROLE_REFUSAL);
}
/** The gate's own refusal, not the role refusal (judged after the gate). */
function expectGateRefusal(res: Result) {
  expect(res.errors?.length).toBeGreaterThan(0);
  expect(code(res)).not.toBe('BAD_USER_INPUT');
  expect(res.errors?.[0]?.message).not.toBe(MEMBER_ROLE_REFUSAL);
}

describe('R5: BILLING as a role value is BAD_USER_INPUT, and nothing is written', () => {
  it('addOrgMember(role: BILLING)', async () => {
    const res = await gql(ADD_MEMBER, orgAdminCtx(), { o: orgId, u: outsider, r: 'BILLING' });
    expectMemberRoleRefusal(res);
    expect(await db.orgMember.count({ where: { organizationId: orgId, userId: outsider } })).toBe(0);
  });

  it('updateOrgMember(role: BILLING)', async () => {
    const res = await gql(UPDATE_MEMBER, orgAdminCtx(), { o: orgId, u: member, r: 'BILLING' });
    expectMemberRoleRefusal(res);
    const row = await db.orgMember.findFirstOrThrow({ where: { organizationId: orgId, userId: member } });
    expect(row.role).toBe('READER');
  });

  it('createUserInvitation(memberRole: BILLING)', async () => {
    const res = await gql(INVITE, orgAdminCtx(), { o: orgId, r: 'BILLING' });
    expectMemberRoleRefusal(res);
    expect(await db.userInvitation.count()).toBe(0);
  });

  it('createMemorySubscription(role: BILLING)', async () => {
    const res = await gql(CREATE_SUB, orgAdminCtx(), { m: memoryId, o: orgId, r: 'BILLING' });
    expectMemberRoleRefusal(res);
    expect(await db.memorySubscription.count()).toBe(0);
  });

  it('updateMemorySubscription(role: BILLING)', async () => {
    await db.memorySubscription.create({
      data: { id: generateId(), memoryId, organizationId: orgId, role: 'READER' },
    });
    const res = await gql(UPDATE_SUB, orgAdminCtx(), { m: memoryId, o: orgId, r: 'BILLING' });
    expectMemberRoleRefusal(res);
    expect((await db.memorySubscription.findFirstOrThrow({ where: { memoryId } })).role).toBe('READER');
  });
});

describe('R6: a caller who fails the gate gets the gate\'s refusal, whatever the role value', () => {
  it('addOrgMember', async () => {
    expectGateRefusal(await gql(ADD_MEMBER, outsiderCtx(), { o: orgId, u: outsider, r: 'BILLING' }));
  });
  it('updateOrgMember', async () => {
    expectGateRefusal(await gql(UPDATE_MEMBER, outsiderCtx(), { o: orgId, u: member, r: 'BILLING' }));
  });
  it('createUserInvitation', async () => {
    expectGateRefusal(await gql(INVITE, outsiderCtx(), { o: orgId, r: 'BILLING' }));
  });
  it('createMemorySubscription', async () => {
    expectGateRefusal(await gql(CREATE_SUB, outsiderCtx(), { m: memoryId, o: orgId, r: 'BILLING' }));
  });
  it('updateMemorySubscription', async () => {
    await db.memorySubscription.create({
      data: { id: generateId(), memoryId, organizationId: orgId, role: 'READER' },
    });
    expectGateRefusal(await gql(UPDATE_SUB, outsiderCtx(), { m: memoryId, o: orgId, r: 'BILLING' }));
  });
});

// ── Ruling 10.1 and R7: updateUserRoles ────────────────────────────────────

describe('ruling 10.1: BILLING is never combined with another platform role', () => {
  for (const roles of [['BILLING', 'READER'], ['ADMIN', 'BILLING'], ['BILLING', 'OWNER', 'CONTRIBUTOR']]) {
    it(`updateUserRoles(${roles.join(',')}) is BAD_USER_INPUT and changes nothing`, async () => {
      const res = await gql(ROLES, platformCtx(), { u: member, r: roles });
      expect(code(res)).toBe('BAD_USER_INPUT');
      expect(res.errors?.[0]?.message).toBe(COMBINED_REFUSAL);
      expect((await db.user.findUniqueOrThrow({ where: { id: member } })).roles).toEqual(['READER']);
      expect(roleLines()).toEqual([]);
    });
  }

  it('a non-admin caller gets the gate refusal, not the combination refusal', async () => {
    const res = await gql(ROLES, outsiderCtx(), { u: member, r: ['BILLING', 'READER'] });
    expect(code(res)).toBe('FORBIDDEN');
  });
});

describe('R7: updateUserRoles writes one user.roles.changed line after commit', () => {
  it('READER -> BILLING by a platform admin', async () => {
    const res = await gql(ROLES, platformCtx(), { u: member, r: ['BILLING'] });
    expect(res.errors).toBeUndefined();
    expect((await db.user.findUniqueOrThrow({ where: { id: member } })).roles).toEqual(['BILLING']);
    expect(roleLines()).toEqual([
      `user.roles.changed actor=${platformAdmin} target=${member} before=READER after=BILLING`,
    ]);
  });

  it('roles are sorted, and an empty side is written empty', async () => {
    await gql(ROLES, platformCtx(), { u: member, r: ['READER', 'ADMIN', 'CONTRIBUTOR'] });
    await gql(ROLES, platformCtx(), { u: member, r: [] });
    expect(roleLines()).toEqual([
      `user.roles.changed actor=${platformAdmin} target=${member} before=READER after=ADMIN,CONTRIBUTOR,READER`,
      `user.roles.changed actor=${platformAdmin} target=${member} before=ADMIN,CONTRIBUTOR,READER after=`,
    ]);
  });

  it('the line is written after the transaction commits, never inside it', async () => {
    const order: string[] = [];
    logSpy.mockImplementation(() => { order.push('log'); });
    // The same client, with $transaction reporting when the transaction has committed.
    const observed = new Proxy(db, {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (...args: unknown[]) => {
            const out = await (target.$transaction as (...a: unknown[]) => Promise<unknown>)(...args);
            order.push('commit');
            return out;
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await gql(ROLES, { ...platformCtx(), db: observed as typeof db }, { u: member, r: ['BILLING'] });
    expect(res.errors).toBeUndefined();
    expect(order).toEqual(['commit', 'log']);
  });

  it('a refused call logs nothing', async () => {
    const res = await gql(ROLES, outsiderCtx(), { u: member, r: ['BILLING'] });
    expect(code(res)).toBe('FORBIDDEN');
    expect(roleLines()).toEqual([]);
  });
});

describe('ruling 10.5: a merge that unions platform roles writes the line too', () => {
  it('source ADMIN merged into target READER: before=READER after=ADMIN,READER', async () => {
    const source = (await db.user.create({ data: { roles: ['ADMIN'] } })).id;
    await mergeUsers(db, { sourceUserId: source, targetUserId: member, actorUserId: platformAdmin, mergeGlobalRoles: true });
    expect((await db.user.findUniqueOrThrow({ where: { id: member } })).roles.sort()).toEqual(['ADMIN', 'READER']);
    expect(roleLines()).toEqual([
      `user.roles.changed actor=${platformAdmin} target=${member} before=READER after=ADMIN,READER`,
    ]);
  });

  it('a merge that leaves the target\'s roles unchanged writes no line', async () => {
    const source = (await db.user.create({ data: { roles: ['READER'] } })).id;
    await mergeUsers(db, { sourceUserId: source, targetUserId: member, actorUserId: platformAdmin, mergeGlobalRoles: true });
    expect(roleLines()).toEqual([]);
  });
});

// ── G1: the inventory of role-typed writes that take caller input ──────────

/**
 * Every non-test source line that casts a caller-supplied value to the `Role`
 * enum for a member, subscription or invitation write. The five named in the
 * issue must call the refusal; `acceptInvitation` is exempt because it copies
 * an invitation's stored role (which `createUserInvitation` already refused),
 * and `inviteUser` writes `READER` without taking a role (ruling 10.6). A sixth
 * door fails this test until it calls the refusal or is listed here with a reason.
 */
describe('G1: every role-typed write that takes caller input calls the refusal', () => {
  const REFUSING = [
    'addOrgMember', 'updateOrgMember', 'createUserInvitation', 'createMemorySubscription', 'updateMemorySubscription',
  ];
  const EXEMPT: Record<string, string> = {
    acceptInvitation: 'copies the stored invitation role, which createUserInvitation refused',
  };

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'generated' ? [] : sources(p);
      return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
    });
  }

  it('lists exactly the five plus the exempt copy, and each of the five calls refuseBillingMemberRole', () => {
    const found = new Map<string, string>();
    for (const file of sources(join(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (!/\bas Role\b/.test(text)) continue;
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        // A property write: `role: x as Role` or `memberRole: (x as Role) ?? …`.
        if (!/\b(role|memberRole):\s*\(?\s*[\w.?]+\s+as Role\b/.test(line)) return;
        // The enclosing resolver: the nearest preceding `name: async (` at resolver indentation.
        for (let j = i; j >= 0; j--) {
          const m = /^ {4}(\w+): async \(/.exec(lines[j]);
          if (m) {
            const end = lines.findIndex((l, k) => k > j && /^ {4}\w+: async \(/.test(l));
            found.set(m[1], lines.slice(j, end === -1 ? undefined : end).join('\n'));
            return;
          }
        }
        found.set(`${file}:${i + 1}`, line);
      });
    }
    expect([...found.keys()].sort()).toEqual([...REFUSING, ...Object.keys(EXEMPT)].sort());
    for (const name of REFUSING) expect(found.get(name), name).toContain('refuseBillingMemberRole(');
  });
});
