import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * Spec 049 Phase 5 — the register tools on the MCP surface.
 *
 * The rules are pinned in lib/register.test.ts; this covers the SURFACE: the
 * tools go through the same resolvers (the install default lists under the
 * active App; add → list → remove round-trip), a refusal comes back as a
 * `[code] message` text envelope rather than a thrown error, and a Channel
 * whose host memory the caller cannot read is named by id only — the same
 * gate `RegisterEntry.channel` applies (Codex P1 on PR #1166).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { serveEveryAgent } from '../test/servedBootPrompt.js';
import { generateId } from '../lib/id.js';
import { ensureChannelWithRoot } from '../lib/channels.js';
import { startWorkerSessionGql } from '../test/startWorkerSessionGql.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { idleWindowMsFor } from '../lib/sessionActivity.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let app: { id: string; urn: string };
let app2: { id: string; urn: string };
let agent: { id: string; urn: string };
let worker: { id: string };
let channel: { id: string };
let channel2: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'rgm', urn: `rgm-${t}.com` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 49301, githubUsername: `rgm-admin-${t}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 49302, githubUsername: `rgm-member-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` } });
  app2 = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  // The admin participates in BOTH Apps (app-class memories admit participants, not org rank); the member only in the first.
  await db.appMember.create({ data: { appId: app2.id, userId: admin.id, role: 'owner' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'ag', urn: `${org.urn}:ag`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.appAgent.create({ data: { appId: app2.id, agentId: agent.id } });
  const mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-shared`, name: 's', class: 'app', appId: app.id, sharedMemoryOfAgentId: agent.id } });
  const mem2 = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:other-shared`, name: 's2', class: 'app', appId: app2.id, sharedMemoryOfAgentId: agent.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
  channel = (await ensureChannelWithRoot(db, { memoryId: mem.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app.id })).channel;
  channel2 = (await ensureChannelWithRoot(db, { memoryId: mem2.id, loc: 'chats:team', name: 'team', createdBy: admin.id, asDefaultOfAppId: app2.id })).channel;
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

function server(userId: string, activeAppId: string = app.id) {
  const auth = { userId, roles: ['READER'], clientId: `user:${userId}`, appId: activeAppId, organizationId: org.id } as AuthContext;
  return createTestableMcpServer(auth, { sessionId: `rgm-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
}

// #3082: the register tools (list/add/remove) are disabled on MCP; their rules are pinned in src/lib/register.test.ts and the
// register resolvers' own tests, so the MCP surface tests were deleted.

describe('the register on the identity surfaces (Phase 6)', () => {
  it('hadron_whoami carries the bound worker\'s register block', async () => {
    // #3082: the bind is a GraphQL startSession (as the CLI does) and the session is presented to MCP; hadron_start_session
    // and hadron_get_worker no longer carry a worker bind / exist.
    const sessionId = await startWorkerSessionGql({ workerRef: worker.id, userId: admin.id, appId: app.id });
    const who = await createTestableMcpServer(
      { userId: admin.id, roles: ['READER'], clientId: `user:${admin.id}`, appId: app.id, organizationId: org.id, sessionId } as AuthContext,
      { sessionId: `rgm-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } },
    ).callToolText('hadron_whoami', {});
    expect(who).toContain('working as: Iris');
    expect(who).toContain('    ## Channels (register)');
  });
});

// #3082: the team-chat monitor (#1265) rode hadron_team_chat_read, now disabled; the attention engine (mention-only routing,
// deliberate acknowledgement, switchover, stale-session handling) is pinned in src/lib/teamAttention.test.ts.
