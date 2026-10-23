import { workerReferenceError } from '../../lib/workerReferenceError.js';
import { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';
import { currentActor } from '../../lib/requestActor.js';
import { ATTRIBUTED_NODE_FIELDS } from '../../lib/nodeRevisionSnapshot.js';

// Models with no auto-gen `id` column. Mostly composite-PK joins;
// 025-oauth-for-mcp's OAuthClient is single-PK (clientId) but
// likewise has no separate `id` field, so it belongs here too.
// 008-agent-installation: AppMember, AgentImport, AgentOrgGrant.
// 023-app-shape: AppAgent (re-introduced N:M join — PR #130),
// MemoryShare (US3 — PR #133), MemoryMember (US4 — this PR).
// 025-oauth-for-mcp: OAuthClient (clientId is the PK).
// 667-webfetch-polling: WebFetchPollBinding (jobId is the PK).
// durable-login-state: PendingLoginState (the OAuth `state` is the PK).
const MODELS_WITHOUT_ID = new Set<string>([
  // #2046 — keyed by (compiled node, compiled revision).
  'CompiledPromptRevision',
  'AgentSubscription',
  'WorkerReferenceFence',
  'ManualAutomationPin',
  'AppMember',
  'AgentImport',
  'AgentOrgGrant',
  'AppAgent',
  // #1647 — the notice is keyed by its audit row.
  'UserDeletionNotice',
  // Spec 049 Phase 2 — the ordered scope→memory join (composite PK).
  'ScopeMemory',
  'MemoryShare',
  'MemoryMember',
  'OAuthClient',
  'WebFetchPollBinding',
  'PendingLoginState',
  // #1606 — keyed by its node (1:1 with a comment node).
  'CommentMeta',
  // #1706 — keyed by their owner (event + chain index, worker, App + family, App).
  'AgentTeamAlarmSchedule',
  'WorkerAvailability',
  'ModelFamilyAvailability',
  'AgentTaskStallSchedule',
  // #1707 — keyed by its registration and worker.
  'HostRegistrationWorker',
  // #1715 — keyed by the merged-away account.
  'UserMerge',
  // #1747 — keyed by their worker (and channel / ticker).
  'WorkerWakeSettings',
  'WorkerDeliveryChannel',
  'WorkerDeliveryTick', 'AppWakeDay', 'AppWakeReservation',
  // #2072 — keyed by (worker, wake key).
  'WorkerWakeAck',
]);

const basePrisma = new PrismaClient();

type NodeData = Record<string, unknown>;

/**
 * #1610 — stamp the Worker / Agent behind a node write (requestActor.ts), in
 * ONE place for every write path rather than at each of the ~40 node write
 * sites, so a new site cannot silently miss it. A value the caller set
 * explicitly is kept.
 *
 *   - A create records its creator. A request with no actor leaves the
 *     columns at their null default.
 *   - An update that touches an authored field (ATTRIBUTED_NODE_FIELDS)
 *     records its editor, and CLEARS a previous one when no actor is behind
 *     it, so `updatedBy*` always describes the LAST AUTHORED edit. (Not the
 *     `updatedAt` clock, which operational writes also advance.)
 *     Operational writes (embedding markers, approval/mint columns, the
 *     reconcile) touch no authored field and stamp nothing.
 */
function stampNodeCreate(data: NodeData): void {
  const actor = currentActor();
  if (!('createdByWorkerId' in data)) data.createdByWorkerId = actor.workerId;
  if (!('createdByAgentId' in data)) data.createdByAgentId = actor.agentId;
}

function stampNodeUpdate(data: NodeData): void {
  if (!Object.keys(data).some((key) => ATTRIBUTED_NODE_FIELDS.has(key))) return;
  const actor = currentActor();
  if (!('updatedByWorkerId' in data)) data.updatedByWorkerId = actor.workerId;
  if (!('updatedByAgentId' in data)) data.updatedByAgentId = actor.agentId;
  // #2176: the User behind the edit, stamped with the Worker / Agent so a clear is a clear for all three.
  if (!('updatedByUserId' in data)) data.updatedByUserId = actor.userId ?? null;
}

/**
 * #1610: Node writes nested inside another model's write (e.g.
 * `memory.create({ data: { nodes: { create: … } } })`) never reach the Node
 * hooks above, so they would carry no attribution. None exist (inventoried
 * for #1658); this keeps it that way by refusing loudly, rather than
 * attributing silently wrong. The relation fields typed `Node` in
 * schema.prisma, by model.
 */
const NODE_RELATIONS: Record<string, readonly string[]> = {
  Memory: ['nodes'],
  Edge: ['source', 'target'],
  PendingEdge: ['source'],
  NodeEmbedding: ['node'],
  NodeRevision: ['node'],
  NodeContentValidationReport: ['node'],
  Channel: ['chatRoot'],
  UsageEvent: ['node'],
  NodeRoleRule: ['authorTask', 'validationTask', 'descriptionNode'],
  MemoryConfigTemplateRule: ['authorTask', 'validationTask', 'descriptionNode'],
};
const NESTED_WRITES = ['create', 'createMany', 'connectOrCreate', 'update', 'updateMany', 'upsert'];

export function assertNoNestedNodeWrite(model: string, data: unknown): void {
  const relations = NODE_RELATIONS[model];
  if (!relations || !data || typeof data !== 'object') return;
  for (const relation of relations) {
    const nested = (data as Record<string, unknown>)[relation];
    if (nested && typeof nested === 'object' && NESTED_WRITES.some((op) => op in nested)) {
      throw new Error(
        `Nested Node write through ${model}.${relation} is not allowed: it bypasses node attribution (#1610). Write the Node directly.`,
      );
    }
  }
}

const eachData = (data: unknown, stamp: (d: NodeData) => void): void => {
  if (Array.isArray(data)) for (const row of data) stamp(row as NodeData);
  else if (data && typeof data === 'object') stamp(data as NodeData);
};

/**
 * Extended Prisma client that auto-generates UUIDv7 IDs (no dashes) for all
 * create and upsert operations where `id` is not explicitly provided.
 */
export const db = basePrisma.$extends({
  query: {
    $allModels: {
      async create({ model, args, query }) {
        // Some models (e.g. AppAgent) have composite primary keys and no `id`
        // field. Assigning `id` on those would make Prisma throw, so skip them.
        if (!MODELS_WITHOUT_ID.has(model)) {
          const data = args.data as Record<string, unknown>;
          if (!data.id) {
            data.id = generateId();
          }
        }
        // #1610: stamped alongside the id default, so a Node create has one
        // hook rather than two whose order would matter.
        if (model === 'Node') stampNodeCreate(args.data as NodeData);
        assertNoNestedNodeWrite(model, args.data);
        return query(args);
      },
      async update({ model, args, query }) {
        assertNoNestedNodeWrite(model, args.data);
        return query(args);
      },
      async upsert({ model, args, query }) {
        if (!MODELS_WITHOUT_ID.has(model)) {
          const create = args.create as Record<string, unknown>;
          if (!create.id) {
            create.id = generateId();
          }
        }
        if (model === 'Node') {
          stampNodeCreate(args.create as NodeData);
          stampNodeUpdate(args.update as NodeData);
        }
        assertNoNestedNodeWrite(model, args.create);
        assertNoNestedNodeWrite(model, args.update);
        return query(args);
      },
    },
    node: {
      async createMany({ args, query }) {
        eachData(args.data, stampNodeCreate);
        return query(args);
      },
      async createManyAndReturn({ args, query }) {
        eachData(args.data, stampNodeCreate);
        return query(args);
      },
      async update({ args, query }) {
        stampNodeUpdate(args.data as NodeData);
        return query(args);
      },
      async updateMany({ args, query }) {
        stampNodeUpdate(args.data as NodeData);
        return query(args);
      },
      async updateManyAndReturn({ args, query }) {
        stampNodeUpdate(args.data as NodeData);
        return query(args);
      },
    },
  },
}).$extends({
  query: {
    // Model and raw-query writes share the same typed trigger-error boundary.
    async $allOperations({ args, query }) {
      try { return await query(args); }
      catch (error) { throw workerReferenceError(error) ?? error; }
    },
  },
}) as unknown as PrismaClient;
