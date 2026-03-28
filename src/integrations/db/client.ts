import { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../../lib/id.js';

const basePrisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
});

/**
 * Extended Prisma client that auto-generates UUIDv7 IDs (no dashes) for all
 * create and upsert operations where `id` is not explicitly provided.
 */
export const db = basePrisma.$extends({
  query: {
    $allModels: {
      async create({ args, query }) {
        if (!args.data.id) {
          (args.data as Record<string, unknown>).id = generateId();
        }
        return query(args);
      },
      async upsert({ args, query }) {
        if (!(args.create as Record<string, unknown>).id) {
          (args.create as Record<string, unknown>).id = generateId();
        }
        return query(args);
      },
    },
  },
}) as unknown as PrismaClient;
