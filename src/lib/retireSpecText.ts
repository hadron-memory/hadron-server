/**
 * #3429 — the text a retirement writes (cor:spc:010:02, cor:spc:010:01). The server composes it, so the banner and the
 * abstract are identical on every surface and a client cannot supply them (cor:api:240:01). Pure: the date, the
 * stored fields and the successor come in as arguments.
 */

export type RetireForm = 'RESCIND' | 'SUPERSEDE';

/** Trim and collapse every run of whitespace (newlines included) to one space, so the abstract stays one paragraph. */
export function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Caller text goes into the banner as TEXT, never as Markdown or HTML: a reason such as `<!--` could swallow the fixed
 * warning in a renderer that allows raw HTML, and `*` or `[x](url)` could restyle or link it. Angle brackets and the
 * ampersand become entities, and the Markdown inline specials are backslash-escaped. Text with none of them is unchanged.
 */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[&<>\\`*_\[\]~|]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : `\\${c}`));
}

const TAIL = '**Do not apply.** Retained as a tombstone; the citation is never renumbered.';

/** The banner placed under the title, as one line of blockquote. */
export function retirementBanner(a: {
  form: RetireForm; withdrawn: boolean; date: string; reason: string | null; successor: { loc: string; name: string } | null;
}): string {
  const reason = a.reason ? escapeMarkdownText(oneLine(a.reason)) : '';
  if (a.form === 'SUPERSEDE') {
    const by = a.successor ? ` by ${a.successor.loc} (${escapeMarkdownText(oneLine(a.successor.name))})` : '';
    return `> **⚠️ Superseded** (${a.date}${reason ? `, ${reason}` : ''})${by}. ${TAIL}`;
  }
  return a.withdrawn
    ? `> **⚠️ Withdrawn, never in force** (${a.date}, ${reason}). ${TAIL}`
    : `> **⚠️ Rescinded** (${a.date}, ${reason}), no successor. ${TAIL}`;
}

/** The retirement abstract. A supersede's `summary` defaults to the stored abstract, verbatim (collapsed to one line). */
export function retirementAbstract(a: {
  form: RetireForm; withdrawn: boolean; date: string; reason: string | null; summary: string | null;
  storedAbstract: string | null; successor: { loc: string; name: string } | null;
}): string {
  const summary = oneLine(a.summary ?? a.storedAbstract ?? '');
  if (a.form === 'SUPERSEDE') {
    const s = a.successor!;
    return `SUPERSEDED (${a.date}) by ${s.loc} (${oneLine(s.name)}); do not apply. Historical: ${summary}`;
  }
  return `${a.withdrawn ? 'WITHDRAWN' : 'RESCINDED'} (${a.date}); do not apply. ${oneLine(a.reason ?? '')} Historical: ${summary}`;
}

/** Place the banner after the body's first line when it is a `# ` title (blank lines around it), else at the top. */
export function withBanner(content: string | null, banner: string): string {
  const body = content ?? '';
  if (body.startsWith('# ')) {
    const eol = body.indexOf('\n');
    const first = eol < 0 ? body : body.slice(0, eol);
    const rest = eol < 0 ? '' : body.slice(eol + 1).replace(/^\n+/, '');
    return rest ? `${first}\n\n${banner}\n\n${rest}` : `${first}\n\n${banner}`;
  }
  return body ? `${banner}\n\n${body}` : banner;
}

/** The spec's own tags with `superseded` appended when absent, order kept. */
export function withSupersededTag(tags: readonly string[]): string[] {
  return tags.includes('superseded') ? [...tags] : [...tags, 'superseded'];
}
