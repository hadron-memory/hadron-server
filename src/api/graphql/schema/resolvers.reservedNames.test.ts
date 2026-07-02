/**
 * Integration test (US2 / spec FR-013): the createNode resolver rejects
 * extraction-spec arrays whose entries write into the reserved
 * `message.data.exception(s)` namespace. Runs against the real DB.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let memory: { id: string };

function ctx(): Context {
  return { db, roles: ['ADMIN'], userId: admin.id };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'rn-org', urn: 'rn-org' },
  });
  admin = await db.user.create({
    data: { githubId: 9100, githubUsername: 'rn-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'rn-memory' },
    ctx(),
  );
});

describe('createNode — reserved extraction-spec names', () => {
  it('rejects agentExtractionSpec with field "exception"', async () => {
    await expect(
      resolvers.Mutation.createNode(
        {},
        {
          input: {
            loc: 'config',
            name: 'config',
            memoryId: memory.id,
            data: {
              agentExtractionSpec: [
                { field: 'business_type' },
                { field: 'exception' },
              ],
            },
          },
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      extensions: {
        code: 'INVALID_EXTRACTION_SPEC',
        reason: 'RESERVED_NAME',
        detail: { field: 'message.data.exception' },
      },
    });
  });

  it('rejects extractionSpec on a stage node with field "exceptions"', async () => {
    await expect(
      resolvers.Mutation.createNode(
        {},
        {
          input: {
            loc: 'conversations:main:check',
            name: 'check',
            memoryId: memory.id,
            data: {
              extractionSpec: [{ field: 'exceptions' }],
            },
          },
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      extensions: {
        code: 'INVALID_EXTRACTION_SPEC',
        reason: 'RESERVED_NAME',
      },
    });
  });

  it('accepts a clean extraction-spec save', async () => {
    const node = await resolvers.Mutation.createNode(
      {},
      {
        input: {
          loc: 'conversations:main:check',
          name: 'check',
          memoryId: memory.id,
          data: {
            extractionSpec: [{ field: 'business_type' }, { field: 'urgency' }],
          },
        },
      },
      ctx(),
    );
    expect(node).toMatchObject({
      loc: 'conversations:main:check',
      memoryId: memory.id,
    });
  });

  it('accepts lookalike fields like "exception_count"', async () => {
    const node = await resolvers.Mutation.createNode(
      {},
      {
        input: {
          loc: 'config',
          name: 'config',
          memoryId: memory.id,
          data: {
            agentExtractionSpec: [{ field: 'exception_count' }],
          },
        },
      },
      ctx(),
    );
    expect(node.loc).toBe('config');
  });
});
