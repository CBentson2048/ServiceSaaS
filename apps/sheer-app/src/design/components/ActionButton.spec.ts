/**
 * The screen primary action has ONE definition.
 *
 * Structural, for the same reason app-shell.spec.ts is: there is no React
 * Native renderer available here, so this checks the thing that can actually
 * regress — two screens drifting back to two different-looking buttons.
 *
 * The Bookings "New booking" button and the Rota "Request leave" button were
 * visibly different: AppButton's form CTA (18/10 padding, 14px/500 label in
 * `textOnPrimary`, which is dark ink on this theme) versus a compact 16/8
 * glowing pill with a 13px/800 white label. Bookings passed a white icon and
 * got a white "+" beside dark text. Both now render ActionButton.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source with comments stripped, so prose cannot satisfy — or break — a match. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The `<ActionButton … />` element itself. Neither call site nests one. */
const element = (src: string) => src.slice(src.indexOf('<ActionButton'), src.indexOf('/>', src.indexOf('<ActionButton')) + 2);
/** Everything between `<Screen>`'s opening tag and the button. */
const beforeAction = (src: string) =>
  src.slice(src.indexOf('>', src.indexOf('<Screen ')) + 1, src.indexOf('<ActionButton'));

const BOOKINGS = code('app/bookings.tsx');
const ROTA = code('app/rota.tsx');
const COMPONENT = code('src/design/components/ActionButton.tsx');

describe('the two screen primary actions share one definition', () => {
  it('renders ActionButton on both screens', () => {
    expect(BOOKINGS).toMatch(/<ActionButton\b/);
    expect(ROTA).toMatch(/<ActionButton\b/);
  });

  it('has neither screen hand-rolling the pill any more', () => {
    // The four styles ActionButton took over. Their return to either file means
    // the look has two homes again.
    for (const [name, src] of [
      ['bookings.tsx', BOOKINGS],
      ['rota.tsx', ROTA],
    ] as const) {
      expect({ file: name, requestBtn: /requestBtn/.test(src) }).toEqual({
        file: name,
        requestBtn: false,
      });
    }
  });

  it('puts the action in the same position on both screens', () => {
    // Rota's button was right-aligned by a `flex: 1` spacer inside a wrapper
    // row — left over from a heading that has since gone — while Bookings had
    // none, so the two sat on opposite sides. Both now render the button as
    // the first thing in Screen's content column, unwrapped, and neither
    // passes a style: the alignment lives in ActionButton, which is what
    // stops them drifting apart again.
    for (const [name, src] of [
      ['bookings.tsx', BOOKINGS],
      ['rota.tsx', ROTA],
    ] as const) {
      expect({
        file: name,
        wrapped: /<View\b/.test(beforeAction(src)),
        overridesStyle: /\bstyle=/.test(element(src)),
      }).toEqual({ file: name, wrapped: false, overridesStyle: false });
    }
  });

  it('does not send either screen back to AppButton for its primary action', () => {
    // AppButton is the full-width form CTA and draws `textOnPrimary` (dark ink
    // here), which is what made these two look different in the first place.
    expect(BOOKINGS).not.toMatch(/<AppButton[^>]*label="New booking"/s);
    expect(ROTA).not.toMatch(/<AppButton[^>]*label="Request leave"/s);
  });
});

describe('ActionButton keeps the treatment it was extracted from', () => {
  it('keeps the compact padding, pill radius and brand fill', () => {
    expect(COMPONENT).toMatch(/paddingHorizontal:\s*spacing\.base/);
    expect(COMPONENT).toMatch(/paddingVertical:\s*spacing\.sm/);
    expect(COMPONENT).toMatch(/borderRadius:\s*radius\.pill/);
    expect(COMPONENT).toMatch(/backgroundColor:\s*BRAND/);
  });

  it('keeps the 13px/800 WHITE label — not the theme onPrimary ink', () => {
    // Reverting this to textOnPrimary reintroduces dark text under a white icon.
    expect(COMPONENT).toMatch(/label:\s*\{\s*color:\s*palette\.white,\s*fontSize:\s*13,\s*fontWeight:\s*'800'/);
    expect(COMPONENT).not.toMatch(/textOnPrimary/);
  });

  it('keeps the brand glow that distinguishes it from a flat button', () => {
    expect(COMPONENT).toMatch(/shadowColor:\s*BRAND/);
    expect(COMPONENT).toMatch(/shadowOpacity:\s*0\.4/);
    expect(COMPONENT).toMatch(/elevation:\s*4/);
  });

  it('right-aligns itself, or the pill runs full width inside Screen', () => {
    // Screen's content container is a column whose children stretch by
    // default, so an alignSelf is required either way. It is flex-end because
    // that is where Rota's button already sat, and owning it here is what let
    // both screens drop the wrapper row that used to put it there.
    expect(COMPONENT).toMatch(/alignSelf:\s*'flex-end'/);
  });

  it('owns the icon size and colour so a call site cannot mismatch them', () => {
    // The original defect: bookings.tsx passed color={palette.white} to a
    // button whose label rendered dark. Call sites now pass a name only.
    expect(COMPONENT).toMatch(/<Ionicons name=\{icon\} size=\{16\} color=\{palette\.white\} \/>/);
    expect(BOOKINGS).not.toMatch(/<ActionButton[\s\S]{0,200}?color=/);
    expect(ROTA).not.toMatch(/<ActionButton[\s\S]{0,300}?color=/);
  });
});
