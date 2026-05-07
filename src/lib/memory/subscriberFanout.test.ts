import { describe, expect, it, vi } from 'vitest';
import {
  fanoutOwnerDeleted,
  fanoutOwnerRestored,
  type FanoutContext,
} from './subscriberFanout.js';

type CreateManyArgs = {
  data: Array<{
    memoryId: string;
    level: string;
    eventType: string;
    message: string;
    detail: Record<string, unknown>;
  }>;
};

function makeDb(subscriberOrgIds: string[]) {
  const findMany = vi.fn(
    async (_args: { where: { memoryId: string }; select: { organizationId: true } }) =>
      subscriberOrgIds.map((id) => ({ organizationId: id })),
  );
  const createMany = vi.fn(async (_args: CreateManyArgs) => ({
    count: subscriberOrgIds.length,
  }));
  return {
    memorySubscription: { findMany },
    memoryLogEntry: { createMany },
    findMany,
    createMany,
  };
}

const baseCtx: FanoutContext = {
  memoryId: 'mem_x',
  memoryName: 'notes',
  memoryUrn: 'acme.test:notes',
  owningOrgId: 'org_acme',
  owningOrgName: 'acme.test',
  actor: 'usr_alice',
};

describe('fanoutOwnerDeleted', () => {
  it('writes zero rows and returns 0 when no subscribers exist', async () => {
    const db = makeDb([]);
    const count = await fanoutOwnerDeleted(db as never, baseCtx);
    expect(count).toBe(0);
    expect(db.createMany).not.toHaveBeenCalled();
  });

  it('writes exactly one row per subscriber org', async () => {
    const db = makeDb(['org_sub1', 'org_sub2', 'org_sub3']);
    const count = await fanoutOwnerDeleted(db as never, baseCtx);
    expect(count).toBe(3);
    expect(db.createMany).toHaveBeenCalledTimes(1);
    const args = db.createMany.mock.calls.at(0)?.[0];
    expect(args?.data).toHaveLength(3);
    const orgs = args?.data.map((r) => r.detail.subscribingOrgId);
    expect(orgs).toEqual(['org_sub1', 'org_sub2', 'org_sub3']);
  });

  it('tags rows with action=subscriber_notified_owner_deleted and the owner-side fields', async () => {
    const db = makeDb(['org_sub1']);
    await fanoutOwnerDeleted(db as never, baseCtx);
    const row = db.createMany.mock.calls.at(0)?.[0]?.data[0];
    expect(row?.eventType).toBe('LIFECYCLE');
    expect(row?.detail.action).toBe('subscriber_notified_owner_deleted');
    expect(row?.detail.actor).toBe('system:lifecycle-fanout');
    expect(row?.detail.owningOrgId).toBe('org_acme');
    expect(row?.detail.owningOrgName).toBe('acme.test');
    expect(row?.detail.memoryUrn).toBe('acme.test:notes');
    expect(row?.detail.deletedByActor).toBe('usr_alice');
  });
});

describe('fanoutOwnerRestored', () => {
  it('uses the restored action and a restore-phrased message', async () => {
    const db = makeDb(['org_sub1']);
    const count = await fanoutOwnerRestored(db as never, baseCtx);
    expect(count).toBe(1);
    const row = db.createMany.mock.calls.at(0)?.[0]?.data[0];
    expect(row?.detail.action).toBe('subscriber_notified_owner_restored');
    expect(row?.message?.toLowerCase()).toContain('restored');
  });
});

describe('fan-out bookkeeping', () => {
  it('keys every row on the deleted memory id (subscribers find via subscription join)', async () => {
    const db = makeDb(['org_sub1', 'org_sub2']);
    await fanoutOwnerDeleted(db as never, baseCtx);
    const args = db.createMany.mock.calls.at(0)?.[0];
    for (const row of args?.data ?? []) {
      expect(row.memoryId).toBe('mem_x');
    }
  });
});
