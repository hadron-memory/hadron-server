/** Diagnostic-only guard. Model/raw client calls remain usable for seeding outside the span. */
export function guardFixtureClient3638<T extends object>(client: T, active: () => boolean): T {
    const proxies = new WeakMap<object, object>();
    function wrap<V extends object>(target: V): V {
        const existing = proxies.get(target);
        if (existing)
            return existing as V;
        const proxy = new Proxy(target, {
            get(object, property) {
                const value: unknown = Reflect.get(object, property, object);
                if (typeof value === 'function') {
                    return (...args: unknown[]) => {
                        if (active())
                            throw new Error(`unmeasured fixture/global client: ${String(property)}`);
                        return Reflect.apply(value, object, args);
                    };
                }
                return value !== null && typeof value === 'object' ? wrap(value) : value;
            },
        });
        proxies.set(target, proxy);
        return proxy;
    }
    return wrap(client);
}
