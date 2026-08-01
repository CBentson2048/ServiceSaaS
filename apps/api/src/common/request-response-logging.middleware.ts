import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'apikey',
  'api_key',
]);

/**
 * Route prefixes whose request/response bodies (and query strings) must never reach
 * the logs. Only safe operational metadata (method, url, status, duration) is logged
 * for these routes.
 *
 * - `/api/zac`: prompts/answers carry free-text user content, client references and
 *   financial figures. Key-name redaction is not enough — the payload shape is
 *   model-driven and cannot be enumerated.
 * - `/api/payroll`: every response carries wage, commission and settlement figures
 *   for named staff. These are the most sensitive values in the product and must
 *   not be retrievable from Railway logs by anyone with log access, regardless of
 *   whether they hold any payroll permission.
 */
const BODY_SUPPRESSED_ROUTE_PREFIXES = ['/api/zac', '/api/payroll'];

@Injectable()
export class RequestResponseLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestResponseLoggingMiddleware.name);

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = Date.now();
    const requestId = this.getRequestId(request);
    const suppressBodies = this.isBodySuppressedRoute(request.originalUrl);
    const originalSend = response.send.bind(response);
    let responseBody: unknown;

    response.send = ((body?: unknown): Response => {
      responseBody = body;
      return originalSend(body);
    }) as Response['send'];

    this.logger.log(
      this.formatLog('request', {
        requestId,
        method: request.method,
        url: request.originalUrl,
        query: suppressBodies ? '[suppressed]' : this.redact(request.query),
        body: suppressBodies ? '[suppressed]' : this.redact(request.body),
        ip: request.ip,
        userAgent: request.get('user-agent'),
      }),
    );

    response.on('finish', () => {
      this.logger.log(
        this.formatLog('response', {
          requestId,
          method: request.method,
          url: request.originalUrl,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
          body: suppressBodies ? '[suppressed]' : this.redact(this.parseResponseBody(responseBody)),
        }),
      );
    });

    next();
  }

  private isBodySuppressedRoute(url: string): boolean {
    const path = url.split('?')[0];
    return BODY_SUPPRESSED_ROUTE_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }

  private getRequestId(request: Request): string {
    const requestId = request.get('x-request-id');
    return requestId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private parseResponseBody(body: unknown): unknown {
    if (Buffer.isBuffer(body)) {
      return this.parseJsonString(body.toString('utf8'));
    }

    if (typeof body === 'string') {
      return this.parseJsonString(body);
    }

    return body;
  }

  private parseJsonString(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private redact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redact(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? '[redacted]' : this.redact(nestedValue),
      ]),
    );
  }

  private formatLog(event: 'request' | 'response', payload: Record<string, unknown>): string {
    return JSON.stringify({ event, ...payload });
  }
}
