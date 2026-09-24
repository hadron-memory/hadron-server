/**
 * Go's `strconv.Quote` (what `fmt`'s `%q` does to a string), ported so a lint
 * message that quotes a value reads byte-for-byte as the Go reference's.
 *
 * Needed because a quoted value here is AUTHOR-CONTROLLED: an `exports` key
 * can hold a quote, a control character or a private-use code point, and
 * JSON.stringify escapes those differently from Go (@copilot, PR #1296). The
 * parity fixture's `lintUnknownHostKeys` section is generated from Go with
 * exactly such keys, so a divergence here reds rather than passing.
 *
 * Rules, from Go's appendQuotedWith / appendEscapedRune:
 * - `"` and `\` are backslash-escaped;
 * - a PRINTABLE rune is kept as is. Go's unicode.IsPrint: letters, marks,
 *   numbers, punctuation, symbols, and the ASCII space;
 * - \a \b \f \n \r \t \v by name;
 * - any other rune below U+0020, and U+007F, as `\xNN`;
 * - any other rune as `\uNNNN`, or `\UNNNNNNNN` above U+FFFF (lowercase hex).
 *
 * The printable test uses the JS engine's Unicode tables where Go uses its
 * own, so the two can disagree on code points assigned in only one Unicode
 * version. That is the one residual gap; the parity cases pin the classes
 * that matter.
 */
const PRINTABLE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

const NAMED: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
  0x0b: '\\v',
};

export function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const r = ch.codePointAt(0)!;
    if (ch === '"' || ch === '\\') {
      out += `\\${ch}`;
    } else if (r === 0x20 || PRINTABLE.test(ch)) {
      out += ch;
    } else if (NAMED[r] !== undefined) {
      out += NAMED[r];
    } else if (r < 0x20 || r === 0x7f) {
      out += `\\x${r.toString(16).padStart(2, '0')}`;
    } else if (r < 0x10000) {
      out += `\\u${r.toString(16).padStart(4, '0')}`;
    } else {
      out += `\\U${r.toString(16).padStart(8, '0')}`;
    }
  }
  return `${out}"`;
}
