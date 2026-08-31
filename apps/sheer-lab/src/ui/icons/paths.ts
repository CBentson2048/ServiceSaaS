/**
 * QLAB icon geometry.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * QLAB shipped its entire iconography as emoji and stray Unicode glyphs —
 * 🧪 📦 🧾 🛡️ ⚖️ 🔍 ➕ 🔒 ⏻ ⟳ ⚙︎ ▦ ‹ ＋ ⌕ ◷. On iOS those render as
 * full-colour Apple emoji, which means they:
 *   - cannot be tinted, so a red-and-yellow test tube sits on the purple rail;
 *   - do not share a stroke weight, optical size or baseline with each other;
 *   - shift appearance between iOS versions, outside our control;
 *   - are announced by VoiceOver as their emoji name ("test tube") rather than
 *     the action they trigger.
 *
 * These are single-path outline icons on a 24×24 grid, drawn at one stroke
 * weight with round caps and joins. Consistency of grid and stroke is what
 * makes a set read as drawn by one hand.
 *
 * ---------------------------------------------------------------------------
 * ADDING AN ICON
 * ---------------------------------------------------------------------------
 * Draw on a 24×24 canvas with a 2px safe margin (so live area is 20×20), keep
 * to a 1.75 stroke, and prefer a single `d` string. If a glyph genuinely needs
 * a solid counter-shape, add it to `FILLED_ICONS` so `Icon` fills instead of
 * strokes it.
 */

/** Every icon is authored on this grid; `Icon` scales it via `viewBox`. */
export const ICON_VIEWBOX = 24;

/**
 * Icons drawn as filled shapes rather than strokes. Kept minimal — a mixed
 * set of filled and outline icons is the fastest way to make a UI look
 * assembled from clip art.
 */
export const FILLED_ICONS = new Set<IconName>(['dot', 'starFilled']);

export const iconPaths = {
  // --- Navigation -----------------------------------------------------------
  /** Dashboard — replaces the ▦ glyph. */
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  /** New Mix — replaces 🧪. A laboratory flask. */
  flask: 'M9 3v6.5L4.2 17.6A2 2 0 0 0 5.9 20.6h12.2a2 2 0 0 0 1.7-3L15 9.5V3M8 3h8M6.8 14h10.4',
  /** History — replaces 🕘. Clock with a rewind arc. */
  history: 'M3.2 10.5A9 9 0 1 1 5 16.2M3 5v5.5h5.5M12 7.5V12l3.2 2',
  /** Inventory — replaces 📦. An open carton. */
  box: 'M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12m0 0 8.5-4.5M12 12v9M7.75 5.25l8.5 4.5',
  /** Billing — replaces 🧾. A receipt. */
  receipt: 'M5 3.5h14v17l-2.3-1.6-2.35 1.6L12 19l-2.35 1.5L7.3 18.9 5 20.5zM9 8h6M9 12h6',
  /** Audit trail — replaces 🛡️. A shield with a check. */
  shield: 'M12 3 4.5 6v5.6c0 4.4 3.1 8.1 7.5 9.4 4.4-1.3 7.5-5 7.5-9.4V6zM9 12l2.2 2.2L15.4 10',
  /**
   * Settings — replaces ⚙︎. A gear built from two concentric circles plus eight
   * radial teeth at 45° steps (r 7.5 → 9.5 about centre 12,12), rather than the
   * usual single contorted outline: the teeth stay evenly spaced at every size
   * and the geometry is trivially checkable.
   */
  settings:
    'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15zM12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zM12 4.5V2.5M12 19.5v2M4.5 12h-2M19.5 12h2M6.7 6.7 5.28 5.28M17.3 17.3l1.42 1.42M17.3 6.7l1.42-1.42M6.7 17.3 5.28 18.72',
  /** Sign out — replaces ⏻. */
  signOut: 'M9.5 20.5H5.5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h4M16 16.5l4.5-4.5L16 7.5M20.5 12H9',

  // --- Actions --------------------------------------------------------------
  /** Refresh — replaces ⟳. */
  refresh: 'M20.5 5.5v5h-5M3.5 18.5v-5h5M5.6 9.5A7.5 7.5 0 0 1 18.1 6.7l2.4 2.3M3.5 15l2.4 2.3a7.5 7.5 0 0 0 12.5-2.8',
  /** Add — replaces ＋ and ➕. */
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  /** Search — replaces 🔍 and ⌕. */
  search: 'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM20.5 20.5l-4.2-4.2',
  /** Confirmation tick — replaces the bare ✓ text glyph. */
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  close: 'M6 6l12 12M18 6 6 18',
  /** Reset / undo — replaces ↺. */
  undo: 'M3.5 8.5h6v-6M3.9 8.9a8 8 0 1 1-1.4 6.1',
  edit: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3zM14.5 6.5l3 3',
  trash: 'M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5 7.5 20a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-13.5M10 10.5v6M14 10.5v6',
  filter: 'M3.5 5.5h17l-6.5 7.6V20l-4-2.2v-4.7z',

  // --- Chevrons / direction -------------------------------------------------
  /** Back — replaces the ‹ text glyph. */
  chevronLeft: 'M15 4.5 7.5 12l7.5 7.5',
  chevronRight: 'M9 4.5 16.5 12 9 19.5',
  chevronUp: 'M4.5 15 12 7.5l7.5 7.5',
  chevronDown: 'M4.5 9 12 16.5 19.5 9',
  arrowRight: 'M4 12h16M14 6l6 6-6 6',
  arrowUp: 'M12 20V4M6 10l6-6 6 6',
  arrowDown: 'M12 4v16M6 14l6 6 6-6',

  // --- Lab domain -----------------------------------------------------------
  /** The BLE scale — replaces ⚖️. A platform scale. */
  scale: 'M3.5 8.5h17l-3 10.5a1 1 0 0 1-1 .7H7.5a1 1 0 0 1-1-.7zM12 8.5V5M9 5h6M8 12.5h8',
  /** Bluetooth connectivity. */
  bluetooth: 'M7 7.5 17 16.5 12 20.5V3.5l5 4L7 16.5',
  /** A client / stylist. */
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  /** A timed appointment slot. */
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5.2l3.4 2',
  calendar: 'M4.5 6.5h15v14h-15zM4.5 10.5h15M9 3.5v4M15 3.5v4',
  /** Owner/manager-only areas — replaces 🔒. */
  lock: 'M6.5 10.5h11v10h-11zM8.75 10.5V7.5a3.25 3.25 0 0 1 6.5 0v3',
  /** Warning / low stock. */
  alert: 'M12 3.5 21.5 20h-19zM12 9.5v4.5M12 17.2v.05',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.05',
  /** Money / billing value. */
  currency: 'M12 3v18M16 6.9c-1-1-2.4-1.5-4-1.5-2.5 0-4 1.3-4 3.1 0 4.4 8.4 2 8.4 6.6 0 2-1.9 3.4-4.4 3.4-1.9 0-3.5-.6-4.6-1.8',
  /** Trend up — margin, growth. */
  trendUp: 'M3.5 16.5 9.5 10.5l4 4 7-7M15.5 3.5h5v5',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  /** A saved / archived record. */
  archive: 'M3.5 4.5h17v4h-17zM5 8.5V20h14V8.5M10 12.5h4',
  /** Notes / stylist commentary. */
  note: 'M6 3.5h9L19.5 8v12.5h-13zM14.5 3.5V8h5M9 12h6M9 16h4',
  /** A completed session. */
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.2 12.2l2.6 2.6 5-5',
  /** Duplicate a previous formula. */
  copy: 'M9.5 9.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5.5 15.5h-1a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',

  // --- Small marks ----------------------------------------------------------
  /** A solid status dot. Filled, not stroked. */
  dot: 'M12 17.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z',
  starFilled: 'M12 3.5l2.6 5.6 6.1.8-4.5 4.2 1.2 6.1L12 17.2l-5.4 3 1.2-6.1L3.3 9.9l6.1-.8z',
} as const;

export type IconName = keyof typeof iconPaths;

/** Every icon name, for tests and for a design-system gallery screen. */
export const iconNames = Object.keys(iconPaths) as IconName[];
