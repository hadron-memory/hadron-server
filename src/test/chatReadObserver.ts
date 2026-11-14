/** #4105: the one read observer the App-less chat reach pins share (#4070, #4112).
 *
 * A transparent proxy over the resolver's client. It follows interactive transactions (the `tx` client is wrapped too) and
 * records any Node/NodeRevision/Edge find/count/aggregate/groupBy call, or raw query, whose arguments mention a protected id
 * ANYWHERE (nested AND/OR/in/equals included, since it matches on the serialised arguments, not on a where shape), then runs
 * the call unchanged. Its limit: it does NOT audit a read that reaches protected rows through another model's
 * `include`/`select`/relation filter. An empty `reads` therefore pins "none of those explicit reads", never "no protected read
 * at all". Pair a "no read" pin with a positive control that the same observer sees a read when reach is intact.
 */
const READ = /^(find|count|aggregate|groupBy)/;

export function observeClient<C extends object>(client: C, protectedIds: readonly string[], reads: string[]): C {
  const track = (model: string, method: string, args: unknown[]) => {
    const encoded = JSON.stringify(args, (_key, value) => typeof value === 'bigint' ? String(value) : value);
    if (protectedIds.some(id => encoded?.includes(id))) reads.push(`${model}.${method}`);
  };
  const wrap = (target: any): any => new Proxy(target, {
    get(t, key) {
      if (key === '$transaction') return (first: any, ...rest: any[]) =>
        t.$transaction(typeof first === 'function' ? (tx: any) => first(wrap(tx)) : first, ...rest);
      const value = Reflect.get(t, key, t);
      if (key === 'node' || key === 'nodeRevision' || key === 'edge') return new Proxy(value, {
        get(delegate, method) {
          const fn = Reflect.get(delegate, method, delegate);
          if (typeof fn !== 'function') return fn;
          return (...args: unknown[]) => { if (READ.test(String(method))) track(String(key), String(method), args); return fn.apply(delegate, args); };
        },
      });
      if (key === '$queryRaw' || key === '$queryRawUnsafe') return (...args: unknown[]) => { track('$raw', String(key), args); return value.apply(t, args); };
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  return wrap(client);
}
