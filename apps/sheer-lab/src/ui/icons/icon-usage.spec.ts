/**
 * ICONS ARE DRAWN, NOT TYPED.
 *
 * This app shipped its entire iconography as emoji and Unicode dingbats — 35
 * distinct glyphs across ~135 call sites — while a finished 44-icon SVG set sat
 * in this directory with zero importers, because `Icon.tsx` imported a theme
 * module nothing else used.
 *
 * Why it mattered, from `paths.ts`: on iOS the emoji render as full-colour
 * Apple glyphs, so they cannot be tinted (a red-and-yellow test tube on a
 * purple rail), share no stroke weight, optical size or baseline with each
 * other, shift appearance between iOS versions, and VoiceOver announces them as
 * their emoji name — "test tube" — rather than the destination. The monochrome
 * ones were worse: `▦` carried no colour at all and drew near-black on a
 * near-black rail.
 *
 * A glyph is cheap to type and invisible in review, so this fails the build
 * instead. Typographic punctuation is explicitly allowed — a middot separator
 * or an em dash placeholder is text, not an icon.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { iconPaths, type IconName } from './paths';

const SRC = join(__dirname, '..', '..');

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Comments stripped: a comment explaining which glyph was replaced is fine. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

/**
 * Every glyph this app used as an icon, plus the emoji ranges. If you are here
 * because a new one tripped: add it to `paths.ts` and render `<Icon>`.
 */
const ICON_GLYPHS = new RegExp(
  '[' +
    '\u2190-\u21FF' + // arrows            → ← ↑ ↓
    '\u2200-\u22FF' + // math operators    ∑ ⊘
    '\u2300-\u23FF' + // misc technical    ⌕ ⌫ ⏱ ⏻
    '\u25A0-\u25FF' + // geometric shapes  ▦ ▤ ◆ ◷
    '\u2600-\u27BF' + // symbols/dingbats  ⚖ ⚗ ⚙ ⚠ ✓ ✕ ✦ ➕
    '\u27F0-\u27FF' + // supplemental arrows-A               ⟳
    '\u2B00-\u2BFF' + // misc symbols and arrows
    '\uFF0B' + //        fullwidth plus     ＋
    '\u{1F000}-\u{1FAFF}' + // emoji       🧪 📦 🔒 🕘 🛡 🖫 💡
    ']',
  'u',
);

/**
 * Allowed as text. These are typography: they carry meaning as punctuation,
 * take the surrounding text colour, and have no iconographic role.
 *
 *   ·  separator between two labels ("Connected · live")
 *   —  em dash, in prose and as an empty-value placeholder
 *   –  en dash, in ranges ("0–50%")
 *   …  ellipsis, in copy ("Saving…")
 *   £ € $  currency symbols
 *   ×  multiplication, in prose
 *   ' ' " "  typographic quotes
 *   °  degrees
 *   −  the typographic minus, as SIGN NOTATION in a label — "Loss (−)" pairs
 *      with "Inbound (+)", where the ASCII hyphen would sit too high and short.
 *      A decrement CONTROL is a `minus` icon; this is a sign in running text.
 *   ‹ ›  ONLY as the breadcrumb separator; as a control affordance it is a
 *        chevron icon, which is why the pagination and month arrows became one
 */
const TYPOGRAPHY = /[·—–…£€$×''""°‹›\u2212]/;

const FILES = tsxFiles(join(SRC, 'screens'))
  .concat(tsxFiles(join(SRC, 'features')))
  .concat(tsxFiles(join(SRC, 'navigation')));

describe('the sweep itself', () => {
  it('is looking at the app, so it cannot pass vacuously', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('would catch a glyph if one were there', () => {
    // Proves the pattern works, without depending on a real offender existing.
    for (const glyph of ['🧪', '▦', '✓', '⌕', '＋', '⚖', '🔒', '⟳', '🕘', '📦']) {
      expect(ICON_GLYPHS.test(glyph)).toBe(true);
    }
  });

  it('does not flag the typography it is meant to allow', () => {
    for (const mark of ['·', '—', '–', '…', '£']) {
      expect(TYPOGRAPHY.test(mark)).toBe(true);
    }
  });
});

describe('no screen types an icon', () => {
  it.each(FILES.map((path) => [path.slice(SRC.length + 1), path] as const))(
    '%s',
    (_label, path) => {
      const offenders: string[] = [];
      code(path)
        .split('\n')
        .forEach((line, index) => {
          for (const char of line) {
            if (TYPOGRAPHY.test(char)) continue;
            if (ICON_GLYPHS.test(char)) {
              offenders.push(`line ${index + 1}: ${char} (U+${char.codePointAt(0)!.toString(16).toUpperCase()})`);
            }
          }
        });
      expect(offenders).toEqual([]);
    },
  );
});

describe('the icon set backs every name in use', () => {
  it('has a path for every name a screen renders', () => {
    const used = new Set<string>();
    for (const path of FILES) {
      for (const match of code(path).matchAll(/<Icon\s+name="([a-zA-Z]+)"/g)) used.add(match[1]);
      for (const match of code(path).matchAll(/icon:\s*'([a-zA-Z]+)'/g)) used.add(match[1]);
      for (const match of code(path).matchAll(/icon="([a-zA-Z]+)"/g)) used.add(match[1]);
    }
    expect(used.size).toBeGreaterThan(10);
    const missing = [...used].filter((name) => !(name in iconPaths));
    expect(missing).toEqual([]);
  });

  it('draws every icon on the same grid with a single path', () => {
    // Consistency of grid and stroke is what makes a set read as one hand.
    for (const [name, d] of Object.entries(iconPaths)) {
      expect({ name, empty: d.trim().length === 0 }).toEqual({ name, empty: false });
    }
  });

  it('exposes the nav icons the station rail needs', () => {
    const required: IconName[] = ['dashboard', 'flask', 'history', 'box', 'receipt', 'shield'];
    for (const name of required) expect(iconPaths[name]).toBeDefined();
  });
});
