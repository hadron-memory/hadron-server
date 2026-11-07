/**
 * #3506 (split from #3263 row 5): an App key reads a finished task's findings through the
 * lazy list/relation result path. The wide loaders (`Query.agentTasks`, the relation pages)
 * omit `resultFindings`, so `AgentTask.result`'s lazy arm re-gates the read through
 * `withReadableTask` at the field instead of trusting the row that carried the reader in
 * (cor:acl:110:02); the findings ride the result (cor:agt:050:30) inside the task's App
 * scope (cor:agt:050:01). Tests only; production behavior unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../integrations/db/client.js";
import { cleanDb } from "../../../test/helpers.js";
import { generateId } from "../../../lib/id.js";
import { resolvers, type Context } from "./resolvers.js";

vi.mock("../../../integrations/github/writeNodeToGit.js", () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../integrations/github/syncGraphFromGithub.js", () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

// Field resolvers are called with GraphQL's (parent, args, ctx) shape; the loose casts keep
// this a unit test of the resolvers rather than a schema typecheck.
const mutation = resolvers.Mutation as any;
const query = resolvers.Query as any;
const agentTaskFields = (resolvers as any).AgentTask;
const resultFields = (resolvers as any).AgentTaskResult;

let member: { id: string };
let appX: { id: string; urn: string };
let appY: { id: string };
let keyX: { id: string };
let keyY: { id: string };
let revokedKey: { id: string };

const userCtx = (): Context => ({ db, userId: member.id, roles: ["READER"] });
const keyXCtx = (extra: Partial<Context> = {}): Context => ({
  db,
  appId: appX.id,
  appKeyId: keyX.id,
  roles: [],
  ...extra,
});
const keyYCtx = (): Context => ({
  db,
  appId: appY.id,
  appKeyId: keyY.id,
  roles: [],
});

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId();
  const org = await db.organization.create({
    data: { id: generateId(), name: "lazy-org", urn: `lazy-org-${suffix}.com` },
  });
  member = await db.user.create({
    data: {
      id: generateId(),
      githubId: 98_350,
      githubUsername: `lazy-${suffix}`,
      roles: ["READER"],
    },
    select: { id: true },
  });
  await db.orgMember.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      userId: member.id,
      role: "ADMIN",
    },
  });
  appX = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: "X",
      urn: `${org.urn}:x`,
    },
  });
  appY = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: "Y",
      urn: `${org.urn}:y`,
    },
  });
  await db.appMember.create({
    data: { appId: appX.id, userId: member.id, role: "member" },
  });
  await db.appMember.create({
    data: { appId: appY.id, userId: member.id, role: "member" },
  });
  keyX = await db.appKey.create({
    data: {
      id: generateId(),
      appId: appX.id,
      keyHash: `h-${generateId()}`,
      keyPreview: "xk1",
    },
    select: { id: true },
  });
  keyY = await db.appKey.create({
    data: {
      id: generateId(),
      appId: appY.id,
      keyHash: `h-${generateId()}`,
      keyPreview: "yk1",
    },
    select: { id: true },
  });
  // Revoked at creation, in plain sight: the refusal cases below read it; none of them create keys.
  revokedKey = await db.appKey.create({
    data: {
      id: generateId(),
      appId: appX.id,
      keyHash: `h-${generateId()}`,
      keyPreview: "rk",
      revokedAt: new Date(),
    },
    select: { id: true },
  });
});

/** A finished task on X carrying `findings`, created and finished by `member`. */
async function finishedWithFindings(
  findings: unknown[] = [{ severity: "P1", text: "lazy path finding" }],
) {
  const t = await mutation.createAgentTask(
    {},
    {
      input: {
        appRef: appX.id,
        title: "T",
        source: "s",
        assignee: { user: member.id },
      },
    },
    userCtx(),
  );
  await mutation.startAgentTask({}, { taskId: t.id }, userCtx());
  await mutation.finishAgentTask(
    {},
    {
      taskId: t.id,
      result: { outcome: "succeeded", summary: "S", evidence: "E", findings },
    },
    userCtx(),
  );
  return t;
}

/**
 * The task's row exactly as the wide list loader hands it to a field resolver — obtained from
 * `Query.agentTasks` with the live key, never hand-built — with the lazy shape asserted on the
 * spot: the loader omits `resultFindings`, so the lazy arm (not the eager row-copy arm) is the
 * path under test. Call it while keyX is live; a refused caller never gets this far itself.
 */
const listRow = async (id: string) => {
  const rows = await query.agentTasks({}, { appRef: appX.id }, keyXCtx());
  const row = rows.find((r: { id: string }) => r.id === id);
  expect(
    row,
    "the live key must see the task to lend its row shape",
  ).toBeTruthy();
  expect(
    Object.hasOwn(row!, "resultFindings"),
    "wide list rows omit the findings payload",
  ).toBe(false);
  return row!;
};

/** Read the findings the way GraphQL would: the gated result view, then the paginated findings field. */
const findingsVia = async (row: any, ctx: Context) =>
  resultFields.findings(await agentTaskFields.result(row, {}, ctx), {}, ctx);

// The finish path assigns finding ids F1.. in submission order; pins assert them to pin the envelope exactly.
describe("#3506 reading a finished task's findings through the lazy path", () => {
  it("pin 1 (list, App key): agentTasks rows omit resultFindings and the key reads the stored findings", async () => {
    const t = await finishedWithFindings();
    const row = await listRow(t.id);
    expect(await agentTaskFields.result(row, {}, keyXCtx())).toMatchObject({
      outcome: "succeeded",
      summary: "S",
      evidence: "E",
    });
    expect(await findingsVia(row, keyXCtx())).toEqual({
      items: [{ id: "F1", severity: "P1", text: "lazy path finding" }],
      total: 1,
      hasMore: false,
    });
  });

  it("pin 2 (relation, App key): clones items omit resultFindings and the key reads the clone's findings", async () => {
    const parent = await mutation.createAgentTask(
      {},
      { input: { appRef: appX.id, title: "P", source: "s" } },
      userCtx(),
    );
    const clone = await mutation.cloneAgentTask(
      {},
      { taskId: parent.id, input: { assignee: { user: member.id } } },
      userCtx(),
    );
    await mutation.startAgentTask({}, { taskId: clone.id }, userCtx());
    await mutation.finishAgentTask(
      {},
      {
        taskId: clone.id,
        result: {
          outcome: "succeeded",
          summary: "CS",
          evidence: "CE",
          findings: [{ severity: "note", text: "clone finding" }],
        },
      },
      userCtx(),
    );
    const page = await agentTaskFields.clones(
      await listRow(parent.id),
      {},
      keyXCtx(),
    );
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([clone.id]);
    expect(
      Object.hasOwn(page.items[0], "resultFindings"),
      "relation rows omit the findings payload too",
    ).toBe(false);
    expect(await findingsVia(page.items[0], keyXCtx())).toEqual({
      items: [{ id: "F1", severity: "note", text: "clone finding" }],
      total: 1,
      hasMore: false,
    });
  });

  it("pin 3 (list, user principal): an App member reads the stored findings through the same lazy row", async () => {
    const t = await finishedWithFindings();
    const rows = await query.agentTasks({}, { appRef: appX.id }, userCtx());
    const row = rows.find((r: { id: string }) => r.id === t.id);
    expect(row).toBeTruthy();
    expect(
      Object.hasOwn(row!, "resultFindings"),
      "the wide row shape is the same for a user caller",
    ).toBe(false);
    expect(await findingsVia(row!, userCtx())).toEqual({
      items: [{ id: "F1", severity: "P1", text: "lazy path finding" }],
      total: 1,
      hasMore: false,
    });
  });

  it("the findings field pages: more findings than one page, hasMore and offset follow the envelope", async () => {
    const t = await finishedWithFindings([
      { severity: "P1", text: "first" },
      { severity: "P2", text: "second" },
    ]);
    const result = await agentTaskFields.result(
      await listRow(t.id),
      {},
      keyXCtx(),
    );
    expect(
      await resultFields.findings(result, { limit: 1 }, keyXCtx()),
    ).toEqual({
      items: [{ id: "F1", severity: "P1", text: "first" }],
      total: 2,
      hasMore: true,
    });
    expect(
      await resultFields.findings(result, { limit: 1, offset: 1 }, keyXCtx()),
    ).toEqual({
      items: [{ id: "F2", severity: "P2", text: "second" }],
      total: 2,
      hasMore: false,
    });
  });
});

describe("#3506 no findings through the lazy path for a caller the direct read refuses", () => {
  // The contract is `result: null` — that IS the whole refusal. `AgentTaskResult.findings` takes no
  // ctx ("Result is reachable only through the existing task read gate", resolvers.agentTask.ts), so
  // it only ever runs under a non-null `result` the gate already judged for THIS caller; a refused
  // caller never reaches a findings field at all. Each case below compares the lazy field's refusal
  // with the direct `agentTask` read's, over the real loader row (`listRow`) — not a hand-built
  // shape — so the denial is tied to what list/relation rows actually are.
  const refusals: [name: string, ctx: () => Context][] = [
    ["another App's key", keyYCtx],
    ["a key revoked at creation", () => keyXCtx({ appKeyId: revokedKey.id })],
    ["a key with no row", () => keyXCtx({ appKeyId: generateId() })],
  ];

  it.each(refusals)(
    "%s reads result: null on the loader row, like the direct read",
    async (_name, refusedCtx) => {
      const t = await finishedWithFindings();
      const row = await listRow(t.id); // lent by the live key: the refusal is the caller's, not a missing row
      expect(
        await agentTaskFields.result(row, {}, refusedCtx()),
        "lazy result",
      ).toBeNull();
      expect(
        await query.agentTask({}, { id: t.id }, refusedCtx()),
        "direct read",
      ).toBeNull();
    },
  );

  it("a key revoked after the row was lent still reads result: null — the gate re-checks, it does not trust the row", async () => {
    const t = await finishedWithFindings();
    const row = await listRow(t.id);
    await db.appKey.update({
      where: { id: keyX.id },
      data: { revokedAt: new Date() },
    });
    expect(
      await agentTaskFields.result(row, {}, keyXCtx()),
      "lazy result after revocation",
    ).toBeNull();
    expect(
      await query.agentTask({}, { id: t.id }, keyXCtx()),
      "direct read after revocation",
    ).toBeNull();
  });

  it("a relation row refuses the same way: another App's key gets result: null on a clones item", async () => {
    const parent = await mutation.createAgentTask(
      {},
      { input: { appRef: appX.id, title: "P", source: "s" } },
      userCtx(),
    );
    const clone = await mutation.cloneAgentTask(
      {},
      { taskId: parent.id, input: { assignee: { user: member.id } } },
      userCtx(),
    );
    await mutation.startAgentTask({}, { taskId: clone.id }, userCtx());
    await mutation.finishAgentTask(
      {},
      {
        taskId: clone.id,
        result: {
          outcome: "succeeded",
          summary: "CS",
          evidence: "CE",
          findings: [{ severity: "note", text: "clone finding" }],
        },
      },
      userCtx(),
    );
    const page = await agentTaskFields.clones(
      await listRow(parent.id),
      {},
      keyXCtx(),
    ); // lent by X's live key
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([clone.id]);
    expect(Object.hasOwn(page.items[0], "resultFindings")).toBe(false);
    expect(
      await agentTaskFields.result(page.items[0], {}, keyYCtx()),
      "lazy result, relation row",
    ).toBeNull();
    expect(
      await query.agentTask({}, { id: clone.id }, keyYCtx()),
      "direct read",
    ).toBeNull();
  });

  it("a non-App principal who cannot read the task gets result: null on the loader row", async () => {
    const t = await finishedWithFindings();
    const outsider = await db.user.create({
      data: {
        id: generateId(),
        githubId: 98_351,
        githubUsername: `out-${generateId()}`,
        roles: ["READER"],
      },
      select: { id: true },
    });
    const ctx: Context = { db, userId: outsider.id, roles: ["READER"] };
    const row = await listRow(t.id);
    expect(
      await agentTaskFields.result(row, {}, ctx),
      "lazy result",
    ).toBeNull();
    expect(
      await query.agentTask({}, { id: t.id }, ctx),
      "direct read",
    ).toBeNull();
  });
});
