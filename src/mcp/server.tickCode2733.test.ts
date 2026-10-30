import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { tickFixture2733, tickTaskLoc2733 } from '../test/tickRegister2733.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
let f: Awaited<ReturnType<typeof tickFixture2733>>;
beforeEach(async () => { f = await tickFixture2733(); });
const mcp = () => createTestableMcpServer({ userId: f.admin.id, roles: ['READER'], clientId: 'user:' + f.admin.id } as AuthContext, { sessionId: 'tick-' + generateId(), cachedAppResolution: { kind: 'multi-app' } });
const text = (r: any): string => r.content[0].text;

it('renders the create warning after the ticker and displays its stored code', async () => {
  const plain = await db.session.create({ data: { id: generateId(), userId: f.admin.id } });
  const result = text(await mcp().callTool('hadron_ticker_create', { appRef: f.app.id, name: 'Unknown', cadenceSeconds: 600, session: plain.id }));
  expect(result).toContain('code tick.unknown · no register entry you can read');
  expect(result).toMatch(/^Created\./);
  expect(result.endsWith("\n\nWarning [ticker.code.unmapped]: No register entry you can read maps this ticker's code to a task, so its wakes will say no task is mapped.")).toBe(true);
});

it('lists the entry loc without resolving it, and template codes use the current template name', async () => {
  await f.entry('tick.shared');
  await f.ticker('Shared');
  const result = text(await mcp().callTool('hadron_ticker_list', { appRef: f.app.id }));
  expect(result).toContain('code tick.shared · register task loc ' + tickTaskLoc2733);
  expect(result).not.toContain('hrn:node:');
  const M = resolvers.Mutation as any;
  await M.createAgentTickerTemplate({}, { agentRef: f.roleA.id, input: { name: 'Template Tick', cadenceSeconds: 600 } }, f.context());
  expect(text(await mcp().callTool('hadron_agent_ticker_template_list', { agentRef: f.roleA.id }))).toContain('code tick.template-tick');
});

it('prints the exact server tick line with the woken role task', async () => {
  await f.entry('tick.shared');
  await f.node(f.roleA.systemMemoryId, tickTaskLoc2733, { isRunnable: true });
  const w = await f.worker('Alpha');
  const t = await f.ticker('Shared');
  await db.tickerSubscription.create({ data: { tickerId: t.id, workerId: w.id } });
  const page = await (resolvers.Query as any).dueWakes({}, { appRef: f.app.id }, f.context());
  expect(page.wakes[0].tickText).toBe('tick Shared: run hrn:node:' + f.roleA.memory.urn + ':' + tickTaskLoc2733);
  const result = text(await mcp().callTool('hadron_due_wakes', { appRef: f.app.id }));
  expect(result).toContain(page.wakes[0].tickText);
  expect(result).toContain('proof: ');
});

it('places each code line immediately below its own ticker bullet', async () => {
  await f.entry('tick.shared');
  await f.ticker('Shared');
  await f.ticker('Second');
  const lines = text(await mcp().callTool('hadron_ticker_list', { appRef: f.app.id })).split('\n');
  for (const [name, code, entry] of [['Shared', 'tick.shared', 'register task loc ' + tickTaskLoc2733], ['Second', 'tick.second', 'no register entry you can read']]) {
    const at = lines.findIndex(line => line.startsWith('- ' + name + ' ·'));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe('  code ' + code + ' · ' + entry);
  }
});
