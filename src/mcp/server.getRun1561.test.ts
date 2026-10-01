/**
 * #1561 — `hadron_get_run`: the MCP read of an app run, the counterpart of
 * hadron_run_task. Delegates to GraphQL `appRun(ref:)`, so its gate is that
 * resolver's (platform admin, or READER in the run's organization), and a run
 * the caller cannot read answers exactly like a missing one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

let org: { id: string; urn: string };
let reader: { id: string };
let outsider: { id: string };
let app: { id: string };

const auth = (userId: string): AuthContext => ({ userId, roles: ['READER'], clientId: `user:${userId}` });
const getRun = (userId: string, ref: string) =>
  createTestableMcpServer(auth(userId)).callToolText('hadron_get_run', { ref });

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'gr', urn: `gr-${t}` } });
  const otherOrg = await db.organization.create({ data: { id: generateId(), name: 'gr-o', urn: `gr-o-${t}` } });
  reader = await db.user.create({ data: { id: generateId(), githubId: 15610, githubUsername: `gr-r-${t}`, handle: `gr-r-${t}` } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 15611, githubUsername: `gr-x-${t}`, handle: `gr-x-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: outsider.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Flow', urn: `${org.urn}:flow` } });
});

async function run(extra: Record<string, unknown> = {}) {
  return db.appRun.create({
    data: {
      id: generateId(), organizationId: org.id, appId: app.id, triggerKind: 'MANUAL',
      entryNodeUrn: `hrn:node:${org.urn}:flows:check`, status: 'COMPLETED', ...extra,
    } as never,
  });
}

describe('#1561 — hadron_get_run', () => {
  it('returns status, current node, failure, the run envelope and the hop trail', async () => {
    const r = await run({
      status: 'FAILED',
      curNodeUrn: `hrn:node:${org.urn}:flows:notify`,
      failure: { code: 'TOOL_ERROR', message: 'smtp refused' },
      data: { price: 42, changed: true },
      hops: [
        { node: `hrn:node:${org.urn}:flows:check`, edgeOut: 'changed', tokensSpent: 120 },
        { node: `hrn:node:${org.urn}:flows:summarize`, edgeOut: 'notify', tokensSpent: 300 },
      ],
      tokensSpent: 420,
    });
    const text = await getRun(reader.id, r.id);
    expect(text).toContain(`Run ${r.id}`);
    expect(text).toContain('Status: FAILED');
    expect(text).toContain(`Current node: hrn:node:${org.urn}:flows:notify`);
    expect(text).toContain('"code": "TOOL_ERROR"');
    expect(text).toContain('"price": 42');
    expect(text).toMatch(/Hops \(2 completed\)/);
    expect(text).toContain('"edgeOut": "notify"');
  });

  it("a run you may not read answers exactly like a run that doesn't exist (no oracle)", async () => {
    const r = await run();
    const denied = await getRun(outsider.id, r.id);
    const missing = await getRun(outsider.id, generateId());
    expect(denied).toBe(`Run "${r.id}" not found.`);
    expect(missing).toMatch(/^Run ".+" not found\.$/);
  });

  it('caps a huge envelope with an honest truncation note instead of blowing the result ceiling', async () => {
    const r = await run({ data: { blob: 'x'.repeat(50_000) } });
    const text = await getRun(reader.id, r.id);
    expect(text).toMatch(/Data \(run envelope\) \(truncated to 20000 of \d+ characters; read it in full via GraphQL appRun\(ref:\)\)/);
    expect(text.length).toBeLessThan(30_000);
  });

  it('refuses a blank ref with the remedy', async () => {
    expect(await getRun(reader.id, '   ')).toMatch(/Pass the run id/);
  });
});

describe('#1565 review — run starters read their own run; foreign runs stay masked (Codex-worker P1)', () => {
  let member: { id: string };
  let otherMember: { id: string };
  beforeEach(async () => {
    const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    member = await db.user.create({ data: { id: generateId(), githubId: 15612, githubUsername: `gr-m-${t}`, handle: `gr-m-${t}` } });
    otherMember = await db.user.create({ data: { id: generateId(), githubId: 15613, githubUsername: `gr-o2-${t}`, handle: `gr-o2-${t}` } });
    // App members with NO org membership: the launch gate admits them, the org-READER gate alone did not.
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
    await db.appMember.create({ data: { appId: app.id, userId: otherMember.id, role: 'member' } });
  });

  it('an App member reads the run they started', async () => {
    const r = await run({ createdBy: member.id });
    expect(await getRun(member.id, r.id)).toContain(`Run ${r.id}`);
  });

  it("another member's run reads as not found", async () => {
    const r = await run({ createdBy: otherMember.id });
    expect(await getRun(member.id, r.id)).toBe(`Run "${r.id}" not found.`);
  });

  it('a starter whose App membership was revoked can no longer read it', async () => {
    const r = await run({ createdBy: member.id });
    await db.appMember.deleteMany({ where: { appId: app.id, userId: member.id } });
    expect(await getRun(member.id, r.id)).toBe(`Run "${r.id}" not found.`);
  });

  it("a pure App key reads its own App's run; a user's App SELECTION is not that credential", async () => {
    const r = await run({ createdBy: null });
    const appKey = createTestableMcpServer({ appId: app.id, roles: [], clientId: `app:${app.id}` } as AuthContext);
    expect(await appKey.callToolText('hadron_get_run', { ref: r.id })).toContain(`Run ${r.id}`);
    const selecting = createTestableMcpServer({ userId: outsider.id, appId: app.id, roles: ['READER'], clientId: `user:${outsider.id}` } as AuthContext);
    expect(await selecting.callToolText('hadron_get_run', { ref: r.id })).toBe(`Run "${r.id}" not found.`);
  });
});

describe('#1565 review — spend is reported against the initial budget (Codex-worker P2)', () => {
  it('uses the initial budgets as denominators, and a null spend reads as unknown', async () => {
    const spent = await run({ tokensSpent: 420, budgetTokens: 99580, budgetTokensInitial: 100000, actionsSpent: 3, budgetActions: 47, budgetActionsInitial: 50 });
    expect(await getRun(reader.id, spent.id)).toContain('Spent: 420 tokens of 100000 · 3 actions of 50');
    const legacy = await run({ tokensSpent: null, actionsSpent: null, budgetTokensInitial: 100000, budgetActionsInitial: 50 });
    expect(await getRun(reader.id, legacy.id)).toContain('Spent: unknown tokens of 100000 · unknown actions of 50');
  });
});
