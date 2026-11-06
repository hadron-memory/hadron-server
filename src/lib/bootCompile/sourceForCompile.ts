import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';

/** Internal identities discovered and authorized by the compile coordinator, never public input. */
export type CompileSourceTarget =
  | { kind: 'AGENT'; agentMemoryId: string }
  | { kind: 'APP_AGENT'; agentMemoryId: string; installMemoryId: string | null }
  | { kind: 'WORKER'; workerId: string; installMemoryId: string | null };

type Address = { memoryId: string; loc: string };
const selection = {
  id: true, memoryId: true, loc: true, role: true, nodeType: true,
  content: true, revSeq: true, deletedAt: true,
} satisfies Prisma.NodeSelect;

function absent(): never {
  throw new GraphQLError('The boot prompt source is absent.', {
    extensions: { code: 'BOOT_PROMPT_NO_SOURCE' },
  });
}

/**
 * #2046 / cor:agt:040:12: select by exact address; role validates, never selects.
 * This read-only seam creates no compile entry or entitlement. The coordinator
 * must gate target/source disclosure and supply live Agent/install identities;
 * final selection/revalidation uses its #2063 prepared transaction under the
 * complete authority/graph/address locks. This does NOT qualify a revision,
 * provision grants, create an install, resolve includes or publish a pointer.
 */
export async function sourceForCompile(
  tx: Pick<Prisma.TransactionClient, 'node'>,
  target: CompileSourceTarget,
  output?: Address,
) {
  const read = async (address: Address) => {
    if (output && address.memoryId === output.memoryId && address.loc === output.loc) {
      throw new GraphQLError('Boot prompt source and output addresses conflict.', {
        extensions: { code: 'CONFLICT' },
      });
    }
    const row = await tx.node.findUnique({
      where: { loc_memoryId: { loc: address.loc, memoryId: address.memoryId } },
      select: selection,
    });
    // R83: tombstoned App sources count as absent even if their old role is invalid.
    if (!row || row.deletedAt) return null;
    const bootRole = row.role === 'boot-prompt' || row.role?.startsWith('boot-prompt.');
    if (!bootRole || row.nodeType === 'compiled-boot-prompt') {
      throw new GraphQLError('The boot prompt source is invalid.', {
        extensions: { code: 'BOOT_PROMPT_SOURCE_INVALID' },
      });
    }
    return row;
  };

  if (target.kind === 'WORKER') {
    if (!target.installMemoryId) return absent();
    return await read({ memoryId: target.installMemoryId, loc: `boot:workers:${target.workerId}:source` }) ?? absent();
  }
  if (target.kind === 'APP_AGENT' && target.installMemoryId) {
    const own = await read({ memoryId: target.installMemoryId, loc: 'boot:source' });
    if (own) return own;
  }
  // Agent source is always its OWN system memory: no base-chain or role scan.
  return await read({ memoryId: target.agentMemoryId, loc: 'boot:source' }) ?? absent();
}
