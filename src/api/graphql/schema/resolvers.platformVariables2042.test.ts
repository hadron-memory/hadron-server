/**
 * #2042 (S4 of #1772) — platform variables, cor:dmo:150:08, Phase 1: filled at
 * each bind in today's composition path (the worker briefing and the chat path),
 * alongside the old {{name}}/{{role}} placeholders.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { composeWorkerPrompt } from './resolvers.worker.js';
import { bindAgentPrompt } from './resolvers.mutation.chat.js';
import { applyPlatformVariables } from '../../../lib/personaDescription.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

const TEMPLATE =
  '{{worker.name}}|{{worker.role}}|{{agent.name}}|{{worker.reportsTo.name}}|[{{worker.signature}}]|[{{worker.trailer}}]|{{worker.url}}|{{session.llmModel}}';

describe('applyPlatformVariables', () => {
  const values = {
    'worker.name': 'Ada', 'worker.role': 'coordinator', 'agent.name': 'Coord',
    'worker.reportsTo.name': 'Bo', 'worker.signature': 'sig', 'worker.trailer': 'trl',
    'worker.url': 'https://p/x', 'session.llmModel': 'm-1',
  };

  it('fills the whole closed set and leaves everything else as written', () => {
    expect(applyPlatformVariables(TEMPLATE, values)).toBe('Ada|coordinator|Coord|Bo|[sig]|[trl]|https://p/x|m-1');
    expect(applyPlatformVariables('{{worker.other}} {{ worker.name }} {{name}}', values)).toBe(
      '{{worker.other}} {{ worker.name }} {{name}}',
    );
  });

  it('inserts a value literally and never expands a token inside it', () => {
    expect(applyPlatformVariables('{{worker.name}}', { ...values, 'worker.name': '{{agent.name}}$&' })).toBe(
      '{{agent.name}}$&',
    );
  });
});

describe('one pass over the authored source (blind review P2-1, P3-1)', () => {
  const values = {
    'worker.name': 'Ada', 'worker.role': 'coordinator', 'agent.name': 'Actual Agent',
    'worker.reportsTo.name': '', 'worker.signature': '', 'worker.trailer': '',
    'worker.url': '', 'session.llmModel': 'm-1',
  };

  it('legacy and platform tokens bind together, so a legacy value holding a platform token stays literal', () => {
    const legacy = { name: '{{agent.name}}', role: '{{session.llmModel}}' };
    expect(applyPlatformVariables('{{name}}|{{worker.name}}|{{role}}', { ...values, 'worker.name': legacy.name }, legacy)).toBe(
      '{{agent.name}}|{{agent.name}}|{{session.llmModel}}',
    );
  });

  it('binds only the exact {{worker.name}} token', () => {
    expect(applyPlatformVariables('You are {{worker.name}}.', values)).toBe(`You are ${values['worker.name']}.`);
    expect(applyPlatformVariables('You are {{ worker.name }}.', values)).toBe('You are {{ worker.name }}.');
  });
});

describe('bindAgentPrompt — a chat binds no worker (cor:dmo:150:08)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('worker.name falls back to the Agent name, role to persona role, the rest empty, url to the Agent portal URL', () => {
    vi.stubEnv('FRONTEND_URL', 'https://portal.test');
    const out = bindAgentPrompt({
      systemPrompt: TEMPLATE, name: 'Juno', urn: 'acme.com:juno', personaRole: 'mentor',
    });
    expect(out).toBe('Juno|mentor|Juno||[]|[]|https://portal.test/app/u/acme.com:juno|');
  });
});

describe('composeWorkerPrompt — filled at each bind', () => {
  let userId: string;
  let appId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanDb(db);
    vi.stubEnv('FRONTEND_URL', 'https://portal.test');
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const org = await db.organization.create({ data: { id: generateId(), name: 'pv-org', urn: `pv-org-${suffix}.com` } });
    const user = await db.user.create({
      data: { id: generateId(), githubId: 98300, githubUsername: `pv-${suffix}`, roles: ['READER'] },
    });
    userId = user.id;
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId, role: 'ADMIN' } });
    const agent = await M.createAgent(
      {}, { orgId: org.id, name: 'PV Agent', personaRole: 'engineer', systemPrompt: TEMPLATE }, ctx(userId),
    );
    agentId = agent.id;
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'PV App', urn: `${org.urn}:team` },
    });
    appId = app.id;
    await db.appAgent.create({ data: { appId, agentId } });
  });
  afterEach(() => vi.unstubAllEnvs());

  const cast = (name: string, role?: string) =>
    M.castWorker({}, { appRef: appId, agentRef: agentId, name, ...(role ? { role } : {}) }, ctx(userId));
  const prompt = async (id: string, opts?: { llmModel?: string | null }) =>
    (await composeWorkerPrompt(ctx(userId), await db.worker.findUniqueOrThrow({ where: { id } }), opts)).text;

  it('fills worker, agent, reports-to, url and the bind session model; signature and trailer carry their stored defaults', async () => {
    const boss = await cast('Bo');
    const w = await cast('Ada', 'coordinator');
    await db.worker.update({ where: { id: w.id }, data: { reportsToWorkerId: boss.id } });
    const row = await db.worker.findUniqueOrThrow({ where: { id: w.id } });
    const url = await (resolvers as any).Worker.portalUrl(row, {}, ctx(userId));
    expect(url).toMatch(/^https:\/\/portal\.test\/app\/u\/hrn:worker:/);
    // The same link the worker read prints, not a rebuilt one.
    expect(await prompt(w.id, { llmModel: 'claude-x' })).toBe(`Ada|coordinator|PV Agent|Bo|[— [Ada, coordinator](${url}) · claude-x]|[Worker: Ada (coordinator) <${url}>]|${url}|claude-x`);
  });

  it('worker.role falls back to the Agent persona role; a worker with no report line fills reports-to empty', async () => {
    const w = await cast('Cy');
    const text = (await prompt(w.id, { llmModel: null }))!;
    expect(text.startsWith('Cy|engineer|PV Agent||[— [Cy, engineer](')).toBe(true);
    expect(text.endsWith('|')).toBe(true);
  });

  it('a legacy role value holding a platform token is served literally (composition level)', async () => {
    const w = await cast('Fay', '{{session.llmModel}}');
    await db.agent.update({ where: { id: agentId }, data: { systemPrompt: '{{role}}|{{worker.role}}' } });
    expect(await prompt(w.id, { llmModel: 'm-9' })).toBe('{{session.llmModel}}|{{session.llmModel}}');
  });

  it('platform variables in a worker override are filled, with a template and with the override alone', async () => {
    const w = await cast('Gus');
    await db.worker.update({ where: { id: w.id }, data: { promptOverride: 'I am {{worker.name}} on {{session.llmModel}}.' } });
    expect((await prompt(w.id, { llmModel: 'm-2' }))!.endsWith('\n\nI am Gus on m-2.')).toBe(true);
    await db.agent.update({ where: { id: agentId }, data: { systemPrompt: null } });
    expect(await prompt(w.id, { llmModel: 'm-2' })).toBe('I am Gus on m-2.');
  });

  it('a rename reaches the next bind with no recompile', async () => {
    const w = await cast('Dee');
    expect((await prompt(w.id, { llmModel: 'm' }))!.startsWith('Dee|')).toBe(true);
    await db.agent.update({ where: { id: agentId }, data: { name: 'PV Agent Renamed' } });
    expect(await prompt(w.id, { llmModel: 'm' })).toContain('|PV Agent Renamed|');
  });

  it('with no model passed, session.llmModel is the newest open session\'s', async () => {
    const w = await cast('Eli');
    await db.session.create({
      data: { id: generateId(), appId, workerId: w.id, userId, llmModel: 'codex-9', type: 'DEVELOPER' as any },
    });
    expect(await prompt(w.id)).toMatch(/\|codex-9$/);
  });
});
