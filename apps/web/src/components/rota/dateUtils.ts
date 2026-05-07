/**
 * Light-weight date helpers shared by the manager rota UI. These are
 * intentionally timezone-naive at this stage — the API computes the
 * authoritative week range in UTC, and the UI mirrors that. A future
 * phase can swap these out for a TZ-aware helper without touching the
 * components.
 */

const DAY_MS = 86_400_000;

export function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Snap any date to the Monday of its ISO week. Sunday is treated as the
 * end of the previous week (matching the European convention used
 * across the salon product).
 */
export function snapToMonday(date: Date): Date {
  const day = date.getDay(); // 0 = Sun..6 = Sat
  const offsetToMonday = (day + 6) % 7;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - offsetToMonday);
  return monday;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function dayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

export function dayMonth(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isSameLocalDay(iso: string, day: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === day.getFullYear() &&
    d.getMonth() === day.getMonth() &&
    d.getDate() === day.getDate()
  );
}

export function isPastDate(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

export function dateInputValue(d: Date): string {
  return toIsoDate(d);
}

export function timeInputValue(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function combineDateAndTime(date: string, time: string): string {
  // Builds an ISO string in the local timezone the user is editing in.
  // Example: 2026-05-06 + 09:30 → "2026-05-06T09:30:00" (local)
  return new Date(`${date}T${time}:00`).toISOString();
}

export function differenceInDaysFromToday(isoDate: string): number {
  const d = new Date(`${isoDate}T00:00:00`);
  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.floor((d.getTime() - todayMidnight.getTime()) / DAY_MS);
}
