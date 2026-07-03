/**
 * Phone-number normalisation shared by the WhatsApp and SMS senders AND the channel-eligibility
 * check, so a number deemed "valid" is exactly the number we will send to. Both Twilio channels need
 * a valid E.164 number; WhatsApp additionally requires the `whatsapp:` address prefix.
 *
 * Backed by `libphonenumber-js` for real per-region parsing + validity checks: national-format
 * numbers (a leading trunk `0`, or bare like `7725485160`) are promoted using a default region, and
 * numbers that are the right *length* but not real (e.g. `99999999999`) are rejected instead of being
 * handed to Twilio to fail at send time.
 */
import parsePhoneNumberFromString, { isSupportedCountry, type CountryCode } from 'libphonenumber-js';

/**
 * The region used to parse national-format numbers (no `+`). Resolved once per call from, in order:
 *  1. an explicit `defaultRegion` argument (ISO-3166 alpha-2, e.g. `GB`),
 *  2. `DEFAULT_PHONE_COUNTRY` (ISO-3166 alpha-2),
 *  3. `DEFAULT_PHONE_COUNTRY_CALLING_CODE` (digits, e.g. `44`) mapped to a region,
 *  4. the platform default {@link PLATFORM_DEFAULT_REGION}.
 * Fully-qualified `+…` numbers ignore the region entirely, so this only affects national input.
 */
const PLATFORM_DEFAULT_REGION: CountryCode = 'GB';

/** Minimal calling-code → region map so a legacy `DEFAULT_PHONE_COUNTRY_CALLING_CODE` keeps working. */
const CALLING_CODE_TO_REGION: Record<string, CountryCode> = {
  '44': 'GB',
  '353': 'IE',
  '1': 'US',
  '33': 'FR',
  '49': 'DE',
  '34': 'ES',
  '39': 'IT',
  '31': 'NL',
  '351': 'PT',
  '61': 'AU',
};

function resolveDefaultRegion(explicit?: string): CountryCode {
  const iso = (explicit ?? process.env.DEFAULT_PHONE_COUNTRY)?.trim().toUpperCase();
  if (iso && isSupportedCountry(iso)) return iso as CountryCode;

  const callingCode = process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE?.trim();
  if (callingCode && CALLING_CODE_TO_REGION[callingCode]) return CALLING_CODE_TO_REGION[callingCode];

  return PLATFORM_DEFAULT_REGION;
}

/**
 * Normalise a raw phone string to strict E.164 (`+447700900123`), or `undefined` when the value is
 * not a valid, dialable phone number. National-format numbers are interpreted in `defaultRegion`
 * (see {@link resolveDefaultRegion}); international `+…` numbers are region-independent. Validity is
 * `libphonenumber-js`'s `isValid()`, so wrong-length or impossible numbers are rejected.
 */
export function normalizeE164(raw: string | undefined | null, defaultRegion?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const cleaned = trimmed.replace(/^whatsapp:/i, '').trim();

  try {
    const parsed = parsePhoneNumberFromString(cleaned, resolveDefaultRegion(defaultRegion));
    return parsed?.isValid() ? parsed.number : undefined;
  } catch {
    return undefined;
  }
}

/** Normalise into Twilio's `whatsapp:+E164` form. Returns undefined when unusable. */
export function toWhatsAppAddress(raw: string | undefined | null, defaultRegion?: string): string | undefined {
  const e164 = normalizeE164(raw, defaultRegion);
  return e164 ? `whatsapp:${e164}` : undefined;
}

/** Loose RFC-ish check: enough to decide email-channel eligibility, not to validate deliverability. */
export function isValidEmail(raw: string | undefined | null): boolean {
  const trimmed = raw?.trim();
  return Boolean(trimmed && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed));
}
