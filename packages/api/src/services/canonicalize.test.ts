import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonicalize.js';

describe('canonicalize', () => {
  it('produces the same string for objects with different key orders', () => {
    const a = {
      z: 1,
      a: 'first',
      nested: {
        beta: true,
        alpha: false,
      },
    };
    const b = {
      nested: {
        alpha: false,
        beta: true,
      },
      a: 'first',
      z: 1,
    };

    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":"first","nested":{"alpha":false,"beta":true},"z":1}');
  });

  it('sorts deeply nested objects recursively', () => {
    const value = {
      outer: {
        c: 3,
        a: 1,
        b: {
          d: 4,
          c: 3,
        },
      },
    };

    expect(canonicalize(value)).toBe('{"outer":{"a":1,"b":{"c":3,"d":4},"c":3}}');
  });

  it('preserves array element order while sorting nested object keys', () => {
    const value = {
      items: [
        { b: 2, a: 1 },
        { d: 4, c: 3 },
      ],
    };

    expect(canonicalize(value)).toBe('{"items":[{"a":1,"b":2},{"c":3,"d":4}]}');
  });
});
