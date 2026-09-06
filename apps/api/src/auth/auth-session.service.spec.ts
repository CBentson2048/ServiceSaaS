import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@sheer/domain';

/**
 * Session handling on the API side.
 *
 * These are the behaviours that decide whether a signed-in person STAYS signed
 * in, and every one of them was wrong at some point:
 *
 *  - a session-bearing call must not run on a client shared with other users;
 *  - signing out must end THIS session, not every session the person holds;
 *  - an upstream outage must not be reported as "your credentials are invalid",
 *    because every client in this repo deletes the session when it hears that;
 *  - a verified token should not cost a round trip per request.
 */

interface MockAuthClient {
  auth: {
    signInWithPassword: jest.Mock;
    refreshSession: jest.Mock;
    setSession: jest.Mock;
    signOut: jest.Mock;
    getUser: jest.Mock;
    admin: { signOut: jest.Mock };
  };
  schema: jest.Mock;
}

const mockClients: MockAuthClient[] = [];
const mockResponses: {
  signIn?: unknown;
  refresh?: unknown;
  setSession?: unknown;
  getUser?: unknown;
} = {};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => {
    const eq = jest.fn().mockResolvedValue({ error: null });
    const client: MockAuthClient = {
      auth: {
        signInWithPassword: jest.fn(async () => mockResponses.signIn),
        refreshSession: jest.fn(async () => mockResponses.refresh),
        setSession: jest.fn(async () => mockResponses.setSession ?? { data: {}, error: null }),
        signOut: jest.fn(async () => ({ error: null })),
        getUser: jest.fn(async () => mockResponses.getUser),
        admin: { signOut: jest.fn(async () => ({ error: null })) },
      },
      schema: jest.fn(() => ({ from: jest.fn(() => ({ update: jest.fn(() => ({ eq })) })) })),
    };
    mockClients.push(client);
    return client;
  }),
}));

// Imported after the mock so the service picks up the stubbed factory.
// eslint-disable-next-line import/first
import { AuthService, isAuthoritativeRejection } from './auth.service';

const OWNER = { id: 'user-1', roles: ['owner'], primaryRole: 'owner' } as unknown as AuthUser;
const SESSION = { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: 1_800_000_000 };

function makeService(): AuthService {
  const config = {
    getOrThrow: (key: string) => `test-${key}`,
    get: () => undefined,
  } as unknown as ConfigService;
  return new AuthService(config, {} as never);
}

/** Clients the service made for one call, i.e. everything after the two it keeps. */
const throwaways = () => mockClients.slice(2);

describe('AuthService — session handling', () => {
  let service: AuthService;
  let resolveAuthUser: jest.SpyInstance;

  beforeEach(() => {
    mockClients.length = 0;
    delete mockResponses.signIn;
    delete mockResponses.refresh;
    delete mockResponses.setSession;
    delete mockResponses.getUser;
    resolveAuthUser = jest
      .spyOn(AuthService.prototype, 'resolveAuthUser')
      .mockResolvedValue(OWNER);
    service = makeService();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('session-bearing calls are isolated from each other', () => {
    it('signs in on a throwaway client, never the shared one', async () => {
      mockResponses.signIn = { data: { user: { id: 'user-1' }, session: SESSION }, error: null };

      await service.login('owner@example.com', 'password', 'web_dashboard');

      // The shared client keeps no session of its own, so one user's refresh can
      // never pick up — or rotate — another user's tokens.
      expect(mockClients[0].auth.signInWithPassword).not.toHaveBeenCalled();
      expect(throwaways()).toHaveLength(1);
      expect(throwaways()[0].auth.signInWithPassword).toHaveBeenCalledTimes(1);
    });

    it('refreshes on a throwaway client, never the shared one', async () => {
      mockResponses.refresh = { data: { user: { id: 'user-1' }, session: SESSION }, error: null };

      await service.refresh('refresh-1', 'web_dashboard');

      expect(mockClients[0].auth.refreshSession).not.toHaveBeenCalled();
      expect(throwaways()[0].auth.refreshSession).toHaveBeenCalledWith({
        refresh_token: 'refresh-1',
      });
    });

    it('gives a rotated session one more chance rather than signing the caller out', async () => {
      mockResponses.refresh = { data: { user: { id: 'user-1' }, session: SESSION }, error: null };
      resolveAuthUser
        .mockRejectedValueOnce(new Error('PostgREST unreachable'))
        .mockResolvedValueOnce(OWNER);

      // The refresh token was already spent upstream, so giving up here would
      // strand the caller with a dead credential.
      const result = await service.refresh('refresh-1', 'web_dashboard');

      expect(result.session.accessToken).toBe('access-1');
      expect(resolveAuthUser).toHaveBeenCalledTimes(2);
    });
  });

  describe('signing out ends this session only', () => {
    it('revokes with scope local when both tokens are supplied', async () => {
      mockResponses.setSession = { data: { session: SESSION }, error: null };

      await service.logout('access-1', 'refresh-1');

      expect(throwaways()[0].auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('falls back to the admin API with scope local when only an access token is supplied', async () => {
      await service.logout('access-1', undefined);

      expect(mockClients[1].auth.admin.signOut).toHaveBeenCalledWith('access-1', 'local');
    });

    it('still revokes when only a refresh token is supplied', async () => {
      mockResponses.refresh = { data: { user: { id: 'user-1' }, session: SESSION }, error: null };

      await service.logout(undefined, 'refresh-1');

      // Previously this returned 204 having revoked nothing at all.
      expect(throwaways()[0].auth.refreshSession).toHaveBeenCalledWith({
        refresh_token: 'refresh-1',
      });
      expect(throwaways()[0].auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('never reports a sign-out failure to the caller', async () => {
      mockResponses.setSession = { data: {}, error: { status: 500, message: 'upstream' } };
      mockResponses.refresh = { data: {}, error: { status: 500, message: 'upstream' } };
      mockClients[1].auth.admin.signOut.mockRejectedValueOnce(new Error('upstream'));

      await expect(service.logout('access-1', 'refresh-1')).resolves.toBeUndefined();
    });
  });

  describe('an outage is not an expired session', () => {
    it('rejects a token Supabase actually refused', async () => {
      mockResponses.getUser = { data: { user: null }, error: { status: 401, message: 'bad jwt' } };

      await expect(service.verifyAccessToken('access-1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('reports a 5xx as unavailable, so no client deletes a good session', async () => {
      mockResponses.getUser = { data: { user: null }, error: { status: 503, message: 'down' } };

      await expect(service.verifyAccessToken('access-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('reports a rate-limit answer as unavailable', async () => {
      mockResponses.getUser = { data: { user: null }, error: { status: 429, message: 'slow down' } };

      await expect(service.verifyAccessToken('access-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('reports a transport failure with no status as unavailable', async () => {
      mockResponses.getUser = { data: { user: null }, error: { message: 'fetch failed' } };

      await expect(service.verifyAccessToken('access-1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('reports a failed sign-in attempt as unavailable rather than wrong password', async () => {
      mockResponses.signIn = { data: {}, error: { status: 500, message: 'down' } };

      await expect(service.login('owner@example.com', 'password')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('still says "invalid email or password" when Supabase actually says so', async () => {
      mockResponses.signIn = { data: {}, error: { status: 400, message: 'invalid credentials' } };

      await expect(service.login('owner@example.com', 'password')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('verified tokens are not re-verified on every request', () => {
    it('verifies once and serves the rest of the burst from the cache', async () => {
      mockResponses.getUser = { data: { user: { id: 'user-1' } }, error: null };

      await service.verifyAccessToken('access-1');
      await service.verifyAccessToken('access-1');
      await service.verifyAccessToken('access-1');

      expect(mockClients[0].auth.getUser).toHaveBeenCalledTimes(1);
      expect(resolveAuthUser).toHaveBeenCalledTimes(1);
    });

    it('stops trusting a token the moment it is signed out', async () => {
      mockResponses.getUser = { data: { user: { id: 'user-1' } }, error: null };
      await service.verifyAccessToken('access-1');

      await service.logout('access-1', undefined);
      await service.verifyAccessToken('access-1');

      expect(mockClients[0].auth.getUser).toHaveBeenCalledTimes(2);
    });
  });
});

describe('isAuthoritativeRejection', () => {
  it.each([400, 401, 403, 404, 422])('treats %i as Supabase answering', (status) => {
    expect(isAuthoritativeRejection({ status })).toBe(true);
  });

  it.each([408, 429, 500, 502, 503, 504])('treats %i as an outage', (status) => {
    expect(isAuthoritativeRejection({ status })).toBe(false);
  });

  it('treats a status-less transport error as an outage', () => {
    expect(isAuthoritativeRejection(new Error('fetch failed'))).toBe(false);
    expect(isAuthoritativeRejection(null)).toBe(false);
    expect(isAuthoritativeRejection(undefined)).toBe(false);
  });
});
