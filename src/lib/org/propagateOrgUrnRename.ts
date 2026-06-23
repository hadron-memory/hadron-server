import type { Prisma } from '../../generated/prisma/index.js';

/**
 * Rewrite the denormalized org-slug prefix on every Memory, Agent and App URN
 * owned by an organization after its own URN is renamed (issue #337).
 *
 * An org's URN is baked into each child's `urn` column at creation as
 * `<orgUrn>::<rest>`; the org's own `urn` column is the only thing
 * `updateOrganization` rewrites, so without this the children keep the old
 * slug forever. Only these three tables store a URN string:
 *
 *   - `Node` / `Edge` URNs are COMPUTED on read from the parent memory's URN
 *     (never stored), so they self-heal once the memory URN is fixed.
 *   - An installed agent's URN is likewise COMPOSED on read
 *     (`composeInstalledAgentUrn`), not stored, so it self-heals once the app
 *     and agent URNs are fixed.
 *
 * Only the leading `<oldUrn>::` segment changes; the rest of each child URN is
 * preserved verbatim. Must run inside the caller's transaction so the org
 * rename and the child rewrite commit (or roll back) together. A rewritten URN
 * that would collide with an existing `@unique` row makes the transaction throw
 * and the whole rename roll back — the safe outcome.
 */
export async function propagateOrgUrnRename(
  tx: Prisma.TransactionClient,
  organizationId: string,
  oldOrgUrn: string,
  newOrgUrn: string,
): Promise<void> {
  if (oldOrgUrn === newOrgUrn) return;
  const oldPrefix = `${oldOrgUrn}::`;
  const rewrite = (urn: string): string =>
    urn.startsWith(oldPrefix) ? `${newOrgUrn}::${urn.slice(oldPrefix.length)}` : urn;

  const memories = await tx.memory.findMany({
    where: { organizationId },
    select: { id: true, urn: true },
  });
  for (const m of memories) {
    const next = rewrite(m.urn);
    if (next !== m.urn) await tx.memory.update({ where: { id: m.id }, data: { urn: next } });
  }

  const agents = await tx.agent.findMany({
    where: { organizationId },
    select: { id: true, urn: true },
  });
  for (const a of agents) {
    const next = rewrite(a.urn);
    if (next !== a.urn) await tx.agent.update({ where: { id: a.id }, data: { urn: next } });
  }

  const apps = await tx.app.findMany({
    where: { organizationId },
    select: { id: true, urn: true },
  });
  for (const ap of apps) {
    const next = rewrite(ap.urn);
    if (next !== ap.urn) await tx.app.update({ where: { id: ap.id }, data: { urn: next } });
  }
}
