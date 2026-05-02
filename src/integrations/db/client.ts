import { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';

// Models with composite primary keys and no `id` column.
// 008-agent-installation: AppAgent is gone; AppMember, AgentImport, and
// AgentOrgGrant are new composite-PK joins that share the no-`id` shape.
const MODELS_WITHOUT_ID = new Set<string>([
  'AgentSubscription',
  'AppMember',
  'AgentImport',
  'AgentOrgGrant',
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
