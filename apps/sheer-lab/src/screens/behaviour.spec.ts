/**
 * BEHAVIOURAL INVARIANTS FOR A TOOL THAT HANDLES MONEY AND STOCK.
 *
 * Structural, like the other specs here, because there is no renderer in this
 * test environment (see jest.config.js). Each block below pins one defect that
 * was actually present, and the comment says what it did — a structural test
 * with no rationale is a puzzle for whoever trips it.
 *
 * These are cheap to satisfy and cheap to break: every one of them was a single
 * line, and none of them announced itself at runtime. That is precisely the
 * class of defect that needs a test rather than a convention.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

/** Comments stripped, so prose describing a defect cannot satisfy — or fail — its own assertion. */
function code(...segments: string[]): string {
  return readFileSync(join(SRC, ...segments), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const FORMULA = code('screens', 'Formula', 'FormulaScreen.tsx');
const MIX_FINALIZED = code('screens', 'MixFinalized', 'MixFinalizedScreen.tsx');
const INVENTORY = code('screens', 'Inventory', 'InventoryScreen.tsx');
const PRODUCT_FORM = code('screens', 'Inventory', 'ProductFormModal.tsx');
const STOCK_ADJUST = code('screens', 'Inventory', 'StockAdjustModal.tsx');
const HISTORY = code('screens', 'FormulaHistory', 'FormulaHistoryScreen.tsx');
const HOME = code('screens', 'Home', 'HomeScreen.tsx');
const SETTINGS = code('screens', 'Settings', 'SettingsScreen.tsx');
const PAIRING = code('screens', 'DevicePairing', 'DevicePairingScreen.tsx');
const BILLING = code('screens', 'BillingRules', 'BillingRulesScreen.tsx');
const APP_CONFIG = code('config', 'appConfig.ts');

describe('money is entered in one unit', () => {
  it('asks for cost per gram in pounds on both surfaces that collect it', () => {
    // THE DEFECT. The inventory product form takes pounds behind a £ prefix and
    // converts (`Math.round(cost * 100)`); the Formula screen took RAW PENCE.
    // Both write the same `costPerGramCents`. An operator who typed 0.12 in one
    // (twelve pence) and 0.12 in the other priced the ingredient at 0.12 pence
    // per gram — a 100x under-charge, accepted in silence.
    expect(PRODUCT_FORM).toMatch(/prefix="£"/);
    expect(FORMULA).toMatch(/label="Cost \/ g \(£\)"/);
    expect(FORMULA).not.toMatch(/Cost \/ g \(pence\)/);
  });

  it('converts pounds to pence at both call sites, not just one', () => {
    expect(PRODUCT_FORM).toMatch(/Math\.round\(cost \* 100\)/);
    expect(FORMULA).toMatch(/Math\.round\(pounds \* 100\)/);
  });

  it('has no input anywhere still labelled in pence', () => {
    for (const [name, src] of [
      ['FormulaScreen', FORMULA],
      ['ProductFormModal', PRODUCT_FORM],
      ['StockAdjustModal', STOCK_ADJUST],
      ['BillingRulesScreen', BILLING],
    ] as const) {
      expect({ file: name, pence: /label[=:]\s*['"`][^'"`]*pence/i.test(src) }).toEqual({
        file: name,
        pence: false,
      });
    }
  });
});

describe('a failure does not look like a success', () => {
  // One muted 12pt grey line carried progress ("Saving draft..."), success
  // ("Draft saved to salon records") and hard failure ("Could not send the mix
  // to the front desk") on BOTH money-moving screens. The operator is trained
  // to ignore that strip, because it is where "Saving…" appears.
  it.each([
    ['FormulaScreen', FORMULA],
    ['MixFinalizedScreen', MIX_FINALIZED],
  ])('%s gives its notice a tone', (_name, src) => {
    expect(src).toMatch(/type NoticeTone = 'progress' \| 'success' \| 'danger'/);
    expect(src).toMatch(/NOTICE_TONE_STYLE/);
  });

  it('routes the send-to-desk failure through the danger tone', () => {
    expect(MIX_FINALIZED).toMatch(/Could not send the mix to the front desk\.', 'danger'/);
    expect(MIX_FINALIZED).toMatch(/session expired[^']*', 'danger'/);
  });

  it('routes the draft-sync failure through the danger tone', () => {
    for (const src of [FORMULA, MIX_FINALIZED]) {
      expect(src).toMatch(/could not sync to salon records[^`]*`, 'danger'/);
    }
  });

  it('has no notice setter left that cannot carry a tone', () => {
    // `setDraftMessage` / `setMessage` took a bare string.
    expect(FORMULA).not.toMatch(/setDraftMessage\(/);
    expect(MIX_FINALIZED).not.toMatch(/setMessage\(/);
  });
});

describe('the console does not promise a save it never makes', () => {
  it('does not claim automatic saving', () => {
    // `saveDraft()` has exactly two call sites in the app and both are explicit
    // button handlers, yet the footer read "✓ Saved automatically {time}" — on
    // the one screen where captured grams are irreversible.
    expect(FORMULA).not.toMatch(/Saved automatically/);
    expect(FORMULA).not.toMatch(/Auto-save ready/);
  });

  it('says plainly when nothing has been saved', () => {
    expect(FORMULA).toMatch(/Not saved yet/);
  });
});

describe('irreversible things are confirmed', () => {
  const CONFIRM = code('lib', 'confirm.ts');

  it('has a confirmation mechanism at all', () => {
    // `Alert` was not imported anywhere in src/ — three server-side destructive
    // actions fired on one tap.
    expect(CONFIRM).toMatch(/Alert\.alert/);
    expect(CONFIRM).toMatch(/style: 'destructive'/);
  });

  it('treats dismissal as a cancel, not a confirm', () => {
    expect(CONFIRM).toMatch(/onDismiss: \(\) => resolve\(false\)/);
    expect(CONFIRM).toMatch(/style: 'cancel', onPress: \(\) => resolve\(false\)/);
  });

  it.each([
    ['archiving a product', INVENTORY],
    ['resetting every billing rule', BILLING],
    ['discarding captured weights', FORMULA],
    ['resetting the device registration', SETTINGS],
  ])('confirms before %s', (_what, src) => {
    expect(src).toMatch(/confirmDestructive\(/);
  });

  it('only asks about reopening when there is captured work to lose', () => {
    // A prompt on every tap would be trained away; this one has to mean something.
    const handler = FORMULA.slice(FORMULA.indexOf('async function handleLoadDraft'));
    expect(handler).toMatch(/capturedNow > 0/);
  });
});

describe('an error is shown where the operator is looking', () => {
  it('hands save and adjust failures back into the modal', () => {
    // The screen's error banner sits BEHIND the modal, so a rejected save was
    // invisible: the button went "Saving…", came back, and the reason rendered
    // on a surface the operator could not see. Repeated taps then repeated the
    // failing request.
    expect(INVENTORY).toMatch(/setSubmitError\(/);
    expect(INVENTORY).toMatch(/submitError=\{submitError\}/);
    for (const src of [PRODUCT_FORM, STOCK_ADJUST]) {
      expect(src).toMatch(/submitError\?: string/);
      expect(src).toMatch(/error \?\? submitError/);
    }
  });

  it('does not send a mutation failure to the screen-level banner instead', () => {
    for (const label of ['Could not save product', 'Could not update stock', 'Could not archive product']) {
      expect(INVENTORY).toMatch(new RegExp(`setSubmitError\\([^)]*${label}`));
      expect(INVENTORY).not.toMatch(new RegExp(`setError\\([^)]*${label}`));
    }
  });

  it('clears the modal error when the modal closes', () => {
    const closes = INVENTORY.match(/setSubmitError\(undefined\)/g) ?? [];
    // Three request starts plus two onClose handlers.
    expect(closes.length).toBeGreaterThanOrEqual(5);
  });
});

describe('bad input is refused, not silently rewritten', () => {
  it('will not save an unparseable reorder level as zero', () => {
    // `parseDecimal(form.reorderLevel) ?? 0` — and a threshold of 0 never fires
    // a low-stock alert, so the product silently stopped being monitored while
    // the operator was shown a success notice.
    expect(PRODUCT_FORM).toMatch(/Reorder level must be a number/);
    expect(PRODUCT_FORM).toMatch(/Cost per gram must be a number/);
  });

  it('refuses a loss larger than the quantity on hand', () => {
    // Accepting it wrote a negative on-hand quantity and a wrong inventory
    // valuation (quantity x cost), and told the operator it had worked. The
    // modal displays the on-hand figure two lines above the field.
    expect(STOCK_ADJUST).toMatch(/direction === 'loss' && item && magnitude > item\.currentQuantityGrams/);
    expect(STOCK_ADJUST).toMatch(/a loss cannot exceed it/);
  });
});

describe('the screen does not assert what it does not know', () => {
  it('reports every failed inventory source, not two of five', () => {
    // `[productRes, stockRes].some(...)` — so a failed movements, categories or
    // low-stock call left the screen looking fully loaded. "Low-stock alerts 0"
    // after a failed alerts call is the number the owner opens this to read.
    expect(INVENTORY).toMatch(/failedNames/);
    expect(INVENTORY).not.toMatch(/\[productRes, stockRes\]\.some/);
    for (const source of ['low-stock alerts', 'stock movements', 'categories']) {
      expect(INVENTORY).toContain(source);
    }
  });

  it('distinguishes "not loaded yet" from "none" on the dashboard panels', () => {
    // `bookings` starts [], so a cold open stated as fact that nobody was in
    // the chair and that no stock was configured — while the requests that
    // would say otherwise were still in flight.
    expect(HOME).toMatch(/loading && bookings\.length === 0/);
    expect(HOME).toMatch(/loading && !hasStock && !failed/);
    expect(HOME).toMatch(/loading=\{loading\}/);
  });

  it('labels history metrics with the period the data came from', () => {
    // Labels derived from `period`, which flips the instant a chip is tapped,
    // while the numbers kept the previous window until the refetch landed —
    // "Billed this month" over today's revenue.
    expect(HISTORY).toMatch(/periodSuffix\(loadedPeriod\)/);
    expect(HISTORY).not.toMatch(/periodSuffix\(period\)/);
    expect(HISTORY).toMatch(/setLoadedPeriod\(period\)/);
  });

  it('marks history as loading while it refetches', () => {
    // setLoading(true) existed only in the useState initialiser, so every
    // period change after the first refetched with no in-flight cue at all.
    const load = HISTORY.slice(HISTORY.indexOf('const load = useCallback'));
    expect(load.slice(0, 400)).toMatch(/setLoading\(true\)/);
  });

  it('does not tell an owner a metric is for managers only', () => {
    // One `else` covered three causes — not loaded, load failed, and a real 403
    // — and hardcoded "Managers only" with no role check.
    // Assert the hardcoded form is gone outright — that IS the defect. Slicing
    // to the locked branch is fragile: `key: 'grams'` appears in the loaded
    // branch first, which is what made the first version of this test wrong.
    expect(HISTORY).not.toMatch(/value: 'Managers only'/);
    const guarded = HISTORY.match(/canSeeFinance \? 'Unavailable' : 'Managers only'/g) ?? [];
    expect(guarded.length).toBe(2);
  });

  it('reports the environment it actually reached', () => {
    // Read `: 'production'` unconditionally, while the release URL points at
    // DEVELOP whenever review mode is on. It is the only environment signal in
    // the UI and it is rendered on seven surfaces.
    expect(APP_CONFIG).toMatch(/RELEASE_API_BASE_URL === PRODUCTION_API_BASE_URL/);
    expect(APP_CONFIG).not.toMatch(/__DEV__ \? readEnvironment\(readEnv\(SHEER_LAB_ENV\)\) : 'production'/);
  });
});

describe('a dead end has a way out', () => {
  it('offers a route to the screen that can pair a scale', () => {
    // "Scan for Acaia Pearl" called startScan, which only populates
    // `ble.devices` — a list this 54-line screen never read, with no route to
    // DevicePairing. The scan result was unreachable.
    expect(SETTINGS).toMatch(/navigate\('DevicePairing'\)/);
    expect(SETTINGS).not.toMatch(/onPress=\{ble\.startScan\}/);
  });

  it('offers a route out of a denied Bluetooth permission', () => {
    // Once denied on iOS it cannot be re-granted in-app; the app's only
    // response was a sentence telling the operator to go to Settings, with no
    // way to get there. The scale is the reason this app exists.
    expect(PAIRING).toMatch(/Linking\.openSettings\(\)/);
    expect(PAIRING).toMatch(/permission\.status === 'denied'/);
  });

  it('does not start a blank mix on an already-completed appointment in silence', () => {
    // "Completed Today" reads as a record view; tapping a row started a new,
    // empty formula against an appointment already mixed and billed.
    expect(HOME).toMatch(/isCompletedBooking\(booking\)/);
    const guard = HOME.slice(HOME.indexOf('const openFormulaForBooking'));
    expect(guard.slice(0, 900)).toMatch(/confirmDestructive\(/);
  });
});
