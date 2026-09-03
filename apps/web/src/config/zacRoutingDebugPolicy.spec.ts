/**
 * The routing inspector's presentation policy: development visible, production
 * hidden unless the deployment or an internal tester says otherwise. A
 * presentation rule only — nothing here gates data or permissions.
 */
import { resolveZacRoutingDebug } from './zacRoutingDebugPolicy';

describe('resolveZacRoutingDebug', () => {
  it('is visible on the dev server and hidden in production by default', () => {
    expect(resolveZacRoutingDebug({ explicit: undefined, isDev: true, override: null })).toBe(true);
    expect(resolveZacRoutingDebug({ explicit: undefined, isDev: false, override: null })).toBe(false);
  });

  it('an explicit deployment value wins in both directions', () => {
    expect(resolveZacRoutingDebug({ explicit: 'true', isDev: false, override: null })).toBe(true);
    expect(resolveZacRoutingDebug({ explicit: 'false', isDev: true, override: 'true' })).toBe(false);
    expect(resolveZacRoutingDebug({ explicit: '1', isDev: false, override: 'false' })).toBe(true);
  });

  it('honours a per-browser override only when the deployment did not decide', () => {
    expect(resolveZacRoutingDebug({ explicit: undefined, isDev: false, override: 'true' })).toBe(true);
    expect(resolveZacRoutingDebug({ explicit: undefined, isDev: true, override: 'false' })).toBe(false);
  });

  it('treats an unrecognised value as unset', () => {
    expect(resolveZacRoutingDebug({ explicit: 'maybe', isDev: false, override: 'yes?' })).toBe(false);
    expect(resolveZacRoutingDebug({ explicit: '', isDev: true, override: null })).toBe(true);
  });
});
