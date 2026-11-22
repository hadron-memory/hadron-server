/**
 * #4793: a source-less create no longer warns, so tests that need a mutation which really raises a RECORDED task warning
 * (the history, cap and carrier machinery) use `task.finish.open-children` instead: a started task with an open child,
 * finished by its assignee. The helper makes N such parents; `finishField` is the GraphQL field that finishes one.
 */
type Mutations = { createAgentTask: (...a: any[]) => Promise<any>; startAgentTask: (...a: any[]) => Promise<any> };

/** N parents, each assigned to `assignee`, started, with one open child. `as` wraps the calls that must run as that assignee. */
export async function finishableParents(
  M: Mutations, ctx: unknown, appRef: string, n: number, assignee: Record<string, string>,
  as: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const parent = await M.createAgentTask({}, { input: { appRef, title: `parent ${i}`, assignee } }, ctx);
    await as(() => M.startAgentTask({}, { taskId: parent.id }, ctx));
    await as(() => M.createAgentTask({}, { input: { parentTaskId: parent.id, title: `child ${i}` } }, ctx));
    ids.push(parent.id);
  }
  return ids;
}

/** One aliased finish: raises `task.finish.open-children` while the task has an open child. */
export const finishField = (alias: string, taskId: string) =>
  `${alias}: finishAgentTask(taskId: "${taskId}", result: { outcome: "succeeded" }) { id }`;
