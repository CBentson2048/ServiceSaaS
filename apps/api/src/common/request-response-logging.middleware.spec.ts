import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { RequestResponseLoggingMiddleware } from './request-response-logging.middleware';

interface LoggedLine {
  event: string;
  [key: string]: unknown;
}

function makeMiddleware(env: Record<string, string | undefined> = {}): {
  middleware: RequestResponseLoggingMiddleware;
  lines: () => LoggedLine[];
  raw: () => string;
} {
  const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
  const middleware = new RequestResponseLoggingMiddleware(config);
  const log = jest.fn();
  (middleware as unknown as { logger: { log: jest.Mock } }).logger = { log };
  const lines = () => log.mock.calls.map((call) => JSON.parse(call[0] as string) as LoggedLine);
  return { middleware, lines, raw: () => JSON.stringify(lines()) };
}

/** Body logging switched on, as a developer would locally. */
const DEV = { LOG_HTTP_BODIES: 'true' };

function makeRequest(url: string, body: unknown, query: unknown = { q: 'sarah' }): Request {
  return {
    method: 'POST',
    originalUrl: url,
    query,
    body,
    ip: '127.0.0.1',
    get: jest.fn().mockReturnValue('jest'),
  } as unknown as Request;
}

function makeResponse(): { response: Response; finish: () => void } {
  const listeners: Record<string, () => void> = {};
  const response = {
    statusCode: 200,
    send: jest.fn(),
    on: jest.fn((event: string, listener: () => void) => {
      listeners[event] = listener;
    }),
  } as unknown as Response;
  return { response, finish: () => listeners.finish() };
}

/** A realistic CRM payload: names, contact details and health notes. */
const CLIENT_PAYLOAD = {
  clients: [
    {
      clientCode: 'CL-0042',
      firstName: 'Sarah',
      lastName: 'Whitfield',
      displayName: 'Sarah Whitfield',
      email: 'sarah.whitfield@gmail.com',
      phone: '+447700900123',
      notes: 'Allergic to PPD. Going through chemo — prefers gentle products.',
    },
  ],
};

function run(
  middleware: RequestResponseLoggingMiddleware,
  url: string,
  requestBody: unknown,
  responseBody?: unknown,
  query?: unknown,
): void {
  const { response, finish } = makeResponse();
  const next: NextFunction = jest.fn();
  middleware.use(makeRequest(url, requestBody, query), response, next);
  if (responseBody !== undefined) response.send(JSON.stringify(responseBody));
  finish();
  expect(next).toHaveBeenCalled();
}

describe('RequestResponseLoggingMiddleware', () => {
  describe('by default (no LOG_HTTP_BODIES)', () => {
    it('suppresses bodies and query strings on ordinary routes', () => {
      const { middleware, lines } = makeMiddleware();

      run(middleware, '/api/crm/clients', { search: 'sarah' }, CLIENT_PAYLOAD);

      const [requestLine, responseLine] = lines();
      expect(requestLine.body).toBe('[suppressed]');
      expect(requestLine.query).toBe('[suppressed]');
      expect(responseLine.body).toBe('[suppressed]');
    });

    it('never leaks client names, contact details or health notes', () => {
      const { middleware, raw } = makeMiddleware();

      run(middleware, '/api/crm/clients', {}, CLIENT_PAYLOAD);

      const logged = raw();
      for (const secret of [
        'Sarah',
        'Whitfield',
        'sarah.whitfield@gmail.com',
        '+447700900123',
        'chemo',
        'Allergic',
      ]) {
        expect(logged).not.toContain(secret);
      }
    });

    it.each([
      '/api/staff',
      '/api/profile',
      '/api/auth/login',
      '/api/public-booking/clients',
      '/api/lab-appointments/123',
      '/api/communications/send',
      '/api/staff-booking/slots',
      '/api/account',
      '/api/retail-sales',
      '/api/salon-directory',
    ])('suppresses bodies on %s', (url) => {
      const { middleware, lines } = makeMiddleware();

      run(middleware, url, CLIENT_PAYLOAD, CLIENT_PAYLOAD);

      expect(lines()[0].body).toBe('[suppressed]');
      expect(lines()[1].body).toBe('[suppressed]');
    });

    it('still logs the operational metadata needed for debugging', () => {
      const { middleware, lines } = makeMiddleware();

      run(middleware, '/api/crm/clients?q=sarah', {}, CLIENT_PAYLOAD);

      const [requestLine, responseLine] = lines();
      expect(requestLine).toMatchObject({
        event: 'request',
        method: 'POST',
        url: '/api/crm/clients?q=sarah',
        ip: '127.0.0.1',
      });
      expect(requestLine.requestId).toBeTruthy();
      expect(responseLine).toMatchObject({ event: 'response', statusCode: 200 });
      expect(typeof responseLine.durationMs).toBe('number');
    });
  });

  describe('with LOG_HTTP_BODIES=true (local development)', () => {
    it('logs bodies but redacts personal data', () => {
      const { middleware, lines, raw } = makeMiddleware(DEV);

      run(middleware, '/api/crm/clients', {}, CLIENT_PAYLOAD);

      const responseLine = lines()[1];
      const client = (responseLine.body as { clients: Record<string, unknown>[] }).clients[0];

      // Non-identifying fields survive, so the log is still useful.
      expect(client.clientCode).toBe('CL-0042');
      // Everything identifying does not.
      expect(client.firstName).toBe('[redacted]');
      expect(client.lastName).toBe('[redacted]');
      expect(client.displayName).toBe('[redacted]');
      expect(client.email).toBe('[redacted]');
      expect(client.phone).toBe('[redacted]');
      expect(client.notes).toBe('[redacted]');

      const logged = raw();
      expect(logged).not.toContain('Sarah');
      expect(logged).not.toContain('sarah.whitfield@gmail.com');
      expect(logged).not.toContain('chemo');
    });

    it('still redacts credentials', () => {
      const { middleware, lines } = makeMiddleware(DEV);

      run(
        middleware,
        '/api/auth/login',
        { email: 'owner@salon.co.uk', password: 'hunter2' },
        { session: { access_token: 'eyJ', refresh_token: 'eyJ' } },
      );

      const [requestLine, responseLine] = lines();
      expect(requestLine.body).toEqual({ email: '[redacted]', password: '[redacted]' });
      expect(responseLine.body).toEqual({
        session: { access_token: '[redacted]', refresh_token: '[redacted]' },
      });
    });

    it('redacts personal data nested in arrays and sub-objects', () => {
      const { middleware, raw } = makeMiddleware(DEV);

      run(middleware, '/api/staff', {}, {
        team: [{ profile: { fullName: 'Jane Doe', email: 'jane@x.co' } }],
      });

      expect(raw()).not.toContain('Jane Doe');
      expect(raw()).not.toContain('jane@x.co');
    });
  });

  describe('always-suppressed routes', () => {
    it.each([
      ['/api/zac/ask', 'private prompt text'],
      ['/api/payroll/periods/abc/summaries', 'netPayableCents'],
    ])('keeps %s suppressed even when body logging is enabled', (url, secret) => {
      const { middleware, lines, raw } = makeMiddleware(DEV);

      run(middleware, url, { question: 'private prompt text' }, {
        summaries: [{ staffName: 'Jane Doe', netPayableCents: 68010 }],
      });

      expect(lines()[0].body).toBe('[suppressed]');
      expect(lines()[0].query).toBe('[suppressed]');
      expect(lines()[1].body).toBe('[suppressed]');
      expect(raw()).not.toContain(secret);
    });

    it('matches on path segments, not bare prefixes', () => {
      const { middleware, lines } = makeMiddleware(DEV);

      run(middleware, '/api/zackary', { fine: true }, { ok: true });

      // Not a ZAC route, so normal (redacted) body logging applies.
      expect(lines()[0].body).toEqual({ fine: true });
    });

    it('suppresses the bare route and query-string variants', () => {
      const bare = makeMiddleware(DEV);
      run(bare.middleware, '/api/payroll', {}, { ok: true });
      expect(bare.lines()[0].body).toBe('[suppressed]');

      const queried = makeMiddleware(DEV);
      run(queried.middleware, '/api/zac/health?probe=1', {}, { ok: true });
      expect(queried.lines()[0].body).toBe('[suppressed]');
    });
  });
});
