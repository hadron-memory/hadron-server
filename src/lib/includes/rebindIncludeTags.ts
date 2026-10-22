import { splitNodeUrn } from '@hadron-memory/urn-lib-js';
import { IncludeSyntaxError, locateIncludeTags } from './parseIncludeTags.js';

/**
 * R180 (#2167, cor:api:160:01) — rebind the include tags an extract copies:
 * a tag whose target is a COPIED node is rewritten to that node's rebased loc
 * (a relative tag stays relative; a URN tag naming the source memory becomes
 * the new memory's canonical node URN). Only the target changes, so settings,
 * their order and the tag's spacing survive byte for byte. A tag naming
 * anything else (a node left behind, a missing loc, another memory) and a tag
 * inside code are left as written, for the write check to judge. Content whose
 * tags don't parse is returned unchanged: the check refuses it as malformed.
 */
export function rebindIncludeTags(
  content: string | null, rebasedLocByLoc: ReadonlyMap<string, string>, sourceMemoryUrn: string, newMemoryUrn: string,
): string | null {
  if (!content || !content.includes('{{>')) return content;
  let tags: ReturnType<typeof locateIncludeTags>;
  try {
    tags = locateIncludeTags(content);
  } catch (e) {
    if (e instanceof IncludeSyntaxError) return content;
    throw e;
  }
  let out = content;
  // Last first, so each splice leaves the earlier offsets valid.
  for (const tag of [...tags].reverse()) {
    let next: string | undefined;
    if (tag.kind === 'loc') {
      next = rebasedLocByLoc.get(tag.target);
    } else if (!tag.target.includes('::')) {
      // A legacy v1 spelling (`root::memory::loc`) is not a valid include target (cor:dmo:150:02, R78):
      // rewriting it would make a tag valid that its author never wrote, so it stays as written.
      const parts = splitNodeUrn(tag.target);
      const rebased = parts.memoryUrn === sourceMemoryUrn ? rebasedLocByLoc.get(parts.loc) : undefined;
      if (rebased !== undefined) next = `hrn:node:${newMemoryUrn}:${rebased}`;
    }
    if (next === undefined) continue;
    // The target is the first token after `{{>`, so its first occurrence past the opener is it.
    const at = tag.raw.indexOf(tag.target, 3);
    const raw = tag.raw.slice(0, at) + next + tag.raw.slice(at + tag.target.length);
    out = out.slice(0, tag.index) + raw + out.slice(tag.index + tag.raw.length);
  }
  return out;
}
