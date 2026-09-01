import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Expo push transport.
 *
 * WHY EXPO AND NOT APNs/FCM DIRECTLY. apps/sheer-app is an Expo app built through
 * EAS (apps/sheer-app/app.json, eas.json), so Apple and Google credentials are
 * already held and rotated by EAS. Talking to exp.host means this service needs no
 * .p8 key, no service-account JSON and no per-platform payload branching, and the
 * same call reaches iOS and Android. Going direct would mean managing two sets of
 * production credentials for no behavioural gain at pilot scale.
 *
 * SCOPE. Send only. Expo's receipts endpoint (which reports what the OS did with a
 * push minutes later) is deliberately not polled here — acceptance for this ticket
 * is that push is ATTEMPTED where supported and degrades safely, and receipt
 * reconciliation is Week 10 polish. What we do act on immediately is the per-ticket
 * error Expo returns synchronously, because `DeviceNotRegistered` is the one signal
 * that must disable a dead token rather than be retried forever.
 */

/** Expo accepts at most 100 messages per request. */
export const EXPO_PUSH_CHUNK_SIZE = 100;

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushMessage {
  /** Delivery address. Never logged. */
  token: string;
  title: string;
  body: string;
  /** Routing context the app reads on tap. Must carry no sensitive content. */
  data: Record<string, string>;
}

/**
 * Outcome of ONE message. `retryable` separates a provider wobble (retry later)
 * from a permanently dead address (stop, and disable the device).
 */
export interface ExpoPushResult {
  ok: boolean;
  /** Expo ticket id, kept for tracing in the provider dashboard. */
  receiptId?: string;
  /** Expo error code, e.g. DeviceNotRegistered / MessageTooBig / MessageRateExceeded. */
  errorCode?: string;
  error?: string;
  retryable: boolean;
  /** True only for DeviceNotRegistered: the token is dead and must be retired. */
  deviceUnregistered: boolean;
}

interface ExpoTicket {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** Expo error codes that will never succeed on a retry. */
const PERMANENT_ERRORS = new Set([
  'DeviceNotRegistered',
  'InvalidCredentials',
  'MessageTooBig',
  'MismatchSenderId',
]);

@Injectable()
export class ExpoPushProvider {
  private readonly logger = new Logger(ExpoPushProvider.name);
  private readonly accessToken?: string;
  private readonly timeoutMs: number;

  /**
   * False when EXPO_PUSH_ENABLED=false. The dispatcher then never runs, which is
   * the supported way to operate an environment with no push at all: the in-app
   * notification still works, so the product degrades rather than breaks. Defaults
   * to enabled so a deployed environment does not silently swallow pushes.
   */
  readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = (config.get<string>('EXPO_PUSH_ENABLED') ?? 'true').toLowerCase() !== 'false';
    // Only required once an Expo project enables "enhanced security for push
    // notifications"; unset is the normal case and is not an error.
    this.accessToken = config.get<string>('EXPO_ACCESS_TOKEN') || undefined;
    const raw = Number.parseInt(String(config.get('EXPO_PUSH_TIMEOUT_MS') ?? ''), 10);
    this.timeoutMs = Number.isNaN(raw) ? 10_000 : Math.min(60_000, Math.max(1_000, raw));
  }

  /**
   * Send one chunk (<= {@link EXPO_PUSH_CHUNK_SIZE}). Returns one result per input
   * message, in the same order.
   *
   * NEVER THROWS. A transport failure resolves to a retryable failure for every
   * message in the chunk, because the caller is a queue worker whose job is to
   * record an outcome, not to propagate an exception into an unrelated request.
   */
  async send(messages: ExpoPushMessage[]): Promise<ExpoPushResult[]> {
    if (messages.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(EXPO_PUSH_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // Expo compresses large payloads; asking for identity keeps parsing simple.
          'Accept-Encoding': 'identity',
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(
          messages.map((message) => ({
            to: message.token,
            title: message.title,
            body: message.body,
            data: message.data,
            sound: 'default',
            // Arrival is time-critical for the person about to start the service, so
            // it must wake the device rather than wait for the next OS batch.
            priority: 'high',
            // ONE channel for every notification type, not one per type. The
            // enqueue path serves every producer, so a type-specific channel id
            // would put a future low-stock alert into a channel labelled "Client
            // arrivals". Per-type channels (so a stylist can silence stock but
            // keep arrivals) are a preferences feature, and that is Week 10.
            channelId: 'alerts',
          })),
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        // 429 and 5xx are transient; 4xx generally means we sent something wrong.
        const retryable = response.status === 429 || response.status >= 500;
        return this.uniform(messages.length, {
          ok: false,
          error: `expo http ${response.status}`,
          retryable,
          deviceUnregistered: false,
        });
      }

      const payload = (await response.json()) as { data?: ExpoTicket[]; errors?: unknown };
      const tickets = Array.isArray(payload?.data) ? payload.data : [];
      if (tickets.length !== messages.length) {
        // Shape we do not understand. Retry rather than silently drop a push.
        this.logger.warn(
          `expo returned ${tickets.length} tickets for ${messages.length} messages; retrying chunk`,
        );
        return this.uniform(messages.length, {
          ok: false,
          error: 'expo ticket count mismatch',
          retryable: true,
          deviceUnregistered: false,
        });
      }

      return tickets.map((ticket) => this.toResult(ticket));
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      return this.uniform(messages.length, {
        ok: false,
        error: aborted ? 'expo request timed out' : `expo request failed: ${(err as Error)?.message}`,
        retryable: true,
        deviceUnregistered: false,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private toResult(ticket: ExpoTicket): ExpoPushResult {
    if (ticket?.status === 'ok') {
      return { ok: true, receiptId: ticket.id, retryable: false, deviceUnregistered: false };
    }
    const errorCode = ticket?.details?.error;
    const permanent = errorCode ? PERMANENT_ERRORS.has(errorCode) : false;
    return {
      ok: false,
      errorCode,
      // ticket.message is Expo's own wording; it describes the token's state, never
      // the token itself, so it is safe to persist and log.
      error: ticket?.message ?? errorCode ?? 'expo rejected the message',
      retryable: !permanent,
      deviceUnregistered: errorCode === 'DeviceNotRegistered',
    };
  }

  private uniform(count: number, result: ExpoPushResult): ExpoPushResult[] {
    return Array.from({ length: count }, () => ({ ...result }));
  }
}
