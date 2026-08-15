/**
 * #1003 — an App's own members must be able to READ the App's team space: the
 * `class='app'` memory hosting `chats:team` and the `worklog` ledger.
 *
 * Before the fix, `getAppMemoryAccess` reached memories only by walking the
 * App's installed **Agents**, so it never saw a row linked by `Memory.appId`.
 * `canReadMemory` falls through to that map for every non-personal class, so a
 * plain App member's `hadron_get_node` on `chats:team` answered the
 * no-existence-oracle `Memory not found` — indistinguishable from a mistyped
 * URN, which is why it read as caller error for so long. A global ADMIN passed
 * only via the bypass sitting ABOVE the map check, so an admin-run probe could
 * not see the gap at all (the mis-framing in #990 item 3).
 *
 * The fixture mirrors the production shape (micromentor.org:mm-eng-team-shared):
 * an App with its Team Agent installed and an app-class memory owned by the App
 * AND keyed to that agent. FOUR shapes of app-class row can carry one App's
 * appId, and the tests below pin every one:
 *
 *   | Kind                  | sharedMemoryOfAgentId | userMemoryOfAgentId | workerOf | readable |
 *   |-----------------------|-----------------------|---------------------|----------|----------|
 *   | Team space (adopted)  | set                   | null                | none     | YES      |
 *   | Team space (legacy)   | null                  | null                | none     | YES      |
 *   | Worker working memory | null                  | null                | one      | NO       |
 *   | Session memory        | null                  | SET                 | none     | NO       |
 *
 * The legacy row is why the predicate does not key on
 * `sharedMemoryOfAgentId: { not: null }` — that would leave pre-#723 unadopted
 * Apps with the exact symptom this fixes. The worker and session rows are why it
 * is not simply `appId + class='app'`: a Worker's casting-scoped working memory
 * (#974) is an open policy question deliberately not settled by a read-gate fix,
 * and a session memory is reachable only through its binding — admitting it
 * would hand every App member every anonymous end-user session (#934/#967).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import {
  cleanDb,
  createDbAppWithKey,
  createDbAppAgent,
  createDbAppMember,
} from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import { canReadMemory, canWriteToMemory, getMemoryAccess } from './access-control.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'acr-org', urn: 'acr-org' },
  });
  orgId = org.id;
});

/**
 * App + installed Team Agent + a plain member holding App role `owner`, plus the
 * App's ADOPTED team space (`sharedMemoryOfAgentId` set) hosting `chats:team`.
 */
async function fixture() {
  const member = await db.user.create({ data: { id: generateId(), name: 'plain-member' } });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      name: 'Team Agent',
      urn: `${orgId}:team-agent`,
      organizationId: orgId,
    },
  });
  const { app } = await createDbAppWithKey(db, 'eng-team', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  await createDbAppMember(db, app.id, member.id, 'owner');

  const shared = await db.memory.create({
    data: {
      class: 'app',
      id: generateId(),
      name: 'eng-team-shared',
      urn: `${orgId}:eng-team-shared`,
      organizationId: orgId,
      appId: app.id,
      sharedMemoryOfAgentId: agent.id,
    },
  });
  await db.node.create({
    data: {
      id: generateId(),
      memoryId: shared.id,
      loc: 'chats:team',
      name: 'Team chat',
      nodeType: 'chat',
    },
  });
  return { member, agent, app, shared };
}

/** The auth context of a plain App member — no ADMIN, no OWNER. */
function memberAuth(memberId: string, appId: string): AuthContext {
  return {
    userId: memberId,
    appId,
    organizationId: orgId,
    roles: [],
    clientId: `user:${memberId}`,
  } as AuthContext;
}

describe('#1003 — App members can read the App team space', () => {
  it('the adopted team space is in the access map, readable, listed, and its nodes resolve', async () => {
    const { member, app, shared } = await fixture();
    const auth = memberAuth(member.id, app.id);

    expect((await getMemoryAccess(db, auth)).has(shared.id)).toBe(true);
    expect(await canReadMemory(db, auth, shared.id)).toBe(true);

    const listed = await createTestableMcpServer(auth).callToolText('hadron_list_memories', {});
    expect(listed).toContain('eng-team-shared');

    const read = await createTestableMcpServer(auth).callToolText('hadron_get_node', {
      urn: `hrn:node:${orgId}:eng-team-shared:chats:team`,
    });
    expect(read).not.toContain('Memory not found');
    expect(read).toContain('Team chat');
  });

  it('grants READ only — the team space does not become writable through the map', async () => {
    // The writes this memory receives (team chat, worklog) run their own
    // participant gates; the read-gate fix must not open the generic
    // node-mutation tools on it as a side effect.
    const { member, app, shared } = await fixture();
    const auth = memberAuth(member.id, app.id);

    expect((await getMemoryAccess(db, auth)).get(shared.id)).toBe('READ_ONLY');
    expect(await canWriteToMemory(db, auth, shared.id)).toBe(false);
  });

  it('a LEGACY team space (no sharedMemoryOfAgentId) is readable too', async () => {
    // What `workerOf: { none: {} }` buys over `sharedMemoryOfAgentId: { not: null }`:
    // pre-#723 rows that the adoption sweep (sharedMemoryAdoption.ts) has not
    // keyed yet must not stay unreadable.
    const { member, app } = await fixture();
    const legacy = await db.memory.create({
      data: {
        class: 'app',
        id: generateId(),
        name: 'eng-team-legacy',
        urn: `${orgId}:eng-team-legacy`,
        organizationId: orgId,
        appId: app.id,
        sharedMemoryOfAgentId: null,
      },
    });

    const auth = memberAuth(member.id, app.id);
    expect((await getMemoryAccess(db, auth)).get(legacy.id)).toBe('READ_ONLY');
    expect(await canReadMemory(db, auth, legacy.id)).toBe(true);
  });

  it('a Worker working memory stays OUT of the map — exposure is not widened', async () => {
    // #974 casting-scoped memory: also an app-class row carrying this App's
    // appId. Whether every App member may read it is an open policy question,
    // still answered by maySeeWorkerInternals — not by this gate.
    const { member, agent, app } = await fixture();
    const working = await db.memory.create({
      data: {
        class: 'app',
        id: generateId(),
        name: 'iris',
        urn: `${orgId}:eng-team-iris`,
        organizationId: orgId,
        appId: app.id,
      },
    });
    await db.worker.create({
      data: {
        id: generateId(),
        appId: app.id,
        agentId: agent.id,
        name: 'Iris',
        slug: 'iris',
        memoryId: working.id,
      },
    });

    const auth = memberAuth(member.id, app.id);
    expect((await getMemoryAccess(db, auth)).has(working.id)).toBe(false);
    expect(await canReadMemory(db, auth, working.id)).toBe(false);
  });

  it('a SESSION memory stays OUT of the map — session isolation is not breached', async () => {
    // The anonymous scratch memory startAgentSession provisions reuses
    // class='app' for the App's bucket of records-through-an-agent. It is
    // reachable only through a session binding (sessionScopedMemoryIds, whose
    // contract says this map "excludes per-user memories entirely"), so
    // admitting it would hand every App member every anonymous end-user
    // session — the #934/#967 narrow-never-grant rule.
    const { member, agent, app } = await fixture();
    const scratch = await db.memory.create({
      data: {
        class: 'app',
        id: generateId(),
        name: 'Anonymous session',
        urn: `${orgId}:eng-team-anon`,
        organizationId: orgId,
        appId: app.id,
        userMemoryOfAgentId: agent.id,
      },
    });

    const auth = memberAuth(member.id, app.id);
    expect((await getMemoryAccess(db, auth)).has(scratch.id)).toBe(false);
    expect(await canReadMemory(db, auth, scratch.id)).toBe(false);
  });

  it('a soft-deleted team space is not readable', async () => {
    const { member, app, shared } = await fixture();
    await db.memory.update({ where: { id: shared.id }, data: { deletedAt: new Date() } });

    const auth = memberAuth(member.id, app.id);
    expect((await getMemoryAccess(db, auth)).has(shared.id)).toBe(false);
    expect(await canReadMemory(db, auth, shared.id)).toBe(false);
  });

  it('another App\'s member cannot read this App\'s team space', async () => {
    // The tenant boundary the fix must not cross: admission is keyed on
    // Memory.appId, so it reaches only Apps the caller actually belongs to.
    const { shared } = await fixture();
    const outsider = await db.user.create({ data: { id: generateId(), name: 'outsider' } });
    const { app: otherApp } = await createDbAppWithKey(db, 'other-team', orgId);
    await createDbAppMember(db, otherApp.id, outsider.id, 'owner');

    const auth = memberAuth(outsider.id, otherApp.id);
    expect((await getMemoryAccess(db, auth)).has(shared.id)).toBe(false);
    expect(await canReadMemory(db, auth, shared.id)).toBe(false);
  });
});
