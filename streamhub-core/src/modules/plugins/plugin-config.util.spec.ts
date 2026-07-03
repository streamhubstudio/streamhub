/**
 * Unit specs for plugin config validation/normalization (pure functions).
 */
import {
  PluginConfigError,
  defaultConfig,
  redactSecrets,
  validateConfig,
} from './plugin-config.util';
import { PluginMeta } from './plugin.contract';

const meta: PluginMeta = {
  id: 'demo',
  name: 'Demo',
  description: '',
  category: 'panel',
  ui: 'app-tab',
  configSchema: [
    { key: 'title', type: 'string', label: 'Title', default: 'hello' },
    { key: 'count', type: 'number', label: 'Count', default: 3, min: 0, max: 10 },
    { key: 'flag', type: 'boolean', label: 'Flag', default: false },
    {
      key: 'mode',
      type: 'select',
      label: 'Mode',
      default: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
    { key: 'apiKey', type: 'secret', label: 'API key', default: '', required: true },
  ],
};

describe('validateConfig', () => {
  it('fills defaults for a fully empty input', () => {
    expect(validateConfig(meta, {})).toEqual({
      title: 'hello',
      count: 3,
      flag: false,
      mode: 'a',
      apiKey: '',
    });
  });

  it('defaultConfig equals an empty validate', () => {
    expect(defaultConfig(meta)).toEqual(validateConfig(meta, {}));
  });

  it('coerces string numbers/booleans', () => {
    const out = validateConfig(meta, { count: '7', flag: 'true' });
    expect(out.count).toBe(7);
    expect(out.flag).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(() => validateConfig(meta, { nope: 1 })).toThrow(PluginConfigError);
  });

  it('enforces numeric bounds', () => {
    expect(() => validateConfig(meta, { count: 99 })).toThrow(/<= 10/);
    expect(() => validateConfig(meta, { count: -1 })).toThrow(/>= 0/);
  });

  it('rejects invalid select values', () => {
    expect(() => validateConfig(meta, { mode: 'z' })).toThrow(/one of/);
  });

  it('rejects non-numeric numbers', () => {
    expect(() => validateConfig(meta, { count: 'abc' })).toThrow(/number/);
  });

  it('only enforces required when requireRequired is set', () => {
    expect(() => validateConfig(meta, {}, false)).not.toThrow();
    expect(() => validateConfig(meta, {}, true)).toThrow(/apiKey.*required/);
    expect(() =>
      validateConfig(meta, { apiKey: 'secret' }, true),
    ).not.toThrow();
  });

  it('treats explicit null as "use default"', () => {
    const out = validateConfig(meta, { title: null });
    expect(out.title).toBe('hello');
  });
});

describe('redactSecrets', () => {
  it('masks non-empty secret fields, leaves empties', () => {
    const full = validateConfig(meta, { apiKey: 'topsecret' });
    expect(redactSecrets(meta, full).apiKey).toBe('********');
    const empty = validateConfig(meta, {});
    expect(redactSecrets(meta, empty).apiKey).toBe('');
  });

  it('does not touch non-secret fields', () => {
    const out = redactSecrets(meta, validateConfig(meta, { title: 'x' }));
    expect(out.title).toBe('x');
  });
});
