// Shared helpers for stylist "occupied time" — the sub-windows of an appointment
// during which the stylist is actually busy. A service is split into ordered
// segments; a segment flagged stylist-free ("development time", e.g. colour
// developing) does NOT occupy the stylist, so another booking may overlap it.
//
// These power both the double-booking guard (booking.appointments.occupied_ranges,
// a tstzmultirange the DB exclusion constraint keys on) and the availability
// engine (which slots a new booking so only its OCCUPIED sub-windows must avoid
// other bookings' occupied windows).

export interface TimeInterval {
  start: Date;
  end: Date;
}

/** An occupied sub-window measured as milliseconds from a booking's start. */
export interface OffsetInterval {
  startMs: number;
  endMs: number;
}

/** Minimal segment shape the occupancy maths needs. */
export interface OccupancySegment {
  durationMinutes: number;
  isStylistFree: boolean;
}

/** Minimal service shape: its full duration plus its ordered segments. */
export interface OccupancyService {
  durationMinutes: number;
  segments: OccupancySegment[];
}

const MINUTE_MS = 60_000;

/**
 * Walks the services back-to-back (the same sequencing the appointment writers
 * use) and returns the stylist-OCCUPIED sub-windows as offsets from the booking
 * start. A service with no segments is wholly occupied; a service's stylist-free
 * segments are skipped. The cursor always advances by the FULL segment/service
 * duration, so the client still occupies the chair for the whole appointment.
 * Returns an empty array when nothing occupies the stylist (all-free) — such a
 * booking never blocks another.
 */
export function occupiedOffsets(services: OccupancyService[]): OffsetInterval[] {
  const out: OffsetInterval[] = [];
  let cursorMs = 0;
  for (const service of services) {
    const segments = service.segments ?? [];
    if (segments.length === 0) {
      const durMs = service.durationMinutes * MINUTE_MS;
      out.push({ startMs: cursorMs, endMs: cursorMs + durMs });
      cursorMs += durMs;
      continue;
    }
    for (const segment of segments) {
      const segMs = segment.durationMinutes * MINUTE_MS;
      if (!segment.isStylistFree) out.push({ startMs: cursorMs, endMs: cursorMs + segMs });
      cursorMs += segMs;
    }
  }
  return out;
}

/** Absolute occupied intervals for a booking that starts at `start`. */
export function occupiedIntervalsFrom(services: OccupancyService[], start: Date): TimeInterval[] {
  const base = start.getTime();
  return occupiedOffsets(services).map((offset) => ({
    start: new Date(base + offset.startMs),
    end: new Date(base + offset.endMs),
  }));
}

/**
 * Formats intervals as a tstzmultirange text literal (e.g.
 * `{["2026-07-03T09:00:00.000Z","2026-07-03T09:45:00.000Z")}`) for INSERT/UPDATE
 * via supabase-js. Postgres normalises + merges adjacent/overlapping ranges on
 * cast, so the caller need not pre-merge. An empty list yields `{}` (never blocks).
 */
export function toMultirangeLiteral(intervals: TimeInterval[]): string {
  const parts = intervals
    .filter((interval) => interval.end.getTime() > interval.start.getTime())
    .map((interval) => `["${interval.start.toISOString()}","${interval.end.toISOString()}")`);
  return `{${parts.join(',')}}`;
}

/**
 * Parses a tstzmultirange text value as returned by PostgREST — e.g.
 * `{["2026-07-03 09:00:00+00","2026-07-03 09:45:00+00"),[...)}` or `{}` — into
 * absolute intervals. Offset-agnostic: whatever timezone Postgres emits, the
 * resulting Date is the correct instant.
 */
export function parseMultirange(text: string | null | undefined): TimeInterval[] {
  if (!text) return [];
  const trimmed = text.trim();
  if (trimmed === '{}' || trimmed === '') return [];
  const out: TimeInterval[] = [];
  // Each range: an open/closed bracket, a lower and upper bound (each either a
  // double-quoted string or bare token), and a closing bracket.
  const rangeRe = /[[(]\s*("(?:[^"\\]|\\.)*"|[^,]*)\s*,\s*("(?:[^"\\]|\\.)*"|[^\])]*)\s*[\])]/g;
  let match: RegExpExecArray | null;
  while ((match = rangeRe.exec(trimmed)) !== null) {
    const lower = normalizePgTimestamp(unquote(match[1]));
    const upper = normalizePgTimestamp(unquote(match[2]));
    if (!lower || !upper) continue; // unbounded — not produced by our writers
    const start = new Date(lower);
    const end = new Date(upper);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    out.push({ start, end });
  }
  return out;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

/**
 * Turns a Postgres timestamptz text value into an ISO 8601 string JS Date parses
 * reliably: `2026-07-03 09:00:00+00` -> `2026-07-03T09:00:00+00:00`. Handles a
 * bare hour offset (`+00`) by padding to `+00:00`.
 */
function normalizePgTimestamp(raw: string): string {
  if (!raw) return raw;
  let value = raw.trim().replace(' ', 'T');
  // Pad an hour-only offset (+HH / -HH) to +HH:00.
  value = value.replace(/([+-]\d{2})$/, '$1:00');
  // Pad a colon-less 4-digit offset (+HHMM) to +HH:MM.
  value = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return value;
}
