import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbClient, createDbNode, createDbOrgAndGraph } from '../../test/helpers.js';
import { createUsageEvent } from './createUsageEvent.js';

let graphId: string;

beforeEach(async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db);
  graphId = graph.id;
});

describe('createUsageEvent', () => {
  it('returns an error when event.type is missing', async () => {
    const result = await createUsageEvent({});
    expect(result.error).toBe('Missing event.type');
    expect(result.event).toBeUndefined();
  });

  it('creates an event without a nodeLoc (nodeId is null)', async () => {
    const result = await createUsageEvent({ type: 'page-view' });
    expect(result.error).toBeUndefined();
    expect(result.event).toBeDefined();
    expect(result.event!.type).toBe('page-view');
    expect(result.event!.nodeId).toBeNull();
    expect(result.event!.nodeLoc).toBeNull();
  });

  it('creates an event with a valid nodeLoc — nodeId is populated', async () => {
    await createDbNode(db, { loc: 'org.graph.node', graphId });

    const result = await createUsageEvent({ type: 'node-view', nodeLoc: 'org.graph.node' });
    expect(result.error).toBeUndefined();
    expect(result.event!.nodeLoc).toBe('org.graph.node');
    expect(result.event!.nodeId).not.toBeNull();
  });

  it('creates an event with unknown nodeLoc — nodeId stays null, no crash', async () => {
    const result = await createUsageEvent({ type: 'node-view', nodeLoc: 'unknown.loc' });
    expect(result.error).toBeUndefined();
    expect(result.event!.nodeLoc).toBe('unknown.loc');
    expect(result.event!.nodeId).toBeNull();
  });

  it('stores actionArgs as JSON', async () => {
    const args = { key: 'value', count: 42 };
    const result = await createUsageEvent({ type: 'search', actionArgs: args });
    expect(result.error).toBeUndefined();
    // The stored value should round-trip back to an object
    const stored = result.event!.actionArgs;
    expect(typeof stored === 'object' && stored !== null).toBe(true);
  });

  it('stores optional clientId', async () => {
    // clientId has a FK to Client, so create one first
    const client = await createDbClient(db, 'test-client', 'READER');
    const result = await createUsageEvent({
      type: 'click',
      clientId: client.id,
    });
    expect(result.error).toBeUndefined();
    expect(result.event!.clientId).toBe(client.id);
  });
});
