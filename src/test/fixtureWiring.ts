import ts from 'typescript';

/** Inspect source without importing the integration module or matching comments. */
export function assertFixtureWiring(source: string): void {
  const file = ts.createSourceFile('parity.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fail = (message: string): never => { throw new Error(message); };
  const id = (node: ts.Node | undefined, name: string) => !!node && ts.isIdentifier(node) && node.text === name;
  const call = (node: ts.Node | undefined, name: string): node is ts.CallExpression => !!node && ts.isCallExpression(node) && id(node.expression, name);
  const method = (node: ts.Node | undefined, name: string): node is ts.CallExpression => !!node && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && id(node.expression.expression, 'lifetime') && node.expression.name.text === name;
  const statements = file.statements;
  const registrations = statements.filter(s => ts.isExpressionStatement(s) && call(s.expression, 'fixtureIt'));
  if (registrations.length !== 8 || statements.some(s => ts.isExpressionStatement(s) && call(s.expression, 'it'))) fail('eight fixture registrations required');
  let wrapper: ts.ArrowFunction | undefined;
  for (const s of statements) if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
    if (id(d.name, 'fixtureIt') && d.initializer && ts.isArrowFunction(d.initializer)) wrapper = d.initializer;
  }
  const wrapped = wrapper?.body;
  if (!call(wrapped, 'it')) return fail('fixtureIt must call it');
  const callback = wrapped.arguments[1];
  if (!callback || !ts.isArrowFunction(callback) || !method(callback.body, 'run') || !id(callback.body.arguments[0], 'body')) fail('wrapper must enter lifetime.run(body)');
  const hook = (name: string) => {
    const hooks = statements.filter((s): s is ts.ExpressionStatement => ts.isExpressionStatement(s) && call(s.expression, name));
    if (hooks.length !== 1) return fail('one ' + name + ' required');
    const expression = hooks[0].expression as ts.CallExpression;
    const callback = expression.arguments[0];
    if (!callback || !ts.isArrowFunction(callback)) return fail('hook callback required');
    return callback.body;
  };
  const drain = (node: ts.Node | undefined) => method(node, 'drain') && id(node.arguments[0], 'closeResources');
  const before = hook('beforeEach');
  // The very first executable statement must await the shared drain. This
  // precedes every reset/delete, not just one spelling of cleanDb.
  if (!ts.isBlock(before)) return fail('beforeEach block required');
  const first = before.statements.find(s => !ts.isEmptyStatement(s));
  if (!first || !ts.isExpressionStatement(first) || !ts.isAwaitExpression(first.expression) || !drain(first.expression.expression)) fail('await drain before any setup');
  const after = hook('afterEach');
  const joined = ts.isBlock(after) ? after.statements.length === 1 && ts.isReturnStatement(after.statements[0]) && drain(after.statements[0].expression) : drain(after);
  if (!joined) fail('afterEach must join drain');
}
