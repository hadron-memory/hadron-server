/** #670 — renderScriptArgs: the typed, strict, unescaped rendering of a script call's args (cor:agt:010:04 rule 3). */
import { describe, it, expect } from 'vitest';
import { renderScriptArgs, ScriptVariableMissingError } from './scriptArgs.js';

describe('renderScriptArgs', () => {
  const view = { n: 7, who: 'Ada', obj: { k: 'v', deep: { x: 1 } }, flag: false, list: [1, 2] };

  it('keeps the type of an argument that is exactly one placeholder', () => {
    expect(renderScriptArgs({ a: '{{n}}', b: '{{obj}}', c: '{{list}}' }, view)).toEqual({ a: 7, b: view.obj, c: [1, 2] });
  });
  it('interpolates inside a larger string, JSON-encoding non-strings, without HTML escaping', () => {
    expect(renderScriptArgs({ a: 'Hi {{who}} <b>#{{n}}</b> & {{obj.k}}' }, view)).toEqual({ a: 'Hi Ada <b>#7</b> & v' });
    expect(renderScriptArgs({ a: 'o={{obj.deep}}' }, view)).toEqual({ a: 'o={"x":1}' });
  });
  it('recurses into nested objects and arrays and leaves non-strings alone', () => {
    expect(renderScriptArgs({ o: { p: ['{{who}}', 3, null, true] } }, view)).toEqual({ o: { p: ['Ada', 3, null, true] } });
  });
  it('walks dotted paths on own properties only', () => {
    expect(renderScriptArgs({ a: '{{obj.deep.x}}' }, view)).toEqual({ a: 1 });
    expect(() => renderScriptArgs({ a: '{{who.length}}' }, view)).toThrow(ScriptVariableMissingError);
    expect(() => renderScriptArgs({ a: '{{obj.constructor}}' }, view)).toThrow(ScriptVariableMissingError);
    expect(() => renderScriptArgs({ a: '{{__proto__}}' }, view)).toThrow(ScriptVariableMissingError);
  });
  it('refuses a missing, null or empty variable, naming it, even inside a nested value', () => {
    for (const bad of [{ gone: '{{nope}}' }, { nested: { v: 'x {{nope}}' } }, { l: ['{{nope}}'] }]) {
      expect(() => renderScriptArgs(bad, view)).toThrow(/nope/);
    }
    expect(() => renderScriptArgs({ a: '{{e}}' }, { e: '' })).toThrow(ScriptVariableMissingError);
    expect(() => renderScriptArgs({ a: '{{e}}' }, { e: null })).toThrow(ScriptVariableMissingError);
    // a legitimate false/0 is a value
    expect(renderScriptArgs({ a: '{{flag}}', z: '{{zero}}' }, { flag: false, zero: 0 })).toEqual({ a: false, z: 0 });
  });
});
