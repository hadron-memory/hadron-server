/**
 * #5434 (gate condition 1): every door that judges the `nodes` limit takes its owner from the ONE counts-for function
 * (`countsFor.ts`), so a door left on the stored owner is red here and not silently wrong. Two routes exist and both end there:
 * the memory-id helpers in `nodes.ts` (`requireNodeHeadroom`, `sameMemoryOwner`, `memoryOwnerInTx`: every node door and the move,
 * merge and restore doors call these), and the three multi-key doors that name an owner for a memory that is NEW or being received
 * (`cloneMemory`, `extractParentNodeToMemory`, `transferMemoryOwnership`): none of them can hold a per-Agent memory's nodes, which
 * the pins in `resolvers.agentMemoryNodesCountForUser5434.test.ts` show (a clone is an ordinary memory, an extract goes to a new
 * organization memory, an Agent-scoped memory cannot be transferred).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const withoutComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === 'generated' ? [] : walk(p)) : [p];
});
const production = walk('src').filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.startsWith('src/test/'));

/** The files that ask the `nodes` key with an owner they name themselves (not through the memory-id helpers), and why each is safe. */
const NAMES_OWNER_ITSELF: Record<string, string> = {
  'src/lib/ownerLimits/nodes.ts': 'the memory-id helpers: requireNodeHeadroom reads the owner through memoryOwnerInTx, which is countsForOwnerOf',
  'src/api/graphql/schema/resolvers.mutation.memoryTransfer.ts': 'the RECEIVING owner of a transfer; an Agent-scoped memory is refused by the preview, so no per-Agent memory\'s nodes reach it',
  'src/controller/operations/cloneMemory.ts': 'the target organization of a NEW memory; a clone is created without userMemoryOfAgentId, so it counts for its stored owner',
  'src/controller/operations/extractParentNode.ts': 'the target organization of a NEW memory; whether a move adds nodes compares memoryOwnerInTx(source), the counts-for owner, with it',
};

describe('#5434 every door judges the nodes limit through the counts-for owner', () => {
  it('only the listed files ask the nodes key with an owner they name themselves', () => {
    const found = production.filter((p) => /key:\s*'nodes'/.test(withoutComments(readFileSync(p, 'utf8')))).sort();
    expect(found).toEqual(Object.keys(NAMES_OWNER_ITSELF).sort());
  });

  it('no file that uses the memory-id helpers reads a memory\'s stored owner for the limit itself', () => {
    const users = production.filter((p) => p !== 'src/lib/ownerLimits/nodes.ts' && /ownerLimits\/nodes\.js'/.test(readFileSync(p, 'utf8')));
    expect(users.length).toBeGreaterThan(5); // CONTROL: the scan finds the doors
    for (const p of users) expect(withoutComments(readFileSync(p, 'utf8')), p).not.toMatch(/\bownerRefOf\(/);
  });

  it('the helpers read the per-Agent columns and decide through countsForOwnerOf; both count paths use the SQL form of the same rule', () => {
    const nodes = withoutComments(readFileSync('src/lib/ownerLimits/nodes.ts', 'utf8'));
    expect(nodes).toMatch(/userMemoryOfAgentId: true/);
    expect(nodes).toMatch(/countsForOwnerOf\(row\)/);
    const keys = withoutComments(readFileSync('src/lib/ownerLimits/keys.ts', 'utf8'));
    expect(keys.match(/nodesCountedFor\(owner\)/g)).toHaveLength(2); // on-demand and totals
    // the other keys keep the stored owner (memories, agents, apps, assetBytes, nodeBytes)
    expect(keys.match(/\$\{ownedBy\(owner\)\}/g)!.length).toBeGreaterThanOrEqual(5);
  });
});
