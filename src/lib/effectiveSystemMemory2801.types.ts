import { resolveInheritedEdges } from './effectiveSystemMemory.js';

/** Compile-only contracts: bodies must not appear in selector-derived metadata/identity types. */
export async function endpointTypeContracts(db: Parameters<typeof resolveInheritedEdges>[0]) {
  const args = { nodeId: 'node', via: 'memory', direction: 'out' as const, canReadMemory: async () => true };
  const metadata = await resolveInheritedEdges(db, { ...args, endpointMetadataOnly: true });
  metadata[0]!.endpoint.name satisfies string;
  // @ts-expect-error Metadata projection does not select endpoint content.
  metadata[0]!.endpoint.content;
  const identity = await resolveInheritedEdges(db, { ...args, identityOnly: true, maxResults: 1 });
  identity[0]!.endpoint.id satisfies string;
  // @ts-expect-error Identity projection does not select name.
  identity[0]!.endpoint.name;
  // @ts-expect-error Identity projection does not select content.
  identity[0]!.endpoint.content;
  // @ts-expect-error Identity-only hydration requires the bounded page path.
  await resolveInheritedEdges(db, { ...args, identityOnly: true });
  const full = await resolveInheritedEdges(db, args);
  full[0]!.endpoint.content satisfies string | null;
}
