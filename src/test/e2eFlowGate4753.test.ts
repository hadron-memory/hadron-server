/**
 * #4753: the default E2E stack seeded the #4624 script-flow memory (`<org>:flows`) unconditionally while its README, the
 * seed comment and the verifier's catalog all say the flow fixtures exist only on a stack started with
 * E2E_RUN_WORKER=true (stack.sh maps that to DISABLE_RUN_WORKER=false inside the container; every other value leaves it
 * `true`), so `stack.sh check` failed on `alpha-owner: unexpected or missing memory records`. The seed now asks
 * `seedE2eScriptFlowIfEnabled`, which reads the same container variable the run worker does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { generateId } from '../lib/id.js';
import { e2eFlowFixturesEnabled, seedE2eScriptFlowIfEnabled } from './e2eScriptFlow.js';

const salt = generateId();
const id = (name: string) => createHash('sha256').update(`${salt}:${name}`).digest('hex').slice(0, 32);
let org: string, organizationId: string, appId: string, adminId: string, agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  org = `e2e-${generateId().toLowerCase()}`;
  organizationId = (await db.organization.create({ data: { name: org, urn: org } })).id;
  adminId = (await db.user.create({ data: { githubId: 475300, githubUsername: org, roles: ['READER'] } })).id;
  appId = (await db.app.create({ data: { organizationId, urn: `${org}:team`, name: 'team', surfaces: ['chat'], createdBy: adminId } })).id;
  agentId = id(`${org}:coordinator`);
  const systemMemoryId = (await db.memory.create({ data: { id: generateId(), organizationId, urn: `${org}:system`, name: 'system', class: 'system' } })).id;
  await db.agent.create({ data: { id: agentId, organizationId, urn: `${org}:coordinator`, name: 'coordinator', personaRole: 'coordinator', systemMemoryId, visibility: 'ORGANIZATION' } });
});

const seed = (env: Record<string, string | undefined>) =>
  seedE2eScriptFlowIfEnabled(db, { org, organizationId, appId, agentId, grantedBy: adminId, id }, env);
const flowsMemories = () => db.memory.count({ where: { organizationId, urn: `${org}:flows` } });
// #5404: the fixture's write grant is a signed `memory.write` grant held by the App.
const grants = () => db.grant.count({ where: { granteeAppId: appId, action: 'memory.write' } });

describe('#4753 the flow fixtures follow the run-worker switch, exactly', () => {
  it('the switch is on only when the container variable is exactly "false" (stack.sh: E2E_RUN_WORKER=true)', () => {
    expect(e2eFlowFixturesEnabled({ DISABLE_RUN_WORKER: 'false' })).toBe(true);
    for (const v of ['true', '', 'FALSE', 'False', '0', 'no', ' false', 'false ', undefined]) {
      expect(e2eFlowFixturesEnabled({ DISABLE_RUN_WORKER: v }), `DISABLE_RUN_WORKER=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('the default stack (DISABLE_RUN_WORKER=true) seeds no flows memory, no write grant, and answers null', async () => {
    expect(await seed({ DISABLE_RUN_WORKER: 'true' })).toBeNull();
    expect(await flowsMemories()).toBe(0);
    expect(await grants()).toBe(0);
  });

  it('an unset variable is the default too (a typo cannot switch the fixtures on)', async () => {
    expect(await seed({})).toBeNull();
    expect(await flowsMemories()).toBe(0);
  });

  it('a worker stack (DISABLE_RUN_WORKER=false) keeps its flows memory and the one write grant', async () => {
    const out = await seed({ DISABLE_RUN_WORKER: 'false' });
    expect(out).not.toBeNull();
    expect(await flowsMemories()).toBe(1);
    expect(await grants()).toBe(1);
  });
});

describe('#4753 the verifier catalog expects the flows memory exactly when the fixtures are on', () => {
  const memoriesWith = async (value: string | undefined) => {
    const saved = process.env.DISABLE_RUN_WORKER;
    if (value === undefined) delete process.env.DISABLE_RUN_WORKER; else process.env.DISABLE_RUN_WORKER = value;
    try {
      vi.resetModules();
      // A variable specifier on purpose: scripts/ is outside tsconfig's rootDir (src), so a literal import fails tsc (TS6059).
      const catalogPath = '../../scripts/e2e/catalog.ts';
      const { users } = (await import(/* @vite-ignore */ catalogPath)) as { users: Record<string, { memories: string[] }> };
      return Object.fromEntries(Object.entries(users).map(([h, u]) => [h, u.memories.filter((m) => m.endsWith(':flows'))]));
    } finally { if (saved === undefined) delete process.env.DISABLE_RUN_WORKER; else process.env.DISABLE_RUN_WORKER = saved; }
  };

  it('default stack: no user is expected to see a flows memory', async () => {
    for (const v of ['true', undefined]) for (const flows of Object.values(await memoriesWith(v))) expect(flows).toEqual([]);
  });

  it('worker stack: org members, the shared reader and multi-app see their orgs\' flows (once each, both orgs where both apply); outsiders see none', async () => {
    const got = await memoriesWith('false');
    expect(got['alpha-owner']).toEqual(['e2e-alpha:flows']);
    expect(got['alpha-admin']).toEqual(['e2e-alpha:flows']);
    expect(got['alpha-member']).toEqual(['e2e-alpha:flows']);
    expect(got['beta-owner']).toEqual(['e2e-beta:flows']);
    expect(got['beta-member']).toEqual(['e2e-beta:flows']);
    expect([...got.shared].sort()).toEqual(['e2e-alpha:flows', 'e2e-beta:flows']);
    expect([...got['multi-app']].sort()).toEqual(['e2e-alpha:flows', 'e2e-beta:flows']);
    for (const h of ['outsider', 'visitor', 'fresh-user', 'platform-admin', 'google-user', 'apple-user', 'email-code-user', 'personal-owner']) expect(got[h]).toEqual([]);
  });
});
