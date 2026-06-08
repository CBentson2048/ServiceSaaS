// Shared IANA timezone options for owner/manager-facing settings (profile,
// locations). Kept deliberately short and curated rather than enumerating every
// zone — the API validates any IANA string, so this list can grow as needed.

export interface TimezoneOption {
  value: string;
  label: string;
}

export const DEFAULT_TIMEZONE = 'Europe/London';

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
  { value: 'Europe/Dublin', label: 'Europe/Dublin' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/Madrid', label: 'Europe/Madrid' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'Europe/Rome', label: 'Europe/Rome' },
  { value: 'Europe/Amsterdam', label: 'Europe/Amsterdam' },
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Chicago', label: 'America/Chicago' },
  { value: 'America/Denver', label: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'America/Toronto', label: 'America/Toronto' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney' },
];

/**
 * Returns the user's resolved timezone, falling back to the browser zone and
 * then the platform default. Use this anywhere date/time is rendered so the
 * profile setting drives display consistently.
 */
export function resolveTimezone(userTimezone?: string | null): string {
  if (userTimezone && userTimezone.trim()) return userTimezone.trim();
  try {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserZone) return browserZone;
  } catch {
    // ignore — fall through to platform default
  }
  return DEFAULT_TIMEZONE;
}
