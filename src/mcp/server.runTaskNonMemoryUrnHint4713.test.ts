/**
 * #4713 — a non-memory URN as hadron_run_task's `memory` hint gets the SAME
 * answer an unknown memory gets, byte-identical.
 *
 * `matchRunTaskMemoryUrn` (src/mcp/server.ts) parses the hint with the shared
 * URN parser and returns null for every non-memory type
 * (`if (parsed.type !== 'memory') return null;`), so an `hrn:agent:…` hint
 * falls through to loose ranking and answers `No memory matches.` (#5168: the hint is no longer quoted) —
 * exactly the refusal an unknown memory URN gets. Under the URN grammar
 * (hrn:node:hadronmemory.com:specs:cor:urn:010:01) `hrn:agent:<org>:<x>`
 * addresses an Agent, never a memory, so its VALUE (`<org>:<x>`) must never be
 * matched against `Memory.urn` as though it named one: the `memory` hint is a
 * memory name-or-URN (hrn:node:hadronmemory.com:specs:cor:api:020:01, the
 * hadron_run_task entry). The guard predates this test and nothing pinned it —
 * these pins are what makes deleting it red.
 *
 * The collision fixture is what makes the pin load-bearing: a READABLE memory
 * `hrn:mem:acme.com:foo` exists while the caller passes `hrn:agent:acme.com:foo`
 * (same value part). With the guard, the agent URN is refused like any unknown
 * memory; without it, the agent URN's value part direct-matches the memory's
 * urn and the tool proceeds INTO that memory instead of refusing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

const ORG_URN = 'acme.com';
/** A readable memory whose urn value collides with a non-memory URN's value. */
const MEM_URN = 'acme.com:foo';
const AGENT_HINT = `hrn:agent:${MEM_URN}`;
/** A well-formed memory URN that matches nothing: the control refusal. */
const UNKNOWN_MEM_HINT = `hrn:mem:${ORG_URN}:no-such`;
/** The exact refusal an unresolvable `memory` hint gets (server.ts). */
const REFUSAL = (_hint: string) =>
  'No memory matches. Use hadron_list_memories to see what is available.'; // #5168: the hint is not quoted back

let admin: { id: string };

function adminAuth(): AuthContext {
  return { userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` };
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'acme', urn: ORG_URN },
  });
  admin = await db.user.create({
    data: { githubId: 9721, githubUsername: 'run-task-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: MEM_URN,
      name: 'Colliding tasks',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
});

describe('#4713 — hadron_run_task refuses a non-memory URN hint like an unknown memory', () => {
  it('an hrn:agent: hint gets the unknown-memory answer, byte-identical', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const agentAnswer = await srv.callToolText('hadron_run_task', {
      task: 'standup',
      memory: AGENT_HINT,
    });
    const unknownAnswer = await srv.callToolText('hadron_run_task', {
      task: 'standup',
      memory: UNKNOWN_MEM_HINT,
    });
    // Byte-identical to the unknown-memory answer once the caller's own hint,
    // echoed verbatim in the message, is accounted for.
    expect(agentAnswer).toBe(unknownAnswer.split(UNKNOWN_MEM_HINT).join(AGENT_HINT));
    // …and that answer is exactly the unknown-memory refusal: no bespoke error
    // for non-memory URNs, and no leak of the colliding memory's name.
    expect(agentAnswer).toBe(REFUSAL(AGENT_HINT));
  });

  it('every other non-memory URN type is refused the same way', async () => {
    const srv = createTestableMcpServer(adminAuth());
    for (const type of ['node', 'app', 'user', 'org']) {
      const hint = `hrn:${type}:${MEM_URN}`;
      const answer = await srv.callToolText('hadron_run_task', {
        task: 'standup',
        memory: hint,
      });
      expect(answer, `type ${type}`).toBe(REFUSAL(hint));
    }
  });

  it('the colliding memory stays reachable by its own memory URN (control)', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const answer = await srv.callToolText('hadron_run_task', {
      task: 'standup',
      memory: `hrn:mem:${MEM_URN}`,
    });
    // The memory URN selects it (its name is echoed in the task miss) — only
    // the URN TYPE keeps the agent-URN spelling out.
    expect(answer).toContain('Colliding tasks');
    expect(answer).toContain('No runnable task matching');
  });
});
