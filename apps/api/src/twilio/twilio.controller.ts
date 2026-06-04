import { Controller, ForbiddenException, Header, HttpCode, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { TwilioCallbackService } from './twilio-callback.service';
import { reconstructRequestUrl } from './twilio-signature';

/**
 * Twilio WhatsApp webhooks (mounted under the global `api` prefix):
 *   POST /api/twilio/messaging/status   — delivery-status callbacks (queued→sent→delivered/failed/…)
 *   POST /api/twilio/messaging/inbound  — inbound WhatsApp replies (minimal two-way support)
 *
 * Public endpoints (no bearer auth) authenticated by the `X-Twilio-Signature` HMAC instead, so a
 * forged request cannot mutate the message log. Bodies are application/x-www-form-urlencoded.
 */
@Controller('twilio/messaging')
export class TwilioController {
  constructor(
    private readonly callbacks: TwilioCallbackService,
    private readonly config: ConfigService,
  ) {}

  @Post('status')
  @HttpCode(204)
  async status(@Req() req: Request): Promise<void> {
    const params = asParams(req.body);
    this.assertValidSignature(req, params, this.config.get<string>('TWILIO_STATUS_CALLBACK_URL'));
    await this.callbacks.handleStatusCallback(params);
  }

  @Post('inbound')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async inbound(@Req() req: Request): Promise<string> {
    const params = asParams(req.body);
    this.assertValidSignature(req, params, this.config.get<string>('TWILIO_INBOUND_CALLBACK_URL'));
    await this.callbacks.handleInboundMessage(params);
    // Empty TwiML — acknowledge without auto-replying.
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }

  private assertValidSignature(req: Request, params: Record<string, string>, configuredUrl?: string): void {
    const signature = headerValue(req.headers['x-twilio-signature']);
    const reconstructed = reconstructRequestUrl(req.headers as Record<string, unknown>, req.originalUrl);
    const ok = this.callbacks.verifySignature(signature, [reconstructed, configuredUrl?.trim() || undefined], params);
    if (!ok) {
      throw new ForbiddenException('Invalid Twilio signature');
    }
  }
}

function asParams(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
      else if (value != null) out[key] = String(value);
    }
  }
  return out;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
