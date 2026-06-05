import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Resend signs webhooks with Svix. Verification (see https://docs.svix.com/receiving/verifying-payloads):
 *   signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   expected      = base64( HMAC-SHA256( base64decode(secret without 'whsec_'), signedContent ) )
 * The `svix-signature` header is a space-separated list of `v{version},{base64}` entries — the
 * request is valid if any entry matches. The timestamp is also checked against a tolerance window to
 * reject replays.
 *
 * Pure, framework-free, unit-testable. Requires the EXACT raw request body (NestFactory `rawBody`).
 */

export interface SvixHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(
  secret: string | undefined,
  headers: SvixHeaders,
  rawBody: string,
  now: number = Date.now(),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;

  // Reject stale / future-dated (replayed) timestamps.
  const ts = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(now / 1000) - ts) > toleranceSeconds) return false;

  const key = secretKey(secret);
  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');

  for (const part of headers.signature.split(' ')) {
    const commaIndex = part.indexOf(',');
    if (commaIndex < 0) continue;
    const value = part.slice(commaIndex + 1);
    if (value && constantTimeEqual(expected, value)) return true;
  }
  return false;
}

/** Svix secrets are `whsec_<base64>`; the HMAC key is the decoded base64 portion. */
function secretKey(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(raw, 'base64');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
