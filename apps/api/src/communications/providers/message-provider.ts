import type { DeliveryChannel } from '../channel-policy';

/**
 * Channel-agnostic outbound message. Carries the superset of fields every
 * channel might need; each provider adapter reads only what applies to it (e.g.
 * WhatsApp uses `templateId`/`templateVariables`, email uses `subject`/`html`).
 * This is the seam that keeps provider-specific shapes out of the dispatcher.
 */
export interface OutboundMessage {
  /** Recipient address in the channel's native form (E.164 phone, email, …). */
  to: string;
  /** Rendered plain body (SMS/WhatsApp freeform fallback, email text alt). */
  body?: string;
  subject?: string;
  html?: string;
  text?: string;
  /** Approved template identifier (e.g. Twilio Content SID) when required. */
  templateId?: string;
  /** Positional/keyed template variables for `templateId`. */
  templateVariables?: Record<string, string>;
  /** Public URL the provider posts delivery-status callbacks to. */
  statusCallbackUrl?: string;
  /** Free-form analytics tags forwarded to providers that support them. */
  tags?: Array<{ name: string; value: string }>;
}

/**
 * Normalised result of a send attempt. `accepted` means the provider took the
 * message for delivery — NOT proof of delivery; the real outcome arrives later
 * via the provider's status webhook.
 */
export interface ProviderSendResult {
  accepted: boolean;
  providerMessageId?: string;
  providerStatus?: string;
  error?: string;
  /** True when the provider is unconfigured and the send was logged, not sent. */
  skipped?: boolean;
}

/**
 * Internal provider abstraction. Delivery is swappable per channel without
 * touching the dispatcher/core: register a different {@link MessageProvider}
 * implementation for a channel and everything else keeps working. Adapters are
 * fail-soft — `send` never throws; failures come back on {@link ProviderSendResult}.
 */
export interface MessageProvider {
  /** The channel this provider delivers on. */
  readonly channel: DeliveryChannel;
  /** Stable provider name recorded on `comms.message_logs.provider` (e.g. 'twilio'). */
  readonly providerName: string;
  /** False when credentials are absent (log-only mode). */
  readonly isEnabled: boolean;
  send(message: OutboundMessage): Promise<ProviderSendResult>;
}
