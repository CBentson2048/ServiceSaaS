/**
 * The Lab theme is ONE theme, and its text/fill pairs are legible.
 *
 * This app shipped two live dark themes, `labTheme` and `labLightTheme`, that
 * disagreed on four keys screens actually read. Which values a screen got
 * depended on whether it imported the theme directly or picked up the `c` that
 * `LabShell.tsx` re-exported. The worst consequence was `textOnPrimary`
 * resolving to white on the `#C46BEA` primary fill — 3.16:1, failing WCAG AA —
 * on roughly ten controls.
 *
 * Two things are pinned here. That there is only one theme, and that the
 * contrast rule is arithmetic rather than a comment someone can contradict.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { labPalette, labTheme } from './labTheme';

// --- WCAG 2.1 relative luminance / contrast ratio --------------------------

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two opaque hex colours, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL = 4.5;

describe('contrast helper', () => {
  // A ruler nobody checked is not a ruler.
  it('agrees with the known anchors', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('reproduces the ratios labPalette documents', () => {
    // The palette docblock claims 5.75:1 for accent on the canvas and 6.51:1
    // for white on accentSolid. If those drift, the docblock is lying.
    expect(contrast(labPalette.accent, labPalette.bg)).toBeCloseTo(5.75, 1);
    expect(contrast(labPalette.accentSolid, '#FFFFFF')).toBeCloseTo(6.51, 1);
  });
});

describe('there is exactly one Lab theme', () => {
  const source = readFileSync(join(__dirname, 'labTheme.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('no longer exports a second theme object', () => {
    // `labLightTheme` was the misnamed dark twin. Its return means the split
    // is back, and with it the import-path-dependent colours.
    expect(source).not.toMatch(/export const labLightTheme/);
    expect(source).toMatch(/export const labTheme/);
  });

  it('is the only theme any screen or shell imports', () => {
    const shell = readFileSync(join(__dirname, '..', 'screens', 'shared', 'LabShell.tsx'), 'utf8');
    const home = readFileSync(join(__dirname, '..', 'screens', 'Home', 'HomeScreen.tsx'), 'utf8');
    for (const [name, src] of [
      ['LabShell.tsx', shell],
      ['HomeScreen.tsx', home],
    ] as const) {
      expect({ file: name, usesLightTwin: /labLightTheme/.test(src) }).toEqual({
        file: name,
        usesLightTwin: false,
      });
    }
  });
});

describe('text is legible on the fill it is paired with', () => {
  it('passes AA for a label on the primary fill', () => {
    // THE DEFECT. White here is 3.16:1; the dark ink is 5.73:1.
    const ratio = contrast(labTheme.colors.primary, labTheme.colors.textOnPrimary);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('would FAIL with white, which is why textOnPrimary is not white', () => {
    // Stated as a test so the reason survives; this is what regressed.
    expect(contrast(labTheme.colors.primary, '#FFFFFF')).toBeLessThan(AA_NORMAL);
    expect(labTheme.colors.textOnPrimary).not.toBe('#FFFFFF');
  });

  it('passes AA for the active sidebar item, which does carry white', () => {
    // The one surface that must be white-on-purple, hence accentSolid not primary.
    const ratio = contrast(labTheme.colors.sidebarActive, labTheme.colors.sidebarActiveText);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('keeps sidebarActive on the deep accent, not the pale one', () => {
    // Swapping this to `primary` silently drops the active label to 3.16:1.
    expect(labTheme.colors.sidebarActive).toBe(labPalette.accentSolid);
  });

  it('passes AA for primary text on the page canvas', () => {
    expect(contrast(labTheme.colors.background, labTheme.colors.textPrimary)).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });
});

describe('the rebrand actually reaches the tokens', () => {
  const PRE_REBRAND_INDIGO = '#2E1F4A';

  it('does not tint selected states with the pre-rebrand indigo', () => {
    // `primarySoft` was undeclared and fell through to staffTheme's
    // palette.brand[900] — the colour QLAB replaced.
    expect(labTheme.colors.primarySoft).toBe(labPalette.accentSoft);
    expect(labTheme.colors.primarySoft).not.toBe(PRE_REBRAND_INDIGO);
  });

  it('does not leave surfaceAlt on the pre-rebrand indigo either', () => {
    expect(labTheme.colors.surfaceAlt).not.toBe(PRE_REBRAND_INDIGO);
  });
});

describe('the surface ladder is intact', () => {
  it('steps canvas -> surface -> card without collapsing', () => {
    const { background, surface, card } = labTheme.colors;
    expect(new Set([background, surface, card]).size).toBe(3);
    expect(background).toBe(labPalette.bg);
    expect(surface).toBe(labPalette.surface);
    expect(card).toBe(labPalette.surfaceRaised);
  });

  it('keeps a raised card distinguishable from the panel it sits on', () => {
    // LabButton's secondary variant fills with `card` on a `surface` panel. If
    // these ever collapse to one value that button becomes invisible.
    expect(labTheme.colors.card).not.toBe(labTheme.colors.surface);
  });
});

describe('both status-tone shapes stay available', () => {
  // Screens read `success.text` (from the staffTheme spread) AND the flat
  // `successText` alias. Dropping either breaks callers for no gain.
  it.each(['success', 'warning', 'danger'] as const)('exposes %s nested and flat', (tone) => {
    const nested = labTheme.colors[tone];
    expect(nested).toEqual(
      expect.objectContaining({
        text: expect.any(String),
        bg: expect.any(String),
        border: expect.any(String),
      }),
    );
    const flat = labTheme.colors[`${tone}Text` as 'successText' | 'warningText' | 'dangerText'];
    expect(flat).toBe(nested.text);
  });
});
