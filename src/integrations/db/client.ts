import { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';

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
]);

const basePrisma = new PrismaClient();

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
        return query(args);
      },
      async upsert({ model, args, query }) {
        if (!MODELS_WITHOUT_ID.has(model)) {
          const create = args.create as Record<string, unknown>;
          if (!create.id) {
            create.id = generateId();
          }
        }
        return query(args);
      },
    },
  },
}) as unknown as PrismaClient;
