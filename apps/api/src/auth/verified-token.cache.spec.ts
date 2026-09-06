import type { AuthUser } from '@sheer/domain';
import { VerifiedTokenCache } from './verified-token.cache';

const user = (id: string): AuthUser => ({ id }) as unknown as AuthUser;

describe('VerifiedTokenCache', () => {
  it('returns a verified user inside the window and re-verifies after it', () => {
    const cache = new VerifiedTokenCache(30_000);
    cache.set('token-a', user('u1'), 1_000);

    expect(cache.get('token-a', 5_000)?.id).toBe('u1');
    expect(cache.get('token-a', 30_999)?.id).toBe('u1');
    // At the boundary the entry is gone: an authorisation decision is never
    // served past its window.
    expect(cache.get('token-a', 31_000)).toBeNull();
  });

  it('never serves one token from another token entry', () => {
    const cache = new VerifiedTokenCache();
    cache.set('token-a', user('u1'));
    expect(cache.get('token-b')).toBeNull();
  });

  it('drops a token the moment it is invalidated, whatever the window says', () => {
    const cache = new VerifiedTokenCache(30_000);
    cache.set('token-a', user('u1'), 1_000);
    cache.invalidate('token-a');
    // This is what makes sign-out immediate rather than eventually-consistent.
    expect(cache.get('token-a', 2_000)).toBeNull();
  });

  it('stays bounded, evicting the oldest entries first', () => {
    const cache = new VerifiedTokenCache(30_000, 3);
    cache.set('t1', user('u1'), 1_000);
    cache.set('t2', user('u2'), 1_000);
    cache.set('t3', user('u3'), 1_000);
    cache.set('t4', user('u4'), 1_000);

    expect(cache.size).toBe(3);
    expect(cache.get('t1', 1_500)).toBeNull();
    expect(cache.get('t4', 1_500)?.id).toBe('u4');
  });

  it('prefers evicting entries that have already expired', () => {
    const cache = new VerifiedTokenCache(10_000, 2);
    cache.set('stale', user('u1'), 0);
    cache.set('fresh', user('u2'), 9_000);
    // 'stale' expired at 10_000; adding at 11_000 must reclaim it and keep the
    // live entry rather than evicting by age alone.
    cache.set('newest', user('u3'), 11_000);

    expect(cache.get('stale', 11_000)).toBeNull();
    expect(cache.get('fresh', 11_000)?.id).toBe('u2');
    expect(cache.get('newest', 11_000)?.id).toBe('u3');
  });

  it('does not keep the raw bearer token as its key', () => {
    const cache = new VerifiedTokenCache();
    cache.set('super-secret-token', user('u1'));
    expect(JSON.stringify(cache)).not.toContain('super-secret-token');
  });
});
