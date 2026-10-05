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
  'AgentSubscription',
  'AppMember',
  'AgentImport',
  'AgentOrgGrant',
  'AppAgent',
  // Spec 049 Phase 2 — the ordered scope→memory join (composite PK).
  'ScopeMemory',
  'MemoryShare',
  'MemoryMember',
  'OAuthClient',
  'WebFetchPollBinding',
  'PendingLoginState',
  // #1606 — keyed by its node (1:1 with a comment node).
  'CommentMeta',
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
 *     it, so `updatedBy*` always describes the same edit as `updatedAt`.
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
}) as unknown as PrismaClient;
