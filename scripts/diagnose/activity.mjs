// W2 synthetic activity (#2598): gives the embed worker, the task matcher and the stall evaluator real work through the
// product's own GraphQL API, on a disposable stack only. All rows are synthetic; the embedding endpoint is a local stub.
// Output is counts only; server error text is never echoed (it can carry values).
const APP = 'hrn:app:e2e-alpha:team';
const MEMORY = 'hrn:mem:e2e-alpha:knowledge';

async function gql(base, key, fetchImpl, name, query, variables) {
  const res = await fetchImpl(`${base}/graphql`, { method: 'POST', body: JSON.stringify({ query, variables }),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) throw new Error(`W2 step failed: ${name}`);
  return json.data;
}

export async function run({ base, key, nodes = 40, tasks = 5, fetchImpl = fetch }) {
  // A 1-minute unassignable window so a queued task with no live worker raises a stall alarm inside a short smoke.
  await gql(base, key, fetchImpl, 'setAgentTaskStallSchedule',
    'mutation($app: ID!) { setAgentTaskStallSchedule(appRef: $app, input: { assignmentMinutes: 1 }) { assignmentMinutes } }', { app: APP });
  let nodesCreated = 0, tasksQueued = 0;
  for (let i = 0; i < nodes; i++) {
    await gql(base, key, fetchImpl, 'createNode',
      'mutation($input: CreateNodeInput!) { createNode(input: $input) { id } }',
      { input: { memoryId: MEMORY, loc: `diag:w2:${i}`, name: `diag w2 ${i}`, content: `Synthetic diagnosis fixture ${i}. ${'lorem ipsum '.repeat(40)}` } });
    nodesCreated++;
  }
  for (let i = 0; i < tasks; i++) {
    await gql(base, key, fetchImpl, 'createAgentTask',
      'mutation($input: CreateAgentTaskInput!) { createAgentTask(input: $input) { id } }',
      { input: { appRef: APP, title: `diag w2 task ${i}` } });
    tasksQueued++;
  }
  return { stallWindowSet: true, nodesCreated, tasksQueued };
}

const NOT = 'not exercised';
// `observed` values come from the stack (stub request count, database counts); null means the read did not happen.
export function w2Line({ created, observed }) {
  const v = (x) => (Number.isSafeInteger(x) ? x : NOT);
  return { kind: 'w2', nodesCreated: created.nodesCreated, tasksQueued: created.tasksQueued,
    embedRequests: v(observed.embedRequests), embeddedNodes: v(observed.embeddedNodes), stallAlarms: v(observed.stallAlarms) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base] = process.argv.slice(2);
  const key = process.env.HADRON_DIAG_ADMIN_KEY;
  if (!key) { console.error('HADRON_DIAG_ADMIN_KEY is required'); process.exit(2); }
  console.log(JSON.stringify({ kind: 'w2-created', ...(await run({ base, key })) }));
}
