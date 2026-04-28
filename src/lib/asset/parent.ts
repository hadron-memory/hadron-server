// Lazy provisioning of the `assets/` parent node in a memory.
// Spec: hadron-portal/specs/001-asset-upload/research.md §R-008.

import type { PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { serializeTags } from '../../integrations/db/provider.js';

export const ASSETS_PARENT_LOC = 'assets';
export const ASSETS_PARENT_NAME = 'Assets';

export async function ensureAssetsParent(
  db: PrismaClient,
  memoryId: string,
): Promise<{ id: string; loc: string }> {
  const existing = await db.node.findUnique({
    where: { loc_memoryId: { loc: ASSETS_PARENT_LOC, memoryId } },
    select: { id: true, loc: true },
  });
  if (existing) return existing;

  return db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc: ASSETS_PARENT_LOC,
      name: ASSETS_PARENT_NAME,
      nodeType: 'info',
      description: "User's uploaded assets (documents, images).",
      tags: serializeTags([]) as string[],
    },
    select: { id: true, loc: true },
  });
}
