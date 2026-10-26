/**
 * Unit spec — safe condition/switch evaluation (Streamflow logic).
 * No eval: covers each comparison op, AND/OR grouping, numeric coercion,
 * contains/matches, and switch case → port routing (incl. default).
 */
import { evalCondition, evalRule, evalSwitch } from './expr';

describe('evalRule', () => {
  const bag = {
    trigger: { conf: 0.8, plate: 'ABC123', type: 'car', tags: ['vip', 'gate'] },
  };
  it('numeric comparisons coerce strings', () => {
    expect(evalRule({ field: 'trigger.conf', op: 'gt', value: 0.7 }, bag)).toBe(true);
    expect(evalRule({ field: 'trigger.conf', op: 'gt', value: '0.9' }, bag)).toBe(false);
    expect(evalRule({ field: 'trigger.conf', op: 'lte', value: 0.8 }, bag)).toBe(true);
  });
  it('eq/ne with loose coercion', () => {
    expect(evalRule({ field: 'trigger.type', op: 'eq', value: 'car' }, bag)).toBe(true);
    expect(evalRule({ field: 'trigger.type', op: 'ne', value: 'truck' }, bag)).toBe(true);
  });
  it('contains on strings and arrays', () => {
    expect(evalRule({ field: 'trigger.plate', op: 'contains', value: 'ABC' }, bag)).toBe(true);
    expect(evalRule({ field: 'trigger.tags', op: 'contains', value: 'vip' }, bag)).toBe(true);
    expect(evalRule({ field: 'trigger.tags', op: 'not_contains', value: 'no' }, bag)).toBe(true);
  });
  it('matches regex safely (bad pattern → false)', () => {
    expect(evalRule({ field: 'trigger.plate', op: 'matches', value: '^ABC' }, bag)).toBe(true);
    expect(evalRule({ field: 'trigger.plate', op: 'matches', value: '(' }, bag)).toBe(false);
  });
  it('exists / truthy', () => {
    expect(evalRule({ field: 'trigger.plate', op: 'exists' }, bag)).toBe(true);
    expect(evalRule({ field: 'trigger.missing', op: 'not_exists' }, bag)).toBe(true);
    expect(evalRule({ field: 'trigger.conf', op: 'truthy' }, bag)).toBe(true);
  });
});

describe('evalCondition', () => {
  const bag = { trigger: { conf: 0.8, type: 'car' } };
  it('AND (all) requires every rule', () => {
    expect(
      evalCondition(
        {
          match: 'all',
          rules: [
            { field: 'trigger.conf', op: 'gt', value: 0.7 },
            { field: 'trigger.type', op: 'eq', value: 'car' },
          ],
        },
        bag,
      ),
    ).toBe(true);
    expect(
      evalCondition(
        {
          match: 'all',
          rules: [
            { field: 'trigger.conf', op: 'gt', value: 0.7 },
            { field: 'trigger.type', op: 'eq', value: 'truck' },
          ],
        },
        bag,
      ),
    ).toBe(false);
  });
  it('OR (any) needs one', () => {
    expect(
      evalCondition(
        {
          match: 'any',
          rules: [
            { field: 'trigger.conf', op: 'gt', value: 0.99 },
            { field: 'trigger.type', op: 'eq', value: 'car' },
          ],
        },
        bag,
      ),
    ).toBe(true);
  });
  it('empty rules → true', () => {
    expect(evalCondition({ rules: [] }, bag)).toBe(true);
  });
});

describe('evalSwitch', () => {
  const bag = { trigger: { type: 'truck' } };
  it('routes to the matching case port', () => {
    expect(
      evalSwitch(
        {
          field: 'trigger.type',
          cases: [
            { value: 'car', port: 'cars' },
            { value: 'truck', port: 'trucks' },
          ],
        },
        bag,
      ),
    ).toBe('trucks');
  });
  it('falls back to default', () => {
    expect(
      evalSwitch({ field: 'trigger.type', cases: [{ value: 'bike' }], default: 'other' }, bag),
    ).toBe('other');
  });
});
