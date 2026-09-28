import { describe, expect, it } from 'vitest';
import { extractMentions } from './teamChatMentions.js';

describe('extractMentions — Markdown code candidate (#1423)', () => {
  it.each([
    ['single-backtick code span', 'field stays `@deprecated` in SDL, cc @ada', ['ada']],
    ['longer delimiter with an inner backtick', 'use ``@Injectable(`x`)`` decorator, @ella', ['ella']],
    ['quoted command', 'the CLI example `hadron team chat post "@chip ping"` is wrong; @gil please fix', ['gil']],
    ['unclosed backtick remains ordinary text', 'an unmatched ` then @ada', ['ada']],
    ['escaped backtick remains ordinary text', 'literal \\` then @ada', ['ada']],
    ['email and boundary outside code', 'x@example.com `@chip` (@iris) start@end @real-one', ['iris', 'real-one']],
    ['code-only body', '`@team` and ``@all``', []],
  ])('excludes %s without losing plain-text mentions', (_name, body, expected) => {
    expect(extractMentions(body)).toEqual(expected);
  });

  it.each([
    ['backtick fence', ['```ts', '@Component({})', '```', 'thanks @dara'].join('\n'), ['dara']],
    ['tilde fence', ['~~~', '@chip run this', '~~~', '@ada fyi'].join('\n'), ['ada']],
    ['long fence', ['````', '``` @chip', '````', '@ada'].join('\n'), ['ada']],
    ['four-space indent', ['    @liam indented code', 'end @ada'].join('\n'), ['ada']],
    ['tab indent', ['\t@liam indented code', 'end @ada'].join('\n'), ['ada']],
    ['paragraph continuation is not an indented block', ['hello', '    @chip still in paragraph'].join('\n'), ['chip']],
    ['unclosed fence', ['```', '@chip', '@ada'].join('\n'), []],
  ])('excludes %s', (_name, body, expected) => {
    expect(extractMentions(body)).toEqual(expected);
  });

  it('retains token spelling, case folding, dedupe and email boundaries', () => {
    expect(extractMentions('@Iris @bob-1 @iris! x@example.com @ alone')).toEqual(['iris', 'bob-1']);
    expect(extractMentions('(@iris) start@end @real-one')).toEqual(['iris', 'real-one']);
  });
});
