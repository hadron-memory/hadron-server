import { GraphQLError } from 'graphql';
import { pointer, validateTeamSpec, type TeamSpecForm } from './schema.js';
import { canonicalizeTeamJson } from './canonicalize.js';

/** JSON.parse discards duplicate keys. Scan syntax first, before it can do so. */
export function parseTeamSpec(text: string, form: TeamSpecForm = 'SERVER') {
  let at = 0;
  // Sticky matching scans the original input at the cursor. Slicing the
  // remaining text for every scalar token makes long arrays quadratic.
  const scalarToken = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const fail = (message: string, path: (string | number)[], code = 'INVALID_JSON'): never => {
    const prefix = text.slice(0, at);
    const line = prefix.split('\n').length;
    const column = at - prefix.lastIndexOf('\n');
    throw new GraphQLError('Invalid team spec JSON', { extensions: { code: 'TEAM_SPEC_INVALID', issues: [{
      pointer: pointer(path), code, message, line, column,
    }] } });
  };
  const ws = () => { while (/[\t\r\n ]/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (path: (string | number)[]) => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') at++;
      else if (c === '"') {
        try { return JSON.parse(text.slice(start, at)) as string; }
        catch { fail('Invalid string', path); }
      }
    }
    return fail('Unterminated string', path);
  };
  const value = (path: (string | number)[], depth: number): void => {
    if (depth > 100) fail('JSON nesting is too deep', path);
    ws();
    if (text[at] === '{') {
      at++; ws(); const seen = new Set<string>();
      if (text[at] === '}') { at++; return; }
      for (;;) {
        ws(); if (text[at] !== '"') fail('Expected object key', path);
        const key = string(path);
        if (seen.has(key)) fail('Duplicate object key', [...path, key], 'DUPLICATE_KEY');
        seen.add(key); ws(); if (text[at++] !== ':') fail('Expected colon', path);
        value([...path, key], depth + 1); ws();
        const end = text[at++]; if (end === '}') return;
        if (end !== ',') fail('Expected comma or closing brace', path);
      }
    }
    if (text[at] === '[') {
      at++; ws(); if (text[at] === ']') { at++; return; }
      let index = 0;
      for (;;) {
        value([...path, index++], depth + 1); ws();
        const end = text[at++]; if (end === ']') return;
        if (end !== ',') fail('Expected comma or closing bracket', path);
      }
    }
    if (text[at] === '"') { string(path); return; }
    scalarToken.lastIndex = at;
    const token = scalarToken.exec(text);
    if (!token) fail('Expected JSON value', path);
    at += token![0].length;
  };
  value([], 0); ws(); if (at !== text.length) fail('Unexpected trailing text', []);
  const input: unknown = JSON.parse(text);
  try { canonicalizeTeamJson(input); }
  catch { fail('JSON must contain finite numbers and valid Unicode', [], 'INVALID_JSON_VALUE'); }
  return validateTeamSpec(input, form);
}
