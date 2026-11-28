/** #2421: fixed provisional 8/10 top-three benchmark; Holger may replace the target. */
export const taskPhrases2421 = [
  { phrase: 'migration failure', loc: 'tasks:migration', abstract: 'Symptoms: migration failure, schema deployment error.', why: 'Database migration recovery.' },
  { phrase: 'tenant leak', loc: 'tasks:tenant', abstract: 'Symptoms: tenant leak, foreign organization data exposed.', why: 'Tenant isolation investigation.' },
  { phrase: 'token expired', loc: 'tasks:token', abstract: 'Symptoms: token expired, authentication credential rejected.', why: 'Credential troubleshooting.' },
  { phrase: 'merge conflict', loc: 'tasks:merge', abstract: 'Symptoms: merge conflict, overlapping main changes.', why: 'Main merge recovery.' },
  { phrase: 'test flaky', loc: 'tasks:flake', abstract: 'Symptoms: test flaky, intermittent assertion failure.', why: 'Flake investigation.' },
  { phrase: 'embedding missing', loc: 'tasks:embedding', abstract: 'Symptoms: embedding missing, abstract not searchable.', why: 'Vector indexing recovery.' },
  { phrase: 'review requested', loc: 'tasks:review', abstract: 'Symptoms: review requested, frozen pull request needs inspection.', why: 'Independent review procedure.' },
  { phrase: 'release requested', loc: 'tasks:release', abstract: 'Symptoms: release requested, publish a version.', why: 'Release procedure.' },
  { phrase: 'worker stalled', loc: 'tasks:stall', abstract: 'Symptoms: worker stalled, no progress on assigned task.', why: 'Task stall investigation.' },
  { phrase: 'mail refused', loc: 'tasks:mail', abstract: 'Symptoms: mail refused, outbound email denied.', why: 'Email permission investigation.' },
] as const;
