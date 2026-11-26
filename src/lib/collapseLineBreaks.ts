/**
 * #5236 - tenant-editable text inside a line-parsed answer or briefing. Control characters (CR, LF, NEL and the rest of
 * C0 and C1) and the Unicode line separators U+2028 and U+2029 each collapse to one space, so the text can never plant a
 * line of its own (the #4587 / #4543 class). It does NOT cut: a caller that wants a length cap (the whoami
 * `oneLineText`) adds its own, and a caller that has never cut (the register block) must not start to.
 */
export function collapseLineBreaks(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}
