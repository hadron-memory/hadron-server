/**
 * Drive surface over hadrontool-google-drive (#749).
 *
 * What this file pins:
 *   - Drive ops ride the SAME gate as mail/calendar (requireEmailConnection):
 *     interactive owner allowed, other org members / platform admins denied,
 *     App principals fail-closed without a covering ConnectionGrant.
 *   - Grant scoping: drive.read covers every read query; the one mutation
 *     (exportNodeToGoogleDoc → create-doc) has no scope — owner-only, denied
 *     for Apps even with drive.read.
 *   - Ops route through emailClient with provider 'google-drive' and the
 *     TOOL's connection id, never core's row id; criteria switch driveFiles
 *     from list-files to search-files.
 *   - The wire→schema mapping (lowercase kind/format → enums).
 *   - exportNodeToGoogleDoc reads the node under the caller's memory access
 *     (denied ≡ not-found), sends its markdown, and defaults title to the
 *     node name.
 *
 * The provider tool is mocked at the emailClient seam — these tests cover
 * core's gate + routing, not the tool (it has its own 42-test suite).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../lib/emailClient.js', () => ({
  runEmailOperation: vi.fn(async () => ({ files: [], nextPageToken: null })),
  deleteToolConnection: vi.fn(async () => {}),
  createToolConnection: vi.fn(async () => ({})),
  subscribeToolFolder: vi.fn(async () => ({})),
}));

import { runEmailOperation } from '../../../lib/emailClient.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function run(query: string, ctx: Partial<Context>) {
  const res = await server.executeOperation({ query }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

/** A tool-shaped drive file (wire form: lowercase kind vocabulary). */
function toolFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name: 'Quarterly notes',
    kind: 'document',
    mimeType: 'application/vnd.google-apps.document',
    size: null,
    webLink: 'https://docs.google.com/document/d/file-1/edit',
    parents: ['root'],
    createdAt: '2026-07-01T00:00:00.000Z',
    modifiedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

let owner: { id: string };
let orgAdmin: { id: string };
let orgId: string;
let connectionId: string;
let appId: string;
let nodeId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  owner = await db.user.create({
    data: { id: generateId(), handle: 'driveowner', githubId: 9301, githubUsername: 'driveowner', name: 'Owner' },
  });
  orgAdmin = await db.user.create({
    data: { id: generateId(), handle: 'driveadmin', githubId: 9302, githubUsername: 'driveadmin', name: 'Admin' },
  });
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Drive Org', urn: 'driveorg.test', createdBy: owner.id },
  });
  orgId = org.id;
  await db.orgMember.createMany({
    data: [
      { organizationId: orgId, userId: owner.id, role: 'CONTRIBUTOR' },
      { organizationId: orgId, userId: orgAdmin.id, role: 'ADMIN' },
    ],
  });
  const connection = await db.exchangeConnection.create({
    data: {
      organizationId: orgId,
      userId: owner.id,
      mailboxEmail: 'owner@gdrive.example',
      provider: 'google-drive',
      toolConnectionId: 'tool-drive-1',
      createdBy: owner.id,
    },
  });
  connectionId = connection.id;
  const app = await db.app.create({
    data: { id: generateId(), name: 'DriveApp', urn: 'driveorg.test:driveapp', organizationId: orgId },
  });
  appId = app.id;
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      urn: 'driveorg.test:notes',
      name: 'notes',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
  const node = await db.node.create({
    data: {
      id: generateId(),
      memoryId: memory.id,
      loc: 'quarterly',
      name: 'Quarterly report',
      content: '# Quarterly report\n\nEverything is fine.',
    },
  });
  nodeId = node.id;
});

/** Grant the fixture App the given scopes on the fixture connection. */
async function grantApp(scopes: string[]) {
  await db.connectionGrant.create({
    data: {
      id: generateId(),
      connectionId,
      granteeAppId: appId,
      grantedByUserId: owner.id,
      scopes,
    },
  });
}

const FILES_QUERY = (id: string, extra = '') =>
  `query { driveFiles(connectionRef: "${id}"${extra}) { files { id name kind } nextPageToken } }`;

const EXPORT_MUTATION = (nId: string, cId: string, extra = '') =>
  `mutation { exportNodeToGoogleDoc(nodeRef: "${nId}", connectionRef: "${cId}"${extra}) { id name kind webLink } }`;

describe('drive reads route through the tool with the google-drive provider', () => {
  it('lists files for the owner, mapping kind to the enum', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ files: [toolFile()], nextPageToken: 'cursor-2' });
    const r = await run(FILES_QUERY(connectionId), { userId: owner.id, roles: ['READER'] });
    expect(r.errors).toBeUndefined();
    expect(r.data?.driveFiles).toEqual({
      files: [{ id: 'file-1', name: 'Quarterly notes', kind: 'DOCUMENT' }],
      nextPageToken: 'cursor-2',
    });
    // Routed with the TOOL's connection id + the row's provider; bare
    // browsing is list-files with the browse default page size.
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'google-drive',
      'list-files',
      expect.objectContaining({ connectionId: 'tool-drive-1', top: 20 }),
    );
  });

  it('switches to search-files when any criterion is present, clamping top', async () => {
    await run(FILES_QUERY(connectionId, ', query: "roadmap", top: 500'), { userId: owner.id, roles: ['READER'] });
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'google-drive',
      'search-files',
      expect.objectContaining({ query: 'roadmap', top: 100 }),
    );
  });

  it('reads one file and exports content with the format enums mapped', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ file: toolFile({ id: 'abc' }) });
    const file = await run(`query { driveFile(connectionRef: "${connectionId}", fileId: "abc") { id kind } }`, {
      userId: owner.id,
      roles: ['READER'],
    });
    expect(file.errors).toBeUndefined();
    expect(file.data?.driveFile).toEqual({ id: 'abc', kind: 'DOCUMENT' });

    vi.mocked(runEmailOperation).mockResolvedValueOnce({
      export: { content: '# Hello', mimeType: 'text/markdown', format: 'markdown' },
      file: toolFile(),
    });
    const exported = await run(
      `query { driveFileExport(connectionRef: "${connectionId}", fileId: "abc", format: MARKDOWN) { content mimeType format file { kind } } }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(exported.errors).toBeUndefined();
    expect(exported.data?.driveFileExport).toEqual({
      content: '# Hello',
      mimeType: 'text/markdown',
      format: 'MARKDOWN',
      file: { kind: 'DOCUMENT' },
    });
    expect(vi.mocked(runEmailOperation)).toHaveBeenLastCalledWith(
      'google-drive',
      'export-file',
      expect.objectContaining({ fileId: 'abc', format: 'markdown' }),
    );
  });
});

describe('the shared connection gate applies to drive ops', () => {
  it('denies another org member — even an org ADMIN', async () => {
    const r = await run(FILES_QUERY(connectionId), { userId: orgAdmin.id, roles: ['READER'] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('denies an App principal without a grant (fail-closed)', async () => {
    const r = await run(FILES_QUERY(connectionId), { appId, roles: [] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('lets an App with drive.read run every read query', async () => {
    await grantApp(['drive.read']);
    const files = await run(FILES_QUERY(connectionId), { appId, roles: [] });
    expect(files.errors).toBeUndefined();

    vi.mocked(runEmailOperation).mockResolvedValueOnce({
      export: { content: 'x', mimeType: 'text/markdown', format: 'markdown' },
      file: toolFile(),
    });
    const exported = await run(
      `query { driveFileExport(connectionRef: "${connectionId}", fileId: "f") { content } }`,
      { appId, roles: [] },
    );
    expect(exported.errors).toBeUndefined();
  });

  it('a calendar scope does NOT cover drive reads (scope vocabularies stay disjoint)', async () => {
    await grantApp(['calendar.read', 'mail.read']);
    const r = await run(FILES_QUERY(connectionId), { appId, roles: [] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
  });
});

describe('exportNodeToGoogleDoc', () => {
  it('sends the node markdown to create-doc, defaulting title to the node name', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ file: toolFile({ id: 'doc-new', name: 'Quarterly report' }) });
    const r = await run(EXPORT_MUTATION(nodeId, connectionId, ', folderId: "folder-9"'), {
      userId: owner.id,
      roles: ['READER'],
    });
    expect(r.errors).toBeUndefined();
    expect(r.data?.exportNodeToGoogleDoc).toMatchObject({ id: 'doc-new', kind: 'DOCUMENT' });
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'google-drive',
      'create-doc',
      expect.objectContaining({
        connectionId: 'tool-drive-1',
        title: 'Quarterly report',
        markdown: '# Quarterly report\n\nEverything is fine.',
        folderId: 'folder-9',
      }),
    );
  });

  it('honors an explicit title override', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ file: toolFile({ id: 'doc-new' }) });
    await run(EXPORT_MUTATION(nodeId, connectionId, ', title: "For the board"'), {
      userId: owner.id,
      roles: ['READER'],
    });
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'google-drive',
      'create-doc',
      expect.objectContaining({ title: 'For the board' }),
    );
  });

  it('stays owner-only — an App is denied even with drive.read (create-doc has no scope)', async () => {
    await grantApp(['drive.read']);
    const r = await run(EXPORT_MUTATION(nodeId, connectionId), { appId, roles: [] });
    // Two independent gates both deny an App here: node read access (this
    // fixture's App can't read the memory → not-found) and, even with node
    // access, the connection gate (create-doc has no OPERATION_SCOPES entry
    // → owner-only). Either way: an error, and the tool is never called.
    expect(r.errors?.[0]).toBeDefined();
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('refuses a locked encrypted node with SESSION_EXPIRED — never ships ciphertext to Google', async () => {
    const encryptedMemory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: 'driveorg.test:vault',
        name: 'vault',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
        isEncrypted: true,
      },
    });
    const lockedNode = await db.node.create({
      data: {
        id: generateId(),
        memoryId: encryptedMemory.id,
        loc: 'secret',
        name: 'Secret note',
        content: 'enc:v1:AAAA-not-real-ciphertext',
      },
    });
    const r = await run(EXPORT_MUTATION(lockedNode.id, connectionId), { userId: owner.id, roles: ['READER'] });
    expect(r.errors?.[0]?.extensions?.code).toBe('SESSION_EXPIRED');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('answers not-found for a node outside the caller\'s memory access (denied ≡ not-found)', async () => {
    const outsider = await db.user.create({
      data: { id: generateId(), handle: 'outsider', githubId: 9303, githubUsername: 'outsider', name: 'Out' },
    });
    const r = await run(EXPORT_MUTATION(nodeId, connectionId), { userId: outsider.id, roles: ['READER'] });
    expect(r.errors?.[0]?.extensions?.code).toBe('NODE_NOT_FOUND');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });
});
