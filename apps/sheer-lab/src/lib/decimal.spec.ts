/**
 * The decimal field must accept a decimal point.
 *
 * These tests exist because two `decimal-pad` fields on the Formula screen were
 * controlled from the parsed number, so typing "1.5" produced 15 — a tenfold
 * error in waste grams and cost per gram, both of which feed the colour charge.
 * The regression is silent by nature (no crash, no warning, a plausible number),
 * so it needs a test rather than a code review to stay fixed.
 */

import { parseDecimal, sanitiseDecimal } from './decimal';

describe('parseDecimal', () => {
  it('keeps a partially typed decimal usable', () => {
    // THE BUG. "1." must parse to 1 so the committed value tracks what is
    // typed, while the field goes on displaying "1." — see DecimalInput.
    expect(parseDecimal('1.')).toBe(1);
    expect(parseDecimal('1.5')).toBe(1.5);
    expect(parseDecimal('0.05')).toBe(0.05);
    expect(parseDecimal('.5')).toBe(0.5);
  });

  it('returns undefined rather than NaN for text that is not yet a number', () => {
    // Storing NaN would poison every downstream total silently.
    for (const text of ['', '   ', '.', 'abc']) {
      expect(parseDecimal(text)).toBeUndefined();
    }
  });

  it('rejects the non-finite results Number() will happily produce', () => {
    expect(parseDecimal('Infinity')).toBeUndefined();
    expect(parseDecimal('-Infinity')).toBeUndefined();
  });

  it('parses plain integers', () => {
    expect(parseDecimal('0')).toBe(0);
    expect(parseDecimal('42')).toBe(42);
  });

  it('treats zero as a real value, not as empty', () => {
    // `0` is falsy; a truthiness check upstream would drop a deliberate zero.
    expect(parseDecimal('0')).toBe(0);
    expect(parseDecimal('0')).not.toBeUndefined();
  });
});

describe('sanitiseDecimal', () => {
  it('drops characters a numeric field cannot mean', () => {
    expect(sanitiseDecimal('12abc3')).toBe('123');
    expect(sanitiseDecimal('1 5')).toBe('15');
    expect(sanitiseDecimal('-4')).toBe('4');
    expect(sanitiseDecimal('£1.50')).toBe('1.50');
  });

  it('keeps only the first separator', () => {
    // decimal-pad will emit a second "." on several keyboards.
    expect(sanitiseDecimal('1.2.3')).toBe('1.23');
    expect(sanitiseDecimal('..5')).toBe('.5');
  });

  it('folds a comma to a dot so a European keyboard still works', () => {
    expect(sanitiseDecimal('1,5')).toBe('1.5');
    expect(sanitiseDecimal('1,5,5')).toBe('1.55');
  });

  it('preserves a trailing separator so it can be typed at all', () => {
    // Stripping it here would be the same bug in a different place: the point
    // would vanish the moment it was pressed.
    expect(sanitiseDecimal('1.')).toBe('1.');
  });

  it('preserves trailing zeros, which carry precision', () => {
    expect(sanitiseDecimal('1.50')).toBe('1.50');
    expect(parseDecimal(sanitiseDecimal('1.50'))).toBe(1.5);
  });

  it('leaves already-clean input untouched', () => {
    for (const text of ['', '0', '12', '1.5', '.5']) {
      expect(sanitiseDecimal(text)).toBe(text);
    }
  });
});

describe('the round trip that was broken', () => {
  /**
   * Replays keystroke-by-keystroke what DecimalInput does, to prove the
   * sequence that used to produce 15 now produces 1.5.
   */
  function type(keys: string): { text: string; committed: number | undefined } {
    let text = '';
    let committed: number | undefined;
    for (const key of keys) {
      // The input reports the whole field, not the single key.
      text = sanitiseDecimal(text + key);
      committed = parseDecimal(text);
    }
    return { text, committed };
  }

  it('types 1.5 as one and a half, not fifteen', () => {
    expect(type('1.5')).toEqual({ text: '1.5', committed: 1.5 });
  });

  it('survives the intermediate state that used to eat the point', () => {
    // After "1." the OLD code committed 1, re-rendered the field as "1", and
    // the following "5" landed in the units column.
    expect(type('1.')).toEqual({ text: '1.', committed: 1 });
  });

  it('handles a leading-zero decimal', () => {
    expect(type('0.05')).toEqual({ text: '0.05', committed: 0.05 });
  });

  it('clears back to undefined rather than zero', () => {
    expect(parseDecimal(sanitiseDecimal(''))).toBeUndefined();
  });
});
