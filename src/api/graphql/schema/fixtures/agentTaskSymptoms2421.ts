/** #2421: fixed provisional 8/10 top-three benchmark; Holger may replace the target. */
export const taskSymptoms2421 = [
  { symptom: 'migration failure', loc: 'tasks:migration', abstract: 'Symptoms: migration failure, schema deployment error.', why: 'Database migration recovery.' },
  { symptom: 'tenant leak', loc: 'tasks:tenant', abstract: 'Symptoms: tenant leak, foreign organization data exposed.', why: 'Tenant isolation investigation.' },
  { symptom: 'token expired', loc: 'tasks:token', abstract: 'Symptoms: token expired, authentication credential rejected.', why: 'Credential troubleshooting.' },
  { symptom: 'merge conflict', loc: 'tasks:merge', abstract: 'Symptoms: merge conflict, overlapping main changes.', why: 'Main merge recovery.' },
  { symptom: 'test flaky', loc: 'tasks:flake', abstract: 'Symptoms: test flaky, intermittent assertion failure.', why: 'Flake investigation.' },
  { symptom: 'embedding missing', loc: 'tasks:embedding', abstract: 'Symptoms: embedding missing, abstract not searchable.', why: 'Vector indexing recovery.' },
  { symptom: 'review requested', loc: 'tasks:review', abstract: 'Symptoms: review requested, frozen pull request needs inspection.', why: 'Independent review procedure.' },
  { symptom: 'release requested', loc: 'tasks:release', abstract: 'Symptoms: release requested, publish a version.', why: 'Release procedure.' },
  { symptom: 'worker stalled', loc: 'tasks:stall', abstract: 'Symptoms: worker stalled, no progress on assigned task.', why: 'Task stall investigation.' },
  { symptom: 'mail refused', loc: 'tasks:mail', abstract: 'Symptoms: mail refused, outbound email denied.', why: 'Email permission investigation.' },
] as const;
