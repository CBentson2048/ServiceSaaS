/**
 * Phone-number normalisation shared by the WhatsApp and SMS senders AND the channel-eligibility
 * check, so a number deemed "valid" is exactly the number we will send to. Both Twilio channels need
 * a valid E.164 number; WhatsApp additionally requires the `whatsapp:` address prefix.
 */

/** A fully-qualified E.164 number: `+`, a non-zero country digit, then 7–14 more digits (8–15 total). */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Default country calling code (digits only, e.g. `44` for the UK) used to promote national-format
 * numbers (a leading trunk `0`, no `+`) to E.164. Sourced from `DEFAULT_PHONE_COUNTRY_CALLING_CODE`
 * so one platform-wide default applies identically to eligibility checks and the send paths. When
 * unset, a national number with no country code is treated as invalid rather than silently mis-sent
 * (the previous behaviour turned `07700900123` into the bogus `+07700900123`).
 */
function resolveCallingCode(explicit?: string): string | undefined {
  const cc = (explicit ?? process.env.DEFAULT_PHONE_COUNTRY_CALLING_CODE)?.trim();
  return cc && /^[1-9]\d{0,3}$/.test(cc) ? cc : undefined;
}

/**
 * Normalise a raw phone string to strict E.164 (`+447700900123`). Returns undefined when the number
 * cannot be made into a valid E.164 number.
 *
 *  - `+44…` / `447…` (already international) are kept / `+`-prefixed.
 *  - `0044…` (international access prefix) becomes `+44…`.
 *  - `07…` (national trunk prefix) is promoted with `callingCode` (or DEFAULT_PHONE_COUNTRY_CALLING_CODE);
 *    without a known calling code it is rejected.
 *
 * The result is validated against {@link E164}, so non-numeric junk or an impossible length yields
 * undefined instead of a value Twilio would reject at send time.
 */
export function normalizeE164(raw: string | undefined | null, callingCode?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  let value = trimmed
    .replace(/^whatsapp:/i, '')
    .trim()
    .replace(/[\s()\-.]/g, '');

  if (value.startsWith('+')) {
    // already international — validated below.
  } else if (value.startsWith('00')) {
    value = `+${value.slice(2)}`;
  } else if (value.startsWith('0')) {
    const cc = resolveCallingCode(callingCode);
    if (!cc) return undefined;
    value = `+${cc}${value.slice(1)}`;
  } else {
    value = `+${value}`;
  }

  return E164.test(value) ? value : undefined;
}

/** Normalise into Twilio's `whatsapp:+E164` form. Returns undefined when unusable. */
export function toWhatsAppAddress(raw: string | undefined | null, callingCode?: string): string | undefined {
  const e164 = normalizeE164(raw, callingCode);
  return e164 ? `whatsapp:${e164}` : undefined;
}

/** Loose RFC-ish check: enough to decide email-channel eligibility, not to validate deliverability. */
export function isValidEmail(raw: string | undefined | null): boolean {
  const trimmed = raw?.trim();
  return Boolean(trimmed && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed));
}
