import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio request-signature validation (X-Twilio-Signature).
 *
 * Twilio computes the signature as:
 *   base64( HMAC-SHA1( authToken, fullUrl + concat(sortedParamKeys.map(k => k + value(k))) ) )
 * where `fullUrl` is the exact URL Twilio requested (scheme + host + path + query) and the params
 * are the application/x-www-form-urlencoded POST fields.
 *
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Pure functions, no framework dependency — unit-testable in isolation.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/** Constant-time comparison of two base64 signatures. */
export function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(provided, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Validate a Twilio webhook signature against one or more candidate URLs. Proxies frequently
 * rewrite Host/scheme, so we accept the URL reconstructed from request headers *and* an optional
 * configured public URL — the request is valid if the signature matches against any candidate.
 */
export function verifyTwilioSignature(
  authToken: string,
  signatureHeader: string | undefined,
  candidateUrls: Array<string | undefined>,
  params: Record<string, string>,
): boolean {
  if (!authToken || !signatureHeader) return false;
  for (const url of candidateUrls) {
    if (!url) continue;
    const expected = computeTwilioSignature(authToken, url, params);
    if (signaturesMatch(expected, signatureHeader)) return true;
  }
  return false;
}

/** Reconstruct the externally-visible URL Twilio called, honouring common proxy headers. */
export function reconstructRequestUrl(headers: Record<string, unknown>, originalUrl: string): string | undefined {
  const proto = firstHeader(headers['x-forwarded-proto']) ?? 'https';
  const host = firstHeader(headers['x-forwarded-host']) ?? firstHeader(headers['host']);
  if (!host) return undefined;
  return `${proto}://${host}${originalUrl}`;
}

function firstHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  if (typeof value === 'string') return value.split(',')[0]?.trim();
  return undefined;
}
