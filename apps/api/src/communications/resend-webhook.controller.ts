import { Controller, ForbiddenException, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { ResendCallbackService, type ResendWebhookEvent } from './resend-callback.service';
import { verifySvixSignature, type SvixHeaders } from './resend-signature';

/**
 * Resend email delivery webhook (mounted under the global `api` prefix):
 *   POST /api/email/status — delivered / bounced / complained events (Svix-signed)
 *
 * Public endpoint (no bearer auth) authenticated by the Svix `svix-*` HMAC signature instead, so a
 * forged request cannot mutate the message log. Requires the EXACT raw body (NestFactory `rawBody`).
 * When RESEND_WEBHOOK_SECRET is unset the signature never verifies and the endpoint rejects — secure
 * by default (the webhook is simply unused until configured).
 */
@Controller('email')
export class ResendWebhookController {
  constructor(private readonly callbacks: ResendCallbackService) {}

  @Post('status')
  @HttpCode(204)
  async status(@Req() req: RawBodyRequest<Request>): Promise<void> {
    const raw = req.rawBody?.toString('utf8') ?? '';
    const headers: SvixHeaders = {
      id: headerValue(req.headers['svix-id']),
      timestamp: headerValue(req.headers['svix-timestamp']),
      signature: headerValue(req.headers['svix-signature']),
    };
    if (!verifySvixSignature(this.callbacks.webhookSecret, headers, raw)) {
      throw new ForbiddenException('Invalid Resend signature');
    }
    // Body was JSON-parsed by the global parser; reuse it (the signature was verified over rawBody).
    await this.callbacks.handleEvent((req.body ?? {}) as ResendWebhookEvent);
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
