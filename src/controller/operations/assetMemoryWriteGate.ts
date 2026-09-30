import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { requireMemoryWriteAccess, type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { AssetUploadError, type AssetCallerContextV2 } from './beginAssetUpload.js';

/** Keep an Asset write and its authorization on the same side of a transfer. */
export async function requireCurrentAssetMemoryWrite(
  tx: Prisma.TransactionClient,
  caller: AssetCallerContextV2,
  memoryId: string,
): Promise<{ id: string; isEncrypted: boolean; organizationId: string | null }> {
  const rows = await tx.$queryRaw<Array<{
    id: string; is_encrypted: boolean; organization_id: string | null;
  }>>`
    SELECT id, is_encrypted, organization_id FROM memories
    WHERE id = ${memoryId} AND deleted_at IS NULL FOR SHARE
  `;
  const memory = rows[0];
  if (!memory) {
    throw new AssetUploadError('PERMISSION_DENIED', 'caller does not have write access to target memory');
  }
  try {
    await requireMemoryWriteAccess({
      db: tx, userId: caller.userId, appId: caller.appId,
      roles: caller.roles, organizationId: caller.organizationId,
      sessionId: caller.sessionId, impersonation: caller.impersonation,
    } as Context, memoryId);
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions?.code === 'FORBIDDEN') {
      throw new AssetUploadError('PERMISSION_DENIED', 'caller does not have write access to target memory');
    }
    throw error;
  }
  return {
    id: memory.id, isEncrypted: memory.is_encrypted,
    organizationId: memory.organization_id,
  };
}
