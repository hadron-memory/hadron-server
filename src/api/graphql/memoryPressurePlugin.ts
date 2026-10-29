import type { ApolloServerPlugin } from '@apollo/server';

const MiB = 1024 * 1024;
const MAX_TRACKED = 1000;
const MAX_REPORTED = 20;
const OPERATION_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,99}$/;
export type MemoryPressureConfig = { heapBytes: number; rssBytes: number };

export function readMemoryPressureConfig(env = process.env): MemoryPressureConfig {
  const read = (name: string, fallback: number) => {
    const value = env[name];
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return Number(value);
  };
  return {
    heapBytes: read('GRAPHQL_MEMORY_LOG_HEAP_BYTES', 2048 * MiB),
    rssBytes: read('GRAPHQL_MEMORY_LOG_RSS_BYTES', 3072 * MiB),
  };
}

type Deps = {
  memory?: () => { heapUsed: number; rss: number };
  now?: () => number;
  log?: (line: string) => void;
};

/** #2758: bounded, best-effort visibility before the 4GiB cgroup kill, never request payloads. */
export function memoryPressurePlugin(config = readMemoryPressureConfig(), deps: Deps = {}): ApolloServerPlugin<{ userId?: string; appId?: string; apiKeyId?: string }> {
  const memory = deps.memory ?? process.memoryUsage;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const active = new Map<number, { operationName: string | null; principal: string; startedAt: number }>();
  let sequence = 0;
  let untracked = 0;
  let lastLogAt = -Infinity;
  let timer: ReturnType<typeof setInterval> | undefined;
  const sample = () => {
    try {
      const { heapUsed, rss } = memory();
      const at = now();
      if ((heapUsed < config.heapBytes && rss < config.rssBytes) || at - lastLogAt < 60_000) return;
      lastLogAt = at;
      const operations = [];
      for (const entry of active.values()) {
        if (operations.length === MAX_REPORTED) break;
        operations.push({ operationName: entry.operationName, principal: entry.principal, elapsedMs: Math.max(0, at - entry.startedAt) });
      }
      log(JSON.stringify({ event: 'graphql.memory_pressure', heapUsed, rss, inFlight: active.size + untracked,
        operations, omitted: active.size + untracked - operations.length }));
    } catch {
      // Observability must not change an operation's result or throw from the sampler.
    }
  };
  return {
    async serverWillStart() {
      timer = setInterval(sample, 1000);
      timer.unref();
      return { async serverWillStop() { if (timer) clearInterval(timer); active.clear(); } };
    },
    async requestDidStart() {
      let id: number | undefined;
      let registered = false;
      return {
        async didResolveOperation(rc) {
          if (registered) return;
          registered = true;
          const name = rc.operationName;
          if (active.size < MAX_TRACKED) {
            id = ++sequence;
            active.set(id, {
              operationName: name && OPERATION_NAME.test(name) ? name : null,
              principal: rc.contextValue.userId ? 'user' : rc.contextValue.appId || rc.contextValue.apiKeyId ? 'app' : 'anonymous',
              startedAt: now(),
            });
          } else untracked++;
          sample();
        },
        async willSendResponse() {
          sample();
          if (!registered) return;
          registered = false;
          if (id !== undefined) active.delete(id);
          else untracked--;
        },
      };
    },
  };
}
