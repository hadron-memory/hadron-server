/** #3449: reserve App action codes without conflating payload act/grant identifiers. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { TICK_CODE_PREFIX } from '../tickers/tickCode.js';

const legacy = ['app.properties-changed', 'app.credential-act', 'app.manager-act'].sort();
const isApp = (s: string) => s.startsWith('app.');

/** AST-scoped census: event/register lists, event payload discriminants, literal ORM type writes and raw INSERTs. */
function codes(path: string, source: string): { found: string[]; raw: number } {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  let raw = 0;
  const strings = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isApp(node.text)) found.push(node.text);
    ts.forEachChild(node, strings);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /(?:_EVENT_TYPES|_WARNING_CODES)$/.test(node.name.text) && node.initializer) strings(node.initializer);
    if (path.endsWith('/events.ts') && ts.isTypeAliasDeclaration(node) && node.name.text === 'TaskEventPayload') {
      const discriminants = (n: ts.Node) => {
        if (ts.isPropertySignature(n) && n.name.getText(tree) === 'type' && n.type) strings(n.type);
        ts.forEachChild(n, discriminants);
      };
      discriminants(node);
    }
    if (ts.isCallExpression(node) && /\.agentTeamEvent\.(create|createMany)$/.test(node.expression.getText(tree))) {
      const types = (n: ts.Node) => {
        if (ts.isPropertyAssignment(n) && n.name.getText(tree) === 'type') strings(n.initializer);
        ts.forEachChild(n, types);
      };
      node.arguments.forEach(types);
    }
    if (ts.isTaggedTemplateExpression(node) && /INSERT\s+INTO\s+agent_team_events\b/i.test(node.template.getText(tree))) {
      raw++;
      // These fixed SQL producers contain only platform event types, never opaque App payload data.
      for (const match of node.template.getText(tree).matchAll(/'(app\.[^']+)'/g)) found.push(match[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { found, raw };
}

describe('reserved App event code namespace', () => {
  /**
   * #4458 — cheap necessary-condition pre-filter. Every shape `codes()` guards spells one
   * of these markers contiguously in the raw source (identifiers and SQL table names
   * cannot be split), so a file containing none of them cannot contribute. This keeps the
   * census from TS-parsing ~2,600 files (1.4 s of CPU that timed out at vitest's 5 s
   * default under a contended 4-vCPU shard); the differential test below proves the skip
   * loses nothing by also running the unfiltered walk.
   */
  const MARKERS = ['_EVENT_TYPES', '_WARNING_CODES', 'TaskEventPayload', 'agentTeamEvent', 'agent_team_events'] as const;
  const admits = (source: string) => MARKERS.some((m) => source.includes(m));
  const productionPaths = () =>
    execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' }).trim().split('\n').filter(p => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('/generated/'));
  const census = (filtered: boolean) => {
    const found = new Set<string>();
    const rawPaths: string[] = [];
    for (const path of productionPaths()) {
      const source = readFileSync(path, 'utf8');
      if (filtered && !admits(source)) continue;
      const scan = codes(path, source);
      scan.found.forEach(s => found.add(s));
      if (scan.raw) rawPaths.push(path);
    }
    return { found: [...found].sort(), rawPaths: rawPaths.sort() };
  };

  it('walks every production source and keeps exactly the legacy App event types', () => {
    const { found, rawPaths } = census(true);
    expect(found).toEqual(legacy);
    expect(rawPaths).toEqual(['src/lib/agentTasks/coordinatorCadence.ts', 'src/lib/agentTasks/darkWorker.ts', 'src/lib/agentTasks/events.ts', 'src/lib/agentTasks/postLimit.ts', 'src/lib/agentTasks/saturation.ts', 'src/lib/agentTasks/sweepRuns.ts', 'src/lib/desiredState/desiredStart.ts'].sort());
    expect(TICK_CODE_PREFIX).toBe('tick.');
  });
  it('#4458 the pre-filter skips nothing the full walk would see (differential against the unfiltered census)', { timeout: 60_000 }, () => {
    // The unfiltered walk is the expensive one by design (it parses every production
    // source), so it carries its own generous budget instead of the 5 s default.
    expect(census(true)).toEqual(census(false));
  });
  it('the census sees new entries in every guarded source shape and ignores payload/grant names', () => {
    const fake = `const TASK_EVENT_TYPES = ['app.team.bad', \`app.team.backtick\`];
      type TaskEventPayload = { type: 'app.team.union' };
      tx.agentTeamEvent.create({data:{type:'app.team.orm',payload:{act:'app.payload.allowed'}}});
      tx.$executeRaw\`INSERT INTO agent_team_events(type) VALUES ('app.team.sql')\`;
      type ManagerAct = 'app.model-group.set'; const grant='app.members';`;
    expect(codes('src/lib/agentTasks/events.ts', fake).found.sort()).toEqual(['app.team.bad', 'app.team.backtick', 'app.team.union', 'app.team.orm', 'app.team.sql'].sort());
  });
});
