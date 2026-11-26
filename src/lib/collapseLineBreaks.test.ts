import { describe, expect, it } from 'vitest';
import { collapseLineBreaks } from './collapseLineBreaks.js';

/** #5236: the helper's own contract, so a future regex simplification cannot reopen the hole behind a narrower oracle. */
describe('collapseLineBreaks', () => {
  it('turns every C0 and C1 control character, and U+2028 and U+2029, into one space each', () => {
    const codes = [...Array.from({ length: 0x20 }, (_, i) => i), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i), 0x2028, 0x2029];
    for (const c of codes) expect(collapseLineBreaks(`a${String.fromCharCode(c)}b`), `U+${c.toString(16)}`).toBe('a b');
  });

  it('does not collapse runs: CRLF is two spaces, as oneLineText always did', () => {
    expect(collapseLineBreaks('a\r\nb')).toBe('a  b');
  });

  it('leaves printable text, other whitespace-like letters and astral characters untouched, and never cuts', () => {
    const plain = 'team \u2014 hrn:mem:org:chats:team (loc) ' + '\u{1F600}' + 'x'.repeat(500);
    expect(collapseLineBreaks(plain)).toBe(plain);
    expect(collapseLineBreaks('')).toBe('');
  });
});
