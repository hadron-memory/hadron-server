import type { GraphQLResolveInfo, SelectionSetNode } from 'graphql';

/**
 * #2980 — does this resolver's selection ask for the direct child field `name` of the value it returns?
 *
 * It errs toward YES: no `info` (an internal caller such as an MCP tool or a run tool) and a fragment spread it
 * cannot resolve count as selected, and directives are not evaluated, so `total @skip(if: true)` counts too. A
 * caller uses a NO only to skip work for a field nobody will see, so a false YES costs time and a false NO would
 * cost correctness. Aliases do not matter: the field's own name is what is matched.
 */
export function selectsField(info: GraphQLResolveInfo | undefined | null, name: string): boolean {
  if (!info?.fieldNodes?.length) return true;
  const seen = new Set<string>();
  const walk = (set: SelectionSetNode | undefined): boolean => {
    if (!set) return false;
    for (const sel of set.selections) {
      if (sel.kind === 'Field') {
        if (sel.name.value === name) return true;
      } else if (sel.kind === 'InlineFragment') {
        if (walk(sel.selectionSet)) return true;
      } else if (sel.kind === 'FragmentSpread') {
        const frag = info.fragments?.[sel.name.value];
        if (!frag) return true;
        if (seen.has(sel.name.value)) continue;
        seen.add(sel.name.value);
        if (walk(frag.selectionSet)) return true;
      }
    }
    return false;
  };
  return info.fieldNodes.some((f) => (f.selectionSet ? walk(f.selectionSet) : true));
}
