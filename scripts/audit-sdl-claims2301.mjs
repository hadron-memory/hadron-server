/** #2301/#1246: reproducible review population, not a truth checker or the lost historical "114" scan.
 * Run: node scripts/audit-sdl-claims2301.mjs [git-ref] > claims.json
 * Reads the frozen source with git, then parses the TS template and GraphQL descriptions.
 * Includes absolute/dated words and standalone numbers or word quantities followed by a noun-like word;
 * excludes digits immediately following #, :, or an identifier (issue/citation atoms).
 * False positives remain review candidates, never findings. No DB access or source mutation.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parse, visit } from 'graphql';

export const CLAIM_PATTERN = /\b(?:only|always|never|today|currently)\b|(?<![#:\w])\b\d+\b(?![:\w])|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+[A-Za-z][A-Za-z-]*/i;
export function scanClaims(source) {
  const file = ts.createSourceFile('typeDefs.ts', source, ts.ScriptTarget.Latest, true);
  let literal;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(file) === 'typeDefs') literal = declaration.initializer;
    }
  }
  if (!literal || !ts.isNoSubstitutionTemplateLiteral(literal)) throw new Error('Expected one static typeDefs template.');
  const offset = file.getLineAndCharacterOfPosition(literal.getStart(file)).line;
  const rows = [];
  visit(parse(literal.text), {
    enter(node, _key, _parent, _path, ancestors) {
      if (!node.description || !CLAIM_PATTERN.test(node.description.value)) return;
      const enclosing = [...ancestors].reverse().find(value => value && !Array.isArray(value) && value.name && value.kind?.endsWith('TypeDefinition'));
      const field = [...ancestors].reverse().find(value => value && !Array.isArray(value) && value.kind === 'FieldDefinition');
      const coord = enclosing
        ? node.kind === 'InputValueDefinition' && field
          ? `${enclosing.name.value}.${field.name.value}(${node.name.value}:)`
          : `${enclosing.name.value}.${node.name.value}`
        : node.name?.value ?? '<schema>';
      rows.push({ line: offset + node.description.loc.startToken.line, coord, text: node.description.value });
    },
  });
  return rows;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ref = process.argv[2] ?? 'cef136bb';
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const source = execFileSync('git', ['show', `${sha}:src/api/graphql/schema/typeDefs.ts`], { encoding: 'utf8' });
  const rows = scanClaims(source);
  console.log(JSON.stringify({ instrument: 'sdl-claims-v1-2301', sha, pattern: CLAIM_PATTERN.source, count: rows.length, rows }, null, 2));
}
