import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

/** Credentials. Logging these would be an account compromise, not just a leak. */
const CREDENTIAL_KEYS = [
  'authorization',
  'cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'apikey',
  'api_key',
  'secret',
  'pin',
  'signature',
];

/**
 * Personal data. Salon payloads carry client and staff identities throughout —
 * and `notes`/`bio` routinely hold health information (allergies, pregnancy,
 * treatment), which is special-category data under UK GDPR. Deliberately broad:
 * this list only applies when body logging has been switched on explicitly, so
 * over-redacting a `serviceName` costs nothing and under-redacting costs a lot.
 */
const PERSONAL_DATA_KEYS = [
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'name',
  'staffname',
  'stylistname',
  'clientname',
  'email',
  'phone',
  'phonenumber',
  'mobile',
  'whatsapp',
  'address',
  'addressline1',
  'addressline2',
  'postcode',
  'city',
  'dateofbirth',
  'dob',
  'notes',
  'note',
  'comment',
  'comments',
  'bio',
  'message',
  'content',
  'leavenotes',
  'avatarurl',
];

const REDACTED_KEYS = new Set([...CREDENTIAL_KEYS, ...PERSONAL_DATA_KEYS]);

/**
 * Routes whose bodies are NEVER logged, whatever the configuration says.
 *
 * - `/api/zac`: prompts and answers are free-text user content whose shape is
 *   model-driven and cannot be enumerated for redaction.
 * - `/api/payroll`: wage, commission and settlement figures for named staff —
 *   the most sensitive values in the product.
 */
const ALWAYS_SUPPRESSED_ROUTE_PREFIXES = ['/api/zac', '/api/payroll'];

/**
 * Logs one line per request and one per response.
 *
 * Operational metadata (method, url, status, duration, request id) is always
 * logged; it is what actually drives debugging and carries no personal data.
 *
 * Request/response BODIES and query strings are suppressed by default, because
 * ordinary QLOOQO payloads carry client and staff personal data — names, email
 * addresses, phone numbers and free-text notes — and application logs have a
 * different access model and retention period from the database, with no route
 * into subject-access or erasure processes.
 *
 * Set `LOG_HTTP_BODIES=true` to include bodies while developing locally. Even
 * then, credential and personal-data keys are redacted, and the routes above
 * stay suppressed. Leave it unset everywhere else.
 */
@Injectable()
export class RequestResponseLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestResponseLoggingMiddleware.name);
  private readonly bodyLoggingEnabled: boolean;

  constructor(config: ConfigService) {
    this.bodyLoggingEnabled = config.get<string>('LOG_HTTP_BODIES') === 'true';
  }

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = Date.now();
    const requestId = this.getRequestId(request);
    const includeBodies = this.shouldIncludeBodies(request.originalUrl);
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
        query: includeBodies ? this.redact(request.query) : '[suppressed]',
        body: includeBodies ? this.redact(request.body) : '[suppressed]',
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
          body: includeBodies ? this.redact(this.parseResponseBody(responseBody)) : '[suppressed]',
        }),
      );
    });

    next();
  }

  private shouldIncludeBodies(url: string): boolean {
    if (!this.bodyLoggingEnabled) return false;
    return !this.isAlwaysSuppressedRoute(url);
  }

  private isAlwaysSuppressedRoute(url: string): boolean {
    const path = url.split('?')[0];
    return ALWAYS_SUPPRESSED_ROUTE_PREFIXES.some(
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
        REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : this.redact(nestedValue),
      ]),
    );
  }

  private formatLog(event: 'request' | 'response', payload: Record<string, unknown>): string {
    return JSON.stringify({ event, ...payload });
  }
}
