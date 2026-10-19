/**
 * Ticker-only wake delivery for orca1 (Hugo, 2026-10-18).
 *
 * Delivers ONLY ticker wakes (WakeKind TICK) from hadron dueWakes to the
 * worker's terminal, then acks the proof. Mentions are NOT relayed: chat
 * posts already reach terminals through hadron-chat-send. A wake is acked only
 * after the nudge was accepted; a busy or unresolved terminal is left due and
 * retried next pass. Reuses the router's terminal/idle helpers; shares no
 * token, ledger or lock with it. Interim until hadron-cli#907 (C1).
 *
 * usage: tsx ticker-wake.ts once [--dry] [--ack-mentions] | loop [--interval 120] [--ack-mentions]
 */
import {
  loadConfig, DEFAULT_CONFIG, runCommand, listTerminals, resolveTerminal, provesIdle, sendNudge,
} from '../orca-attention-router/router.js';

const QUERY = `query($a:String!,$p:String){dueWakes(appRef:$a,first:100,after:$p){wakes{worker{id name} reasons{kind ticker{name}} proof} pageInfo{hasNextPage endCursor}}}`;
const SUBS = `query($a:String!){tickers(appRef:$a){subscribers(first:200){items{worker{id}}}}}`;
const ACK = `mutation($p:[String!]!){acknowledgeWakes(proofs:$p){acknowledged unchanged}}`;

function pass(dry: boolean, ackMentions: boolean): void {
  const cfg = loadConfig(DEFAULT_CONFIG);
  const run = runCommand;
  const wakes: any[] = [];
  let page: string | null = null;
  for (let n = 0; n < 10; n++) {
    const argv = [cfg.hadronCli, 'api', QUERY, '-F', `a=${cfg.app}`];
    if (page) argv.push('-F', `p=${page}`);
    const res = JSON.parse(run(argv).stdout);
    const d = res.data?.dueWakes;
    if (!d) throw new Error(`dueWakes failed: ${JSON.stringify(res.errors ?? res).slice(0, 300)}`);
    wakes.push(...d.wakes);
    if (!d.pageInfo.hasNextPage) break;
    page = d.pageInfo.endCursor;
  }
  // Unblock invisible ticks (Liam, no-dark-teams, 2026-10-19): dueWakes re-hands a
  // worker's reservation with its ORIGINAL reasons until acked, so a MENTION-only
  // reservation hides every later TICK. Mentions already reach terminals through
  // hadron-chat-send and an ack never moves a read position, so ack the
  // MENTION-only wakes of ticker subscribers (only them) without nudging.
  // OFF unless --ack-mentions is passed: Holger picks the stopgap (Ada, #21183).
  let stuck: any[] = [];
  if (ackMentions) {
    const subs = !ackMentions ? { data: { tickers: [] } } : JSON.parse(run([cfg.hadronCli, 'api', SUBS, '-F', `a=${cfg.app}`]).stdout);
    const subIds = new Set<string>((subs.data?.tickers ?? []).flatMap((t: any) => t.subscribers.items.map((i: any) => i.worker.id)));
    stuck = wakes.filter((w) => subIds.has(w.worker.id) && !w.reasons.some((r: any) => r.kind === 'TICK'));
  }
  for (const w of stuck) {
    if (dry) { console.log(`${new Date().toISOString()} ${w.worker.name}: WOULD ack mention-only reservation`); continue; }
    const ack = JSON.parse(run([cfg.hadronCli, 'api', ACK, '-F', `p=["${w.proof}"]`]).stdout);
    console.log(`${new Date().toISOString()} ${w.worker.name}: acked mention-only reservation ${JSON.stringify(ack.data?.acknowledgeWakes ?? ack.errors?.[0]?.message)}`);
  }
  const ticks = wakes.filter((w) => w.reasons.some((r: any) => r.kind === 'TICK'));
  const terminals = ticks.length ? listTerminals(cfg, run) : [];
  const ts = new Date().toISOString();
  for (const w of ticks) {
    const name = w.worker.name;
    const entry = cfg.roster.find((e) => e.worker === w.worker.id);
    if (!entry) { console.log(`${ts} ${name}: not on roster`); continue; }
    const [handle, detail] = resolveTerminal(entry, terminals, cfg, run);
    if (!handle) { console.log(`${ts} ${name}: held (${detail})`); continue; }
    const [idle, why] = provesIdle(cfg, handle, detail, undefined, cfg.busyWaitMs, run);
    if (!idle) { console.log(`${ts} ${name}: held (${why})`); continue; }
    const tickers = [...new Set(w.reasons.filter((r: any) => r.kind === 'TICK').map((r: any) => r.ticker?.name))].join(', ');
    const text = `Hadron ticker wake (${tickers}): run your standing routine for this tick, then end your turn. Read only your own mentions; no unfiltered chat catch-up.`;
    if (dry) { console.log(`${ts} ${name}: WOULD nudge ${handle}`); continue; }
    const [ok, d] = sendNudge(cfg, handle, text, run);
    if (!ok) { console.log(`${ts} ${name}: send not accepted (${d})`); continue; }
    const ack = JSON.parse(run([cfg.hadronCli, 'api', ACK, '-F', `p=["${w.proof}"]`]).stdout);
    console.log(`${ts} ${name}: nudged ${handle}; ack ${JSON.stringify(ack.data?.acknowledgeWakes ?? ack.errors?.[0]?.message)}`);
  }
  if (!ticks.length) console.log(`${ts} no ticker wakes due (${wakes.length} mention-only wakes ignored)`);
}

async function main(): Promise<void> {
  const [mode = 'once', ...rest] = process.argv.slice(2);
  const dry = rest.includes('--dry');
  // OFF by default until Holger rules (Ada, 2026-10-19): acking a subscriber's MENTION-only wake.
  const ackMentions = rest.includes('--ack-mentions');
  if (mode === 'loop') {
    const i = rest.indexOf('--interval');
    const sec = i >= 0 ? Number(rest[i + 1]) : 120;
    for (;;) {
      try { pass(false, ackMentions); } catch (e) { console.log(`${new Date().toISOString()} pass failed: ${(e as Error).message}`); }
      await new Promise((r) => setTimeout(r, sec * 1000));
    }
  } else pass(dry, ackMentions);
}
main();
