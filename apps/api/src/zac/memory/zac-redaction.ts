/**
 * Deterministic data-minimisation helpers for everything ZAC persists.
 * Memory summaries and message metadata pass through here BEFORE any write, so
 * the storage layer never sees emails, phone numbers, card-like digit runs or
 * credential-shaped strings — regardless of what the user typed.
 */

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/gi;
/** 7+ digit runs with optional separators — phone/card/account shaped. */
const LONG_DIGIT_RUN = /(?:\+?\d[\s().-]?){7,}\d/g;
/** Bearer/JWT/key-shaped tokens: long unbroken secret-looking strings. */
const TOKEN_LIKE = /\b(?:ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]{10,}|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b/g;

/**
 * Things ZAC refuses to remember at all (rather than store redacted): asking it
 * to hold credentials, payment details or a client's contact details is a
 * mis-use of memory, and a redacted placeholder would still imply we kept them.
 */
const FORBIDDEN_MEMORY_CONTENT =
  /\b(password|passcode|api[ -]?key|secret key|access token|refresh token|card number|cvv|iban|sort code|account number)\b|(?:\d[\s-]?){13,19}\b|\bclients?\b[^.?!]*\b(phone|mobile|email|address|contact)\b/i;

/** True when a remember-request contains content ZAC must decline to store. */
export function containsForbiddenMemoryContent(text: string): boolean {
  return FORBIDDEN_MEMORY_CONTENT.test(text);
}

/**
 * Strip PII/credential-shaped substrings and collapse whitespace. Small numbers
 * (percentages, targets like "60%") survive — they are the substance of goals —
 * while long digit runs (phones, cards) do not.
 */
export function redactForStorage(text: string, maxLength = 300): string {
  const redacted = text
    .replace(EMAIL, '[redacted]')
    .replace(TOKEN_LIKE, '[redacted]')
    .replace(LONG_DIGIT_RUN, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength - 1).trimEnd()}…`;
}
