import { describe, expect, it, vi, afterEach } from 'vitest';
afterEach(() => vi.unstubAllEnvs());
import conformance from './format.fixture.json';
import { automationVersionHash, canonicalizeAutomationJson as jcs, readAutomationLimits, SPEC_LIMITS, validateCompiledAutomation } from './format.js';
const fixture = () => ({
  format: 'hadron-automation-v1', app: 'app-id', entry: 'entry',
  nodes: { entry: { source: { nodeId: 'source-id', revision: 12 }, title: 'Title', abstract: null, content: 'hello', flow: {} } },
  edges: [], environment: {
    ai: { configId: 'config-id', provider: 'anthropic', model: 'model', tier: 1, endpoint: null },
    tools: [], policy: { allow: [] }, budgets: { tokens: 100, actions: 5, timeoutMs: 1000 },
  },
});
const options = { appId: 'app-id', limits: SPEC_LIMITS, resolvesTool: (name: string) => ['hadron_read_node', 'mcp__crm__lookup'].includes(name), resolvesCredential: (ref: string) => ref === 'known-secret-ref' };
const validate = (obj: unknown) => validateCompiledAutomation(obj, options);
describe('RFC 8785 canonical bytes and automation hash', () => {
  it('matches the portable independently derived conformance vector', () => {
    for (const entry of conformance.cases) {
      expect(jcs(entry.value)).toBe(entry.canonical);
      expect(automationVersionHash(entry.value)).toBe(entry.hash);
    }
  });
  it('orders numeric-looking keys lexically, arrays unchanged, and IEEE-754 numbers as ECMAScript', () => {
    expect(jcs({ '2': 2, '10': 10, a: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0] }))
      .toBe('{"10":10,"2":2,"a":[333333333.3333333,1e+30,4.5,0.002,1e-27,0]}');
  });
  it('sorts by UTF-16 rather than code point or locale', () => {
    expect(jcs({ '\ufffd': 1, '\ud83d\ude00': 2, '\u20ac': 3, '\r': 4 })).toBe('{"\\r":4,"€":3,"😀":2,"�":1}');
  });
  it('does not normalize Unicode; rejects invalid Unicode and non-JSON without invoking hooks', () => {
    expect(jcs('e\u0301')).not.toBe(jcs('é'));
    for (const value of ['\ud800', '\udfff', Infinity, NaN, undefined, [undefined], new Date(), { x: undefined }]) expect(() => jcs(value)).toThrow();
    const obj = {}; Object.defineProperty(obj, 'x', { enumerable: true, get: () => { throw new Error('getter invoked'); } });
    expect(() => jcs(obj)).toThrow('NOT_JSON');
    const cyclic: unknown[] = []; cyclic.push(cyclic); expect(() => jcs(cyclic)).toThrow('CYCLE');
  });
  it('binds provenance and separates the hash domain', () => {
    const value = fixture();
    const bytes = '{"app":"app-id","edges":[],"entry":"entry","environment":{"ai":{"configId":"config-id","endpoint":null,"model":"model","provider":"anthropic","tier":1},"budgets":{"actions":5,"timeoutMs":1000,"tokens":100},"policy":{"allow":[]},"tools":[]},"format":"hadron-automation-v1","nodes":{"entry":{"abstract":null,"content":"hello","flow":{},"source":{"nodeId":"source-id","revision":12},"title":"Title"}}}';
    expect(jcs(value)).toBe(bytes);
    expect(automationVersionHash(value)).toBe('d2e6bf3098a418d83d55f05ea95440d67fbdd7dd5101522d4ae896210512fd01');
    const hash = automationVersionHash(value); value.nodes.entry.source.revision++;
    expect(automationVersionHash(value)).not.toBe(hash);
  });
});
describe('lower-only deployment limits', () => {
  it('defaults to ceilings and accepts every lower override', () => {
    expect(readAutomationLimits({})).toEqual(SPEC_LIMITS);
    const env = Object.fromEntries(Object.keys(SPEC_LIMITS).map(key => [`AUTOMATION_MAX_${key}`, '1']));
    expect(Object.values(readAutomationLimits(env))).toEqual([1, 1, 1, 1, 1]);
  });
  it('refuses invalid and above-ceiling values for every knob', () => {
    for (const [key, ceiling] of Object.entries(SPEC_LIMITS)) for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', ' 1', String(ceiling + 1)]) {
      expect(() => readAutomationLimits({ [`AUTOMATION_MAX_${key}`]: value })).toThrow(`AUTOMATION_MAX_${key}`);
    }
  });
});
describe('strict compiled format', () => {
  it('preserves the signed object and refuses unnormalized text in every signed field', () => {
    const f = fixture(); f.nodes.entry.content = 'a\nb\nc';
    const hash = automationVersionHash(f);
    expect(validate(f)).toEqual(f);
    expect(automationVersionHash(validate(f))).toBe(hash);
    for (const field of ['title', 'abstract', 'content'] as const) for (const text of ['a\r\nb', 'a\rb']) {
      const value = fixture(); value.nodes.entry[field] = text as never;
      expect(() => validate(value)).toThrow('NOT_NORMALIZED');
    }
  });
  it('checks size before schema parsing and binds deployment limits even with explicit spec ceilings', () => {
    vi.stubEnv('AUTOMATION_MAX_OBJECT_BYTES', '1');
    expect(() => validate({ unknown: 'too big' })).toThrow('LIMIT_EXCEEDED:AUTOMATION_MAX_OBJECT_BYTES');
    expect(() => validate(fixture())).toThrow('LIMIT_EXCEEDED:AUTOMATION_MAX_OBJECT_BYTES');
    expect(() => validateCompiledAutomation(fixture(), { ...options, limits: undefined })).toThrow('LIMIT_EXCEEDED:AUTOMATION_MAX_OBJECT_BYTES');
  });
  it('refuses rounded provenance revisions and typoed override names', () => {
    const f = fixture(); f.nodes.entry.source.revision = Number.MAX_SAFE_INTEGER + 1;
    expect(() => validate(f)).toThrow('SCHEMA');
    expect(() => readAutomationLimits({ AUTOMATION_MAX_NODE: '1' })).toThrow('Unknown automation limit');
  });
  it('refuses unknown keys at every fixed object seam', () => {
    for (const path of [[], ['nodes','entry'], ['nodes','entry','source'], ['nodes','entry','flow'], ['environment'], ['environment','ai'], ['environment','policy'], ['environment','budgets']]) {
      const f = fixture(); let target: Record<string, unknown> = f;
      for (const key of path) target = target[key] as Record<string, unknown>;
      target.unexpected = 'unsigned'; expect(() => validate(f)).toThrow('SCHEMA');
    }
  });
  it('refuses foreign App, missing entry, external targets, unknown tools and credential values', () => {
    expect(() => validate({ ...fixture(), app: 'other' })).toThrow('APP_MISMATCH');
    expect(() => validate({ ...fixture(), entry: 'missing' })).toThrow('MISSING_NODE');
    for (const flow of [{ runTargets: ['missing'] }, { tools: ['unknown'] }, { credentials: ['secret-value'] }]) {
      const f = fixture(); f.nodes.entry.flow = flow; expect(() => validate(f)).toThrow();
    }
  });
  it('requires registered external tools and rejects duplicate registrations', () => {
    const f = fixture(); f.nodes.entry.flow = { tools: ['mcp__crm__lookup'] };
    expect(() => validate(f)).toThrow('MISSING_REGISTRATION');
    const tool = { name: 'mcp__crm__lookup', registrationId: 'reg', url: 'https://crm.test', opAllowlist: ['lookup'] };
    const registered = { ...f, environment: { ...f.environment, tools: [tool] } };
    expect(validate(registered).environment.tools).toEqual([tool]);
    expect(() => validate({ ...registered, environment: { ...registered.environment, tools: [tool, tool] } })).toThrow('DUPLICATE_TOOL');
  });
  it('validates edge endpoints, shared conditions and distinct orders per source', () => {
    const edge = { from: 'entry', to: 'entry', name: 'next', order: 0, condition: null };
    expect(validate({ ...fixture(), edges: [edge] }).edges).toEqual([edge]);
    expect(() => validate({ ...fixture(), edges: [edge, edge] })).toThrow('DUPLICATE_ORDER');
    expect(() => validate({ ...fixture(), edges: [{ ...edge, to: 'missing' }] })).toThrow('MISSING_NODE');
    expect(() => validate({ ...fixture(), edges: [{ ...edge, condition: { forbidden: [] } }] })).toThrow('INVALID_CONDITION');
    expect(() => validate({ ...fixture(), edges: [{ ...edge, extra: true }] })).toThrow('SCHEMA');
  });
  it('preserves existing extraction fields and refuses reserved names and mixed tools', () => {
    for (const field of ['exception', 'exceptions.child', '__runtime']) {
      const f = fixture(); f.nodes.entry.flow = { extractionSpec: [{ field }] }; expect(() => validate(f)).toThrow('RESERVED_NAME');
    }
    const f = fixture(); f.nodes.entry.flow = { tools: [], extractionSpec: [] }; expect(() => validate(f)).toThrow('TOOLS_AND_EXTRACTION');
  });
  it('accepts a script node and holds its tool to the same checks; script excludes tools and extraction (#670)', () => {
    const ok = fixture(); ok.nodes.entry.flow = { script: { call: { tool: 'hadron_read_node', args: { urn: 'x' } } } };
    expect(() => validate(ok)).not.toThrow();
    for (const extra of [{ tools: ['hadron_read_node'] }, { extractionSpec: [{ field: 'a' }] }]) {
      const f = fixture(); f.nodes.entry.flow = { script: { call: { tool: 'hadron_read_node' } }, ...extra };
      expect(() => validate(f)).toThrow('SCRIPT_AND_TOOLS_OR_EXTRACTION');
    }
    const reg = fixture(); reg.nodes.entry.flow = { script: { call: { tool: 'mcp__crm__lookup' } } };
    expect(() => validate(reg)).toThrow('MISSING_REGISTRATION');
  });
  it('revalidates all caps on load, counting UTF-8 bytes rather than characters', () => {
    const f = fixture(); f.nodes.entry.content = '😀';
    expect(() => validateCompiledAutomation(f, { ...options, limits: { ...SPEC_LIMITS, CONTENT_BYTES: 3 } })).toThrow('LIMIT_EXCEEDED:AUTOMATION_MAX_CONTENT_BYTES');
    expect(() => validateCompiledAutomation(f, { ...options, limits: { ...SPEC_LIMITS, OBJECT_BYTES: 1 } })).toThrow('LIMIT_EXCEEDED:AUTOMATION_MAX_OBJECT_BYTES');
    expect(() => validateCompiledAutomation({ ...f, nodes: { ...f.nodes, second: f.nodes.entry } }, { ...options, limits: { ...SPEC_LIMITS, NODES: 1 } })).toThrow('LIMIT_EXCEEDED:AUTOMATION_MAX_NODES');
    const edge = { from: 'entry', to: 'entry', name: 'next', order: 0, condition: null };
    expect(() => validateCompiledAutomation({ ...f, edges: [edge, { ...edge, order: 1 }] }, { ...options, limits: { ...SPEC_LIMITS, EDGES: 1 } })).toThrow('LIMIT_EXCEEDED:AUTOMATION_MAX_EDGES');
    f.nodes.entry.flow = { tools: ['hadron_read_node', 'mcp__crm__lookup'] };
    expect(() => validateCompiledAutomation(f, { ...options, limits: { ...SPEC_LIMITS, TOOLS_PER_NODE: 1 } })).toThrow('LIMIT_EXCEEDED:AUTOMATION_MAX_TOOLS_PER_NODE');
  });
});
