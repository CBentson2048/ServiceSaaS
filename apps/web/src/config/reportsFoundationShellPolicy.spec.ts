import { resolveReportsFoundationShell } from './reportsFoundationShellPolicy';

describe('resolveReportsFoundationShell', () => {
  it('is off when unset', () => {
    expect(resolveReportsFoundationShell(undefined)).toBe(false);
  });

  it('is on only for the exact string "true"', () => {
    expect(resolveReportsFoundationShell('true')).toBe(true);
    for (const value of ['', 'TRUE', 'True', '1', 'on', 'yes', ' true', 'true ']) {
      expect([value, resolveReportsFoundationShell(value)]).toEqual([value, false]);
    }
  });
});
