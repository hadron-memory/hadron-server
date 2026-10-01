/** #1551 source ratchet: every named authority writer enters the anchor helper. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';

const DIRECT = [
  ['resolvers.mutation.org.ts', 'updateUserRoles'],
  ['resolvers.mutation.org.ts', 'createUserInvitation'],
  ['resolvers.mutation.org.ts', 'acceptInvitation'],
  ['resolvers.mutation.org.ts', 'addOrgMember'],
  ['resolvers.mutation.org.ts', 'updateOrgMember'],
  ['resolvers.mutation.memory.ts', 'createMemoryShare'],
  ['resolvers.mutation.memory.ts', 'updateMemoryShareRole'],
  ['resolvers.mutation.memory.ts', 'addMemoryMember'],
  ['resolvers.mutation.memory.ts', 'updateMemoryMemberRole'],
  ['resolvers.principalGrant.ts', 'createPrincipalGrant'],
  ['resolvers.connectionGrant.ts', 'createConnectionGrant'],
  ['resolvers.mutation.agent.ts', 'createAgentOrgGrant'],
  ['resolvers.mutation.app.ts', 'createAppKey'],
  ['resolvers.mutation.app.ts', 'regenerateAppKey'],
  ['resolvers.mutation.app.ts', 'createUserApiKey'],
  ['resolvers.appRun.ts', 'createAgentWebhook'],
  ['resolvers.appRun.ts', 'rotateAgentWebhook'],
  ['resolvers.mutation.memory.ts', 'addMemoryToAgent'],
  ['resolvers.mutation.memory.ts', 'updateAgentMemoryRole'],
  ['resolvers.mutation.memory.ts', 'createMemorySubscription'],
  ['resolvers.mutation.memoryTransfer.ts', 'transferMemoryOwnership'],
  ['resolvers.impersonation.ts', 'startImpersonation'],
  ['resolvers.mutation.app.ts', 'ensureAppMember'],
] as const;

// These public mutations deliberately delegate to one shared implementation.
// Keeping the exact delegate here prevents a second bare write being added.
const DELEGATED = [
  ['resolvers.mutation.app.ts', 'installAgentIntoApp', 'installAgentIntoAppCore'],
  ['resolvers.mutation.app.ts', 'addAgentToApp', 'installAgentIntoAppCore'],
] as const;

// Related writes outside #1551's named grant-mutation scope. #1573 tracks the
// createApp/startChat atomicity review. Keep these visible and count their
// call sites so a new indirect writer changes this ratchet instead of silently
// joining the exception.
const EXEMPT = [
  { file: 'resolvers.mutation.org.ts', name: 'inviteUser', callee: 'ctx.db.userInvitation.create', count: 1,
    why: 'A referral invitation has no organization and cannot mint an OrgMember.' },
  { file: 'resolvers.mutation.app.ts', name: 'createApp', callee: 'ensureAgentOrgGrant', count: 2,
    why: 'Primary and dependency licenses are incidental to new-App creation, outside the named grant mutations.' },
  { file: 'resolvers.mutation.app.ts', name: 'createApp', callee: 'ensureAgentSubscription', count: 1,
    why: 'Personal-App auto-license is an incidental createApp side effect.' },
  { file: 'resolvers.mutation.chat.ts', name: 'startChat', callee: 'ensureAgentSubscription', count: 1,
    why: 'Legacy chat startup auto-provisions a license; the session workflow needs its own atomicity review.' },
] as const;

function mutationBody(file: string, name: string): ts.Node {
  const path = `src/api/graphql/schema/${file}`;
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error(`Missing mutation ${file}#${name}`);
  return found;
}

function calls(node: ts.Node, callee: string): boolean {
  let found = false;
  function visit(child: ts.Node): void {
    if (ts.isCallExpression(child) && child.expression.getText() === callee) found = true;
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}

function callCount(node: ts.Node, callee: string): number {
  let count = 0;
  function visit(child: ts.Node): void {
    if (ts.isCallExpression(child) && child.expression.getText() === callee) count++;
    ts.forEachChild(child, visit);
  }
  visit(node);
  return count;
}

describe('#1551 authority writer ratchet', () => {
  it('every directly handled grant mutation uses the shared anchor transaction', () => {
    const missing = DIRECT.filter(([file, name]) => {
      const body = mutationBody(file, name);
      return !calls(body, 'withAuthorizedTx') && !calls(body, 'withAuthorizedMemoryTx');
    });
    expect(missing).toEqual([]);
  });

  it('delegated install mutations retain the one anchored implementation', () => {
    const missing = DELEGATED.filter(([file, name, core]) => !calls(mutationBody(file, name), core));
    expect(missing).toEqual([]);
    const helper = readFileSync('src/api/graphql/schema/resolvers.helpers.ts', 'utf8');
    expect(helper.slice(helper.indexOf('export async function installAgentIntoAppCore'),
      helper.indexOf('export async function uninstallAgentFromAppCore'))).toContain('withAuthorizedTx(');
  });

  it('out-of-scope indirect grant writers have an explicit, current inventory', () => {
    for (const exception of EXEMPT) {
      expect(exception.why.length).toBeGreaterThan(20);
      expect(callCount(mutationBody(exception.file, exception.name), exception.callee),
        `${exception.file}#${exception.name}: ${exception.why}`).toBe(exception.count);
    }
    const expectedByFile = new Map([
      ['resolvers.mutation.agent.ts', 1],
      ['resolvers.mutation.app.ts', 3],
      ['resolvers.mutation.chat.ts', 1],
      ['resolvers.helpers.ts', 2],
    ]);
    const files = execFileSync('git', ['ls-files', 'src/api/graphql/schema/resolvers*.ts'], { encoding: 'utf8' })
      .split('\n').filter((file) => file && !file.endsWith('.test.ts'));
    const actual = new Map<string, number>();
    for (const file of files) {
      const count = [...readFileSync(file, 'utf8').matchAll(/\bensureAgent(?:OrgGrant|Subscription)\(/g)].length;
      if (count) actual.set(file.slice(file.lastIndexOf('/') + 1), count);
    }
    expect([...actual].sort()).toEqual([...expectedByFile].sort());
  });
});
