import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Optional `Reply-To` address — useful for inviter emails so the invitee can reply to the owner. */
  replyTo?: string;
  /** Free-form tag list forwarded to Resend for analytics/grouping. */
  tags?: Array<{ name: string; value: string }>;
}

export interface SendEmailResult {
  delivered: boolean;
  /** Provider message id (Resend) when delivered. */
  id?: string;
  /** Set when delivery failed or was skipped (no API key, send error). */
  error?: string;
  /** True when the API key is missing and we logged instead of sending. */
  skipped?: boolean;
}

/**
 * Thin wrapper around the Resend SDK. The service is intentionally fail-soft:
 * email is treated as a best-effort side effect of business actions (invitations,
 * notifications). Callers always receive a `SendEmailResult` and never see
 * exceptions — the assumption is that the underlying domain action (e.g. creating
 * a staff invitation row) has already succeeded and the inviteUrl is still
 * available to the owner via the API response, even if delivery falls through.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: Resend | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');
    this.from = resolveResendFromAddress(config);
    this.client = apiKey ? new Resend(apiKey) : null;

    if (!this.client) {
      this.logger.warn(
        'RESEND_API_KEY is not set. EmailService is in log-only mode; outgoing emails will not be delivered.',
      );
    }
  }

  get isEnabled(): boolean {
    return this.client !== null;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.client) {
      this.logger.log(
        `[email:skipped] to=${input.to} subject=${JSON.stringify(input.subject)} (RESEND_API_KEY unset)`,
      );
      return { delivered: false, skipped: true };
    }

    try {
      const { data, error } = await this.client.emails.send({
        from: this.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        replyTo: input.replyTo,
        tags: input.tags,
      });

      if (error) {
        const message = (error as { message?: string }).message ?? JSON.stringify(error);
        this.logger.error(`Resend send failed for ${input.to}: ${message}`);
        return { delivered: false, error: message };
      }

      return { delivered: true, id: data?.id };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`Resend threw while sending to ${input.to}: ${message}`);
      return { delivered: false, error: message };
    }
  }
}

/**
 * Resolve the `from` address used when calling Resend.
 *
 * Resolution order:
 *   1. RESEND_FROM_EMAIL (preferred) — may already be RFC 5322 formatted
 *      (e.g. `Sheer <noreply@yourdomain.com>`).
 *   2. RESEND_FROM (alias) — typically a bare email; we wrap it as
 *      `Sheer <addr>` so Resend accepts it.
 *   3. Fallback to the Resend test sender, which can only deliver to the
 *      Resend account owner's verified address.
 */
function resolveResendFromAddress(config: ConfigService): string {
  const raw = (config.get<string>('RESEND_FROM_EMAIL') ?? config.get<string>('RESEND_FROM'))?.trim();
  if (!raw) {
    return 'Sheer <onboarding@resend.dev>';
  }
  if (/^[^\s<]+@[^\s>]+$/.test(raw)) {
    return `Sheer <${raw}>`;
  }
  return raw;
}
