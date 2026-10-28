/**
 * #1789 acceptance 2 (Vera): every MCP refusal or fault is `isError: true`, never a success-shaped text result.
 * Controls: the refusal keeps its text; a fault is the generic envelope; a success is not flagged.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import { generateId } from '../lib/id.js';

let userId: string;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), urn: 'refusal1789.example', name: 'Refusal' } });
  const user = await db.user.create({ data: { githubId: 178901, githubUsername: 'refusal1789', roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  await db.memory.create({ data: { id: generateId(), urn: 'refusal1789.example:mem', name: 'mem', class: 'knowledge', organizationId: org.id } });
});
afterEach(() => vi.restoreAllMocks());

const server = () => createTestableMcpServer({ userId, roles: ['READER'] });
/** callTool's declared type omits isError; the field is on the wire. */
const call = async (tool: string, args: Record<string, unknown>) => (await server().callTool(tool, args)) as { isError?: boolean; content: { text: string }[] };

describe('MCP refusals are failed calls (#1789)', () => {
  it('a memory that does not exist: the refusal text is kept and isError is set', async () => {
    const result = await call('hadron_create_node', { urn: 'hrn:node:refusal1789.example:nosuchmemory:x', name: 'X', content: 'c' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it('a node that does not exist', async () => {
    const result = await call('hadron_get_node', { urn: 'hrn:node:refusal1789.example:mem:absent' });
    expect(result.isError).toBe(true);
  });

  it('an unauthenticated or impersonated caller is refused with isError', async () => {
    const impersonated = (await createTestableMcpServer({ userId, roles: ['READER'], impersonation: { orgId: 'org-1789' } } as never)
      .callTool('hadron_set_active_scope', { clear: true })) as { isError?: boolean; content: { text: string }[] };
    expect(impersonated.isError).toBe(true);
    expect(impersonated.content[0].text).toMatch(/impersonation/i);
    const anonymous = (await createTestableMcpServer({ appId: 'app-1789', roles: [] } as never)
      .callTool('hadron_set_active_scope', { clear: true })) as { isError?: boolean; content: { text: string }[] };
    expect(anonymous.isError).toBe(true);
    expect(anonymous.content[0].text).toMatch(/Not authenticated/);
  });

  it('an invalid move_node destination keeps its loc message (a refusal, not a fault)', async () => {
    await call('hadron_create_node', { urn: 'hrn:node:refusal1789.example:mem:src', name: 'Src', content: 'c' });
    const result = await call('hadron_move_node', { urn: 'hrn:node:refusal1789.example:mem:src', targetUrn: 'hrn:node:refusal1789.example:mem:bad loc!' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid loc/);
    expect(result.content[0].text).not.toMatch(/Request id/i);
  });

  it('control: a success is not flagged', async () => {
    const created = await call('hadron_create_node', { urn: 'hrn:node:refusal1789.example:mem:fine', name: 'Fine', content: 'c' });
    expect(created.isError).toBeUndefined();
    const read = await call('hadron_get_node', { urn: 'hrn:node:refusal1789.example:mem:fine' });
    expect(read.isError).toBeUndefined();
  });
});
