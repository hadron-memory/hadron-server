// How a chat message's author reads in MCP text (#1791, Riana P3). A Worker's name is free-form, so a Worker may be
// NAMED the platform's display name; the text byline therefore marks the platform with brackets a name cannot carry
// (they are folded to plain parentheses in everyone else's), keyed on the structured `authorSystem`, not on the name.
const PLATFORM_BRACKETS = /[⟦⟧]/g;

export function chatByline(m: { authorName?: string | null; authorSystem?: boolean }): string {
  const name = m.authorName ?? 'unknown';
  if (m.authorSystem) return `⟦${name.replace(PLATFORM_BRACKETS, '')}⟧`;
  return `[${name.replace(PLATFORM_BRACKETS, (c) => (c === '⟦' ? '(' : ')'))}]`;
}
