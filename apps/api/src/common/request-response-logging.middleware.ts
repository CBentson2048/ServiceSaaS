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

@Injectable()
export class RequestResponseLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestResponseLoggingMiddleware.name);

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = Date.now();
    const requestId = this.getRequestId(request);
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
        query: this.redact(request.query),
        body: this.redact(request.body),
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
          body: this.redact(this.parseResponseBody(responseBody)),
        }),
      );
    });

    next();
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
