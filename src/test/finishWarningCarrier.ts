/**
 * #4793: a source-less create no longer warns, so tests that need a mutation which really raises a RECORDED task warning
 * (the history, cap and carrier machinery) use `task.finish.open-children` instead: a started task with an open child,
 * finished by its assignee. The helper makes N such parents; `finishField` is the GraphQL field that finishes one.
 */
type Mutations = { createAgentTask: (...a: any[]) => Promise<any>; startAgentTask: (...a: any[]) => Promise<any> };

/** The assignee of a created task: a user or a worker id. */
export type Assignee = { user: string } | { worker: string };

/**
 * N parents, each assigned to `assignee`, started, with one open child. `as` wraps the calls that must run as that assignee.
 * The parents are independent, so they are built concurrently (the 60 sequential mutations of 21 parents were what forced long timeouts).
 */
export async function finishableParents(
  M: Mutations, ctx: unknown, appRef: string, n: number, assignee: Assignee,
  as: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<string[]> {
  return Promise.all(Array.from({ length: n }, async (_, i) => {
    const parent = await M.createAgentTask({}, { input: { appRef, title: `parent ${i}`, assignee } }, ctx);
    await as(() => M.startAgentTask({}, { taskRef: parent.id }, ctx));
    await as(() => M.createAgentTask({}, { input: { parentTaskId: parent.id, title: `child ${i}` } }, ctx));
    return parent.id as string;
  }));
}

/** One aliased finish: raises `task.finish.open-children` while the task has an open child. */
export const finishField = (alias: string, taskId: string) =>
  `${alias}: finishAgentTask(taskRef: "${taskId}", result: { outcome: "succeeded" }) { id }`;
