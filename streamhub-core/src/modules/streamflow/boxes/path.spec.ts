/**
 * Unit spec — safe bag path get/set + template resolution (Streamflow).
 * Locks down dotted/array access, the prototype-pollution guard, full-template
 * (typed) vs inline (string) resolution and deep object/array resolution.
 */
import { getPath, resolveValue, resolveString, setPath } from './path';

describe('getPath', () => {
  const bag = { trigger: { room: 'gate', box: [{ n: 1 }, { n: 2 }] }, vars: {} };
  it('reads nested + array paths', () => {
    expect(getPath(bag, 'trigger.room')).toBe('gate');
    expect(getPath(bag, 'trigger.box.1.n')).toBe(2);
  });
  it('returns undefined for missing/unsafe segments', () => {
    expect(getPath(bag, 'trigger.nope')).toBeUndefined();
    expect(getPath(bag, 'trigger.__proto__.polluted')).toBeUndefined();
    expect(getPath(bag, 'constructor.prototype')).toBeUndefined();
  });
});

describe('setPath', () => {
  it('sets nested paths, creating intermediates', () => {
    const root: Record<string, unknown> = {};
    setPath(root, 'vars.a.b', 7);
    expect(root).toEqual({ vars: { a: { b: 7 } } });
  });
  it('refuses prototype pollution', () => {
    const root: Record<string, unknown> = {};
    setPath(root, '__proto__.polluted', true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('resolveValue', () => {
  const bag = { trigger: { plate: 'ABC', conf: 0.9 }, snap: { url: 'http://x/y.jpg' } };
  it('returns the typed value for a full template', () => {
    expect(resolveValue('{{trigger.conf}}', bag)).toBe(0.9);
    expect(resolveValue('{{ snap.url }}', bag)).toBe('http://x/y.jpg');
  });
  it('interpolates inline templates as strings', () => {
    expect(resolveValue('plate {{trigger.plate}} seen', bag)).toBe('plate ABC seen');
    expect(resolveString('{{trigger.missing}}', bag)).toBe('');
  });
  it('deep-resolves objects and arrays', () => {
    expect(
      resolveValue({ p: '{{trigger.plate}}', arr: ['{{trigger.conf}}'] }, bag),
    ).toEqual({ p: 'ABC', arr: [0.9] });
  });
  it('leaves non-template values untouched', () => {
    expect(resolveValue(42, bag)).toBe(42);
    expect(resolveValue('static', bag)).toBe('static');
  });
});
