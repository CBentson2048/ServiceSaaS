/**
 * ExpoPushProvider — the transport, with `fetch` mocked.
 *
 * These specs pin the one thing the dispatcher relies on: that every provider
 * answer is translated into an explicit {ok, retryable, deviceUnregistered}
 * verdict, and that the transport NEVER throws. A throw here would surface inside
 * a setInterval callback and take the API process down.
 *
 * No test makes a network call.
 */

import type { ConfigService } from '@nestjs/config';
import { ExpoPushProvider, type ExpoPushMessage } from './expo-push.provider';

const message = (token = 'ExponentPushToken[abc]'): ExpoPushMessage => ({
  token,
  title: 'Client arrived',
  body: 'Jane has arrived.',
  data: { notificationId: 'n-1', type: 'client_arrived' },
});

function provider(env: Record<string, string> = {}): ExpoPushProvider {
  const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
  return new ExpoPushProvider(config);
}

function mockFetch(impl: jest.Mock): void {
  (globalThis as { fetch: unknown }).fetch = impl;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('ExpoPushProvider.send', () => {
  it('posts the message and returns the ticket id on success', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }] }),
    });
    mockFetch(fetchMock);

    const results = await provider().send([message()]);

    expect(results).toEqual([
      { ok: true, receiptId: 'ticket-1', retryable: false, deviceUnregistered: false },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    const body = JSON.parse(init.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      to: 'ExponentPushToken[abc]',
      title: 'Client arrived',
      body: 'Jane has arrived.',
      // Arrival is time-critical, so it must wake the device rather than wait for
      // the OS to batch it.
      priority: 'high',
      // One channel for every type: the enqueue path serves every producer, so a
      // type-specific id would mislabel a future low-stock alert.
      channelId: 'alerts',
    });
  });

  it('flags DeviceNotRegistered as permanent and device-unregistered', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              status: 'error',
              message: '"ExponentPushToken[abc]" is not a registered push notification recipient',
              details: { error: 'DeviceNotRegistered' },
            },
          ],
        }),
      }),
    );

    const [result] = await provider().send([message()]);

    expect(result.ok).toBe(false);
    expect(result.deviceUnregistered).toBe(true);
    // Must never be retried: the address is dead until the app re-registers.
    expect(result.retryable).toBe(false);
    expect(result.errorCode).toBe('DeviceNotRegistered');
  });

  it('treats a rate-limit error as retryable', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } }],
        }),
      }),
    );

    const [result] = await provider().send([message()]);

    expect(result.retryable).toBe(true);
    expect(result.deviceUnregistered).toBe(false);
  });

  it('treats MessageTooBig as permanent so it cannot loop', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ status: 'error', message: 'too big', details: { error: 'MessageTooBig' } }],
        }),
      }),
    );

    const [result] = await provider().send([message()]);
    expect(result.retryable).toBe(false);
    expect(result.deviceUnregistered).toBe(false);
  });

  it('treats 5xx as retryable and 4xx as permanent', async () => {
    mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    expect((await provider().send([message()]))[0]).toMatchObject({ ok: false, retryable: true });

    mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }));
    expect((await provider().send([message()]))[0]).toMatchObject({ ok: false, retryable: false });

    // 429 is a 4xx but IS transient — backing off is the correct response.
    mockFetch(jest.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    expect((await provider().send([message()]))[0]).toMatchObject({ ok: false, retryable: true });
  });

  it('returns a retryable failure instead of throwing when the network dies', async () => {
    mockFetch(jest.fn().mockRejectedValue(new Error('ECONNRESET')));

    const results = await provider().send([message()]);

    expect(results[0].ok).toBe(false);
    expect(results[0].retryable).toBe(true);
    expect(results[0].error).toContain('ECONNRESET');
  });

  it('returns a retryable failure on timeout', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    mockFetch(jest.fn().mockRejectedValue(abortError));

    const [result] = await provider({ EXPO_PUSH_TIMEOUT_MS: '1000' }).send([message()]);

    expect(result.retryable).toBe(true);
    expect(result.error).toContain('timed out');
  });

  it('retries the whole chunk when the ticket count does not match', async () => {
    mockFetch(
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ status: 'ok', id: 't1' }] }),
      }),
    );

    // Two messages, one ticket back: a shape we cannot map. Retrying is safer than
    // guessing which message the single ticket belonged to.
    const results = await provider().send([message('tok-a'), message('tok-b')]);

    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.ok && r.retryable)).toBe(true);
  });

  it('sends nothing and calls nothing for an empty batch', async () => {
    const fetchMock = jest.fn();
    mockFetch(fetchMock);

    await expect(provider().send([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits the Authorization header when no access token is configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ status: 'ok', id: 't' }] }),
    });
    mockFetch(fetchMock);

    await provider().send([message()]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();

    mockFetch(fetchMock);
    await provider({ EXPO_ACCESS_TOKEN: 'secret-token' }).send([message()]);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer secret-token');
  });

  it('is disabled by EXPO_PUSH_ENABLED=false', () => {
    expect(provider({ EXPO_PUSH_ENABLED: 'false' }).enabled).toBe(false);
    expect(provider().enabled).toBe(true);
  });
});
