import { loginRedirectTarget } from './loginRedirect';

describe('loginRedirectTarget', () => {
  it('returns the whole bounced address, so a shared report link keeps its filters', () => {
    expect(
      loginRedirectTarget({ from: { pathname: '/reports/money', search: '?preset=last_week&locations=a,b', hash: '#top' } }),
    ).toBe('/reports/money?preset=last_week&locations=a,b#top');
  });

  it('returns only the pathname for any other page, so its query never reaches the next person to sign in', () => {
    expect(loginRedirectTarget({ from: { pathname: '/crm', search: '?q=Jane%20Smith%2007700900123', hash: '#x' } })).toBe('/crm');
    expect(loginRedirectTarget({ from: { pathname: '/bookings/new', search: '?staffName=Alex&startAt=2026-09-14T10:00' } })).toBe('/bookings/new');
    expect(loginRedirectTarget({ from: { pathname: '/reportsfoo', search: '?a=1' } })).toBe('/reportsfoo');
  });

  it('returns just the path when there is no query or hash', () => {
    expect(loginRedirectTarget({ from: { pathname: '/dashboard', search: '', hash: '' } })).toBe('/dashboard');
    expect(loginRedirectTarget({ from: { pathname: '/dashboard' } })).toBe('/dashboard');
  });

  it('falls back (undefined) when nothing usable was recorded', () => {
    for (const state of [null, undefined, 'x', {}, { from: null }, { from: '/dashboard' }, { from: { search: '?a=1' } }]) {
      expect([state, loginRedirectTarget(state)]).toEqual([state, undefined]);
    }
  });

  it('accepts only an in-app absolute path', () => {
    for (const pathname of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/ /evil.example', 'https://evil.example/x', 'reports/money', '']) {
      expect([pathname, loginRedirectTarget({ from: { pathname } })]).toEqual([pathname, undefined]);
    }
  });

  it('ignores a malformed query or hash rather than splicing it into the path', () => {
    expect(loginRedirectTarget({ from: { pathname: '/reports/money', search: 'preset=x', hash: 'frag' } })).toBe('/reports/money');
  });
});
