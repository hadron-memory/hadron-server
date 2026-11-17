/** #4101: direct/person mutation callers take the same optional diagnostic path. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
let context: Context, agentId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'SkipMetrics4101', urn: 'skip4101.example' } });
  const user = await db.user.create({ data: { githubId: 41011, githubUsername: 'skip4101', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  context = { db, roles: ['ADMIN'], userId: user.id };
  const agent = await resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'Skip fixture', visibility: 'ORGANIZATION' }, context);
  agentId = agent.id; const memoryId = agent.systemMemoryId!;
  const ids: Record<string, string> = {};
  for (const [loc, data] of [['config', {}], ['conversations', {}], ['conversations:main', { stageOrder: ['one'] }], ['conversations:main:one', {}], ['conversations:target', { stageOrder: ['arrive'] }], ['conversations:target:arrive', {}]] as const) {
    const node = await db.node.upsert({ where: { loc_memoryId: { loc, memoryId } }, update: { data }, create: { memoryId, loc, name: loc.split(':').pop()!, nodeType: 'system', data } }); ids[loc] = node.id;
  }
  await db.edge.create({ data: { memoryId, loc: deriveEdgeLoc('conversations:main:one', 'route', 'conversations:target'), name: 'route', sourceId: ids['conversations:main:one'], targetId: ids['conversations:target'], data: { timing: 'on_complete' } } });
  await serveEveryAgent(db);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('counts absent/false/non-boolean direct calls by kind, true routes normally, and no private payload is logged', async () => {
  vi.stubEnv('HADRON_CHAT_ON_COMPLETE_SKIP_METRICS', 'true');
  let now = 1_000_000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  for (const [fields, kind] of [[{}, 'absent'], [{ goal_reached: false }, 'false'], [{ goal_reached: 'SECRET RAW FLAG' }, 'non_boolean'], [{ goal_reached: true }, null]] as const) {
    const chat = await resolvers.Mutation.startChat({}, { agentId, conversationName: 'main' }, context);
    info.mockClear(); now += 60_000;
    const result = await resolvers.Mutation.processChatResponse({}, { chatId: chat.chatId, toolResponse: { message: 'PRIVATE ASSISTANT TEXT', ...fields } }, context);
    const signals = info.mock.calls.filter(call => typeof call[0] === 'string' && call[0].includes('chat.on_complete_skipped'));
    expect(result.conversationHandoff).toBe(kind === null ? 'target' : null);
    if (kind === null) expect(signals).toHaveLength(0);
    else {
      expect(signals).toHaveLength(1);
      expect(JSON.parse(signals[0][0] as string)).toEqual({ event: 'chat.on_complete_skipped', minimumIntervalMs: 60_000,
        skippedDecisions: { absent: 0, false: 0, non_boolean: 0, [kind]: 1 }, skippedRules: { absent: 0, false: 0, non_boolean: 0, [kind]: 1 } });
      expect(signals[0][0]).not.toMatch(/SECRET|PRIVATE|skip4101|main|target/);
    }
  }
});
