/**
 * Read-only diagnostic for the startup-sync P2002 on Node.id: for every
 * synced memory, load the git-mirror files exactly like syncGraphFromGithub
 * does and report each node whose frontmatter id already exists in the DB
 * under a DIFFERENT (loc, memory) — the create-collision the loc-keyed
 * upsert crashes on — plus duplicate ids within one repo.
 *
 *   pnpm tsx scripts/diagnose-sync-collision.ts
 */
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { GRAPHS_PATH } from '../src/config.js';
import { loadGraphFromFs } from '../src/integrations/localFs/loadGraphFromFs.js';

const db = new PrismaClient();

async function main(): Promise<void> {
  const memories = await db.memory.findMany({
    where: { deletedAt: null, source: { not: null } },
    include: { organization: true },
  });
  let collisions = 0;
  for (const memory of memories) {
    const slug = memory.urn.includes(':') ? memory.urn.split(':').slice(1).join(':') : memory.urn;
    const localPath = join(GRAPHS_PATH, memory.organization.urn, slug);
    let fsGraph;
    try {
      ({ graph: fsGraph } = await loadGraphFromFs(localPath, memory.urn, 'diagnose/diagnose'));
    } catch (err) {
      console.log(`- ${memory.urn}: cannot load ${localPath} (${err instanceof Error ? err.message : err}) — skipping`);
      continue;
    }
    const seen = new Map<string, string>();
    for (const node of fsGraph.nodes) {
      if (!node.id) continue;
      const dupLoc = seen.get(node.id);
      if (dupLoc) {
        collisions++;
        console.log(`DUPLICATE ID in repo ${memory.urn}: id ${node.id} at locs "${dupLoc}" AND "${node.loc}"`);
      }
      seen.set(node.id, node.loc ?? '?');
      const row = await db.node.findUnique({
        where: { id: node.id },
        select: { loc: true, memoryId: true, deletedAt: true, memory: { select: { urn: true } } },
      });
      if (row && (row.loc !== node.loc || row.memoryId !== memory.id)) {
        collisions++;
        console.log(
          `COLLISION in ${memory.urn}: file loc "${node.loc}" id ${node.id} — DB has that id at loc "${row.loc}" in memory ${row.memory.urn}${row.deletedAt ? ' (soft-deleted)' : ''}`,
        );
      }
    }
  }
  console.log(collisions === 0 ? 'no collisions found' : `${collisions} collision(s)`);
  await db.$disconnect();
}

void main();
