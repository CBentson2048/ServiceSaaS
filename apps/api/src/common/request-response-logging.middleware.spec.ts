import type { NextFunction, Request, Response } from 'express';
import { RequestResponseLoggingMiddleware } from './request-response-logging.middleware';

interface LoggedLine {
  event: string;
  [key: string]: unknown;
}

function makeMiddleware(): { middleware: RequestResponseLoggingMiddleware; lines: () => LoggedLine[] } {
  const middleware = new RequestResponseLoggingMiddleware();
  const log = jest.fn();
  (middleware as unknown as { logger: { log: jest.Mock } }).logger = { log };
  return {
    middleware,
    lines: () => log.mock.calls.map((call) => JSON.parse(call[0] as string) as LoggedLine),
  };
}

function makeRequest(url: string, body: unknown): Request {
  return {
    method: 'POST',
    originalUrl: url,
    query: { secretQuestion: 'is-this-logged' },
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

describe('RequestResponseLoggingMiddleware', () => {
  it('suppresses request and response bodies on /api/zac routes', () => {
    const { middleware, lines } = makeMiddleware();
    const { response, finish } = makeResponse();
    const next: NextFunction = jest.fn();

    middleware.use(makeRequest('/api/zac/ask', { question: 'private prompt text' }), response, next);
    response.send(JSON.stringify({ answer: 'private answer text' }));
    finish();

    const [requestLine, responseLine] = lines();
    expect(requestLine.body).toBe('[suppressed]');
    expect(requestLine.query).toBe('[suppressed]');
    expect(responseLine.body).toBe('[suppressed]');
    expect(JSON.stringify(lines())).not.toContain('private prompt text');
    expect(JSON.stringify(lines())).not.toContain('private answer text');
    expect(next).toHaveBeenCalled();
  });

  it('suppresses /api/zac routes with query strings and nested paths', () => {
    const { middleware, lines } = makeMiddleware();
    const { response, finish } = makeResponse();

    middleware.use(makeRequest('/api/zac/health?probe=1', {}), response, jest.fn());
    finish();

    expect(lines()[0].body).toBe('[suppressed]');
  });

  it('leaves other routes logged with key-based redaction intact', () => {
    const { middleware, lines } = makeMiddleware();
    const { response, finish } = makeResponse();

    middleware.use(
      makeRequest('/api/kpi/stylists', { period: 'week', password: 'hunter2' }),
      response,
      jest.fn(),
    );
    response.send(JSON.stringify({ ok: true }));
    finish();

    const [requestLine, responseLine] = lines();
    expect(requestLine.body).toEqual({ period: 'week', password: '[redacted]' });
    expect(responseLine.body).toEqual({ ok: true });
  });

  it('does not treat a zac-prefixed but different route as a ZAC route', () => {
    const { middleware, lines } = makeMiddleware();
    const { response, finish } = makeResponse();

    middleware.use(makeRequest('/api/zackary', { fine: true }), response, jest.fn());
    finish();

    expect(lines()[0].body).toEqual({ fine: true });
  });
});
