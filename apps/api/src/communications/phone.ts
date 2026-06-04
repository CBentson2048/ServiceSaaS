/**
 * Phone-number normalisation shared by the WhatsApp and SMS senders. Both Twilio channels need a
 * valid E.164 number; WhatsApp additionally requires the `whatsapp:` address prefix.
 */

/** Normalise a raw phone string to bare E.164 (`+447700900123`). Returns undefined when unusable. */
export function normalizeE164(raw: string | undefined | null): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const withoutPrefix = trimmed.replace(/^whatsapp:/i, '').trim();
  if (!/^\+?[0-9][0-9\s()-]{5,}$/.test(withoutPrefix)) return undefined;
  const digits = withoutPrefix.replace(/[\s()-]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

/** Normalise into Twilio's `whatsapp:+E164` form. Returns undefined when unusable. */
export function toWhatsAppAddress(raw: string | undefined | null): string | undefined {
  const e164 = normalizeE164(raw);
  return e164 ? `whatsapp:${e164}` : undefined;
}
