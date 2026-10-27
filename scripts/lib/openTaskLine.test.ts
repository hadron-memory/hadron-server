import { describe, it, expect } from 'vitest';
import { countOpenTasks, openTaskLine, OPEN_TASKS_MAX_PAGES, OPEN_TASKS_PAGE, OPEN_TASKS_QUERY } from './openTaskLine.js';

const row = (id: string, worker = 'w1', status = 'PENDING', kind = 'WORKER') => ({ id, status, assignee: { kind, id: worker } });
const rows = (n: number, worker = 'w1', from = 0) => Array.from({ length: n }, (_, i) => row(`t${from + i}`, worker));

/** A server that serves `all` in pages of 200 by the `o=` offset, recording each request's variables. */
function server(all: unknown[]) {
  const seen: string[][] = [];
  const run = (argv: string[]) => {
    const f = (k: string) => argv.find((a, i) => argv[i - 1] === '-F' && a.startsWith(`${k}=`))?.slice(k.length + 1) as string;
    seen.push([argv[0], argv[1], argv[2], f('a'), f('w'), f('o')]);
    const o = Number(f('o'));
    return { code: 0, stdout: JSON.stringify({ data: { agentTasks: all.slice(o, o + OPEN_TASKS_PAGE) } }) };
  };
  return { run, seen };
}
const count = (all: unknown[]) => countOpenTasks(server(all).run, 'hadron', 'app1', 'w1');

describe('countOpenTasks (#2613)', () => {
  it('asks for the delivered worker in the wake App, PENDING and STARTED only', () => {
    const s = server(rows(1));
    expect(countOpenTasks(s.run, 'hadron', 'app1', 'w1')).toBe(1);
    expect(s.seen).toEqual([['hadron', 'api', OPEN_TASKS_QUERY, 'app1', 'w1', '0']]);
    expect(OPEN_TASKS_QUERY).toContain('status:[PENDING,STARTED]');
    expect(OPEN_TASKS_QUERY).toContain('assignee:{worker:$w}');
  });

  it('counts assigned PENDING and STARTED; none is zero', () => {
    expect(count([row('a', 'w1', 'PENDING'), row('b', 'w1', 'STARTED')])).toBe(2);
    expect(count([])).toBe(0);
  });

  it('a row that is not open, not a worker assignee or not this worker makes the count unknown, never a guess', () => {
    for (const bad of [row('a', 'w1', 'FINISHED'), row('a', 'w1', 'CANCELLED'), row('a', 'w1', 'BACKLOG'),
      row('a', 'w2'), row('a', 'w1', 'PENDING', 'USER'), { id: 'a', status: 'PENDING', assignee: null }, { status: 'PENDING', assignee: { kind: 'WORKER', id: 'w1' } }]) {
      expect(count([row('ok'), bad])).toBeNull();
    }
  });

  it('pages: a short page ends the read; 21, 200, 201 and 401 are exact', () => {
    expect(count(rows(21))).toBe(21);
    expect(count(rows(200))).toBe(200); // a full page is NOT an error: the next read answers short (empty)
    expect(count(rows(201))).toBe(201);
    expect(count(rows(401))).toBe(401);
    const s = server(rows(200));
    countOpenTasks(s.run, 'hadron', 'app1', 'w1');
    expect(s.seen.map((r) => r[5])).toEqual(['0', '200']);
  });

  it('deduplicates by task id when pages shift', () => {
    const shifted = [...rows(200), ...rows(2, 'w1', 199)]; // t199 and t200 reappear on page two
    expect(count(shifted)).toBe(201);
  });

  it('over the page budget is unknown, not a partial count', () => {
    expect(count(rows(OPEN_TASKS_MAX_PAGES * OPEN_TASKS_PAGE))).toBeNull();
    expect(count(rows(OPEN_TASKS_MAX_PAGES * OPEN_TASKS_PAGE - 1))).toBe(OPEN_TASKS_MAX_PAGES * OPEN_TASKS_PAGE - 1);
  });

  it('a failing, refused, malformed or missing page is unknown (never zero), and never throws', () => {
    const w = (stdout: string, code = 0) => () => ({ code, stdout });
    for (const run of [
      w('', 1), w('not json'), w('{}'), w('{"data":{"agentTasks":null}}'), w('{"data":{"agentTasks":{}}}'),
      w('{"errors":[{"message":"x"}],"data":{"agentTasks":[]}}'), w('{"error":{"code":"x"}}'),
      () => { throw new Error('spawn'); },
    ]) expect(countOpenTasks(run, 'hadron', 'app1', 'w1')).toBeNull();
    // A later page failing after a full first page is also unknown.
    let n = 0;
    const second = () => (++n === 1 ? { code: 0, stdout: JSON.stringify({ data: { agentTasks: rows(200) } }) } : { code: 1, stdout: '' });
    expect(countOpenTasks(second, 'hadron', 'app1', 'w1')).toBeNull();
  });

  it('an unbound worker or unresolved App reads nothing', () => {
    const s = server(rows(3));
    expect(countOpenTasks(s.run, 'hadron', '', 'w1')).toBeNull();
    expect(countOpenTasks(s.run, 'hadron', 'app1', '')).toBeNull();
    expect(s.seen).toEqual([]);
  });
});

describe('openTaskLine (#2613)', () => {
  const line = (all: unknown[]) => openTaskLine(server(all).run, 'hadron', 'app1', 'w1');
  it('names the count and the command, singular and plural', () => {
    expect(line(rows(1))).toBe(' You have 1 open task (as read when this was sent); run `hadron team task mine`.');
    expect(line(rows(3))).toBe(' You have 3 open tasks (as read when this was sent); run `hadron team task mine`.');
  });
  it('is empty for zero and for unknown', () => {
    expect(line([])).toBe('');
    expect(line([row('a', 'w2')])).toBe('');
    expect(openTaskLine(() => ({ code: 1, stdout: '' }), 'hadron', 'app1', 'w1')).toBe('');
  });
});
