import { useCallback, useEffect, useState } from 'react';
import type { EodDayResponse } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import {
  addEodPettyCash,
  ApiRequestError,
  getEodDay,
  openEodDay,
  refreshEodDay,
  signOffEodDay,
  updateEodDay,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { formatMoney } from '../components/bookings/ItemisedBill';
import { useLocationScope } from '../components/LocationScopeContext';

/**
 * End of Day (Week 5): the daily cash-up. Expected takings auto-feed from the
 * day's real checkout records (salon payments, retail sales, deposits, stored
 * bills); staff enter what they counted; the variance shows live against the
 * location's configured threshold; sign-off freezes the day permanently.
 */
export function EndOfDayPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const canSignOff = Boolean(auth.user && userHasPermission(auth.user, 'eod.sign_off'));
  // The cash-up is inherently per-location: follow the sidebar picker, falling
  // back to the first location when "All" is selected.
  const { locations, resolvedLocationId } = useLocationScope();
  const locationName = locations.find((location) => location.id === resolvedLocationId)?.name;

  const [businessDate, setBusinessDate] = useState(() =>
    new Date().toLocaleDateString('en-CA'),
  );
  const [data, setData] = useState<EodDayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Editable fields (pounds, as typed). Synced from the server row whenever it
  // loads; parsed to cents on save.
  const [countedCash, setCountedCash] = useState('');
  const [countedCard, setCountedCard] = useState('');
  const [openingFloat, setOpeningFloat] = useState('');
  const [voids, setVoids] = useState('');
  const [refunds, setRefunds] = useState('');
  const [notes, setNotes] = useState('');
  const [pettyAmount, setPettyAmount] = useState('');
  const [pettyReason, setPettyReason] = useState('');
  const [armedSignOff, setArmedSignOff] = useState(false);

  const adoptResponse = useCallback((response: EodDayResponse) => {
    setData(response);
    const day = response.day;
    setCountedCash(day?.countedCashCents !== undefined ? centsToPounds(day.countedCashCents) : '');
    setCountedCard(day?.countedCardCents !== undefined ? centsToPounds(day.countedCardCents) : '');
    setOpeningFloat(day ? centsToPounds(day.openingFloatCents) : '');
    setVoids(day ? centsToPounds(day.voidsCents) : '');
    setRefunds(day ? centsToPounds(day.refundsCents) : '');
    setNotes(day?.notes ?? '');
    setArmedSignOff(false);
  }, []);

  useEffect(() => {
    if (!accessToken || !resolvedLocationId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    getEodDay(accessToken, { locationId: resolvedLocationId, businessDate })
      .then((response) => {
        if (!cancelled) adoptResponse(response);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(messageFrom(err, 'Could not load the trading day'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, resolvedLocationId, businessDate, adoptResponse]);

  async function run(
    action: () => Promise<EodDayResponse>,
    successNotice?: string,
    afterFailure?: () => Promise<void>,
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      adoptResponse(await action());
      if (successNotice) setNotice(successNotice);
    } catch (err: unknown) {
      setError(messageFrom(err, 'Could not update the trading day'));
      if (afterFailure) await afterFailure();
    } finally {
      setBusy(false);
    }
  }

  /**
   * A failed add may still have saved the entry (the API then says "Petty cash
   * was recorded…"). Show the stored day, and clear the form when the entry is
   * there, so one more click doesn't add it twice. Typed counts are kept.
   */
  async function reloadAfterPettyCashFailure(entriesBefore: number) {
    try {
      const reloaded = await getEodDay(accessToken!, { locationId: resolvedLocationId, businessDate });
      setData(reloaded);
      if ((reloaded.day?.pettyCash.length ?? 0) > entriesBefore) {
        setPettyAmount('');
        setPettyReason('');
      }
    } catch {
      // The error already shown asks the user to reload the day.
    }
  }

  const day = data?.day ?? null;
  const signedOff = day?.status === 'signed_off';
  const currency = day?.currencyCode ?? 'GBP';
  const expectedCash = day?.expectedCashCents ?? 0;
  const expectedCard = day?.expectedCardCents ?? 0;
  const countedCashCents = poundsToCents(countedCash);
  const countedCardCents = poundsToCents(countedCard);
  const haveCounts = countedCashCents !== undefined && countedCardCents !== undefined;
  const liveVariance = haveCounts
    ? countedCashCents! + countedCardCents! - (expectedCash + expectedCard)
    : undefined;
  const shownVariance = signedOff ? day?.varianceCents : liveVariance;
  const threshold = data?.cashVarianceThresholdCents ?? 500;
  const varianceOk = shownVariance !== undefined && Math.abs(shownVariance) <= threshold;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 lg:px-8">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">End of day</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            {locationName ? `${locationName} · ` : ''}Expected takings feed automatically from the
            day&apos;s checkouts; count the till, record petty cash, sign off.
          </p>
        </div>
        <label className="text-[12px] font-medium text-text-secondary">
          Trading day
          <input
            type="date"
            value={businessDate}
            max={new Date().toLocaleDateString('en-CA')}
            onChange={(event) => setBusinessDate(event.target.value)}
            className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-44"
          />
        </label>
      </header>

      {notice ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-card-lg border border-border bg-surface px-5 py-10 text-center text-[13px] text-text-secondary">
          Loading the trading day…
        </div>
      ) : !day ? (
        <div className="rounded-card-lg border border-border bg-surface px-5 py-10 text-center">
          <p className="text-[14px] font-medium text-text-primary">
            This trading day hasn&apos;t been opened yet.
          </p>
          <p className="mt-1 text-[13px] text-text-secondary">
            Opening it pulls the expected takings straight from the day&apos;s checkout records.
          </p>
          <button
            type="button"
            disabled={busy || !accessToken || !resolvedLocationId}
            onClick={() =>
              void run(
                () => openEodDay(accessToken!, { locationId: resolvedLocationId, businessDate }),
                'Trading day opened — expected figures populated.',
              )
            }
            className="mt-4 inline-flex h-10 items-center justify-center rounded-pill bg-primary px-6 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
          >
            {busy ? 'Opening…' : 'Open the day'}
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          {data && data.openVisits > 0 && !signedOff ? (
            <div className="rounded-input-lg border border-border bg-surface-alt/60 px-4 py-3 text-[13px]">
              <span className="font-medium text-warning">
                {data.openVisits} visit{data.openVisits === 1 ? '' : 's'} still awaiting payment
              </span>{' '}
              <span className="text-text-secondary">
                for this day — settle them before signing off or their takings won&apos;t be in the
                expected figures.
              </span>
            </div>
          ) : null}

          {/* Expected vs counted */}
          <section className="overflow-hidden rounded-card-lg border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-[14px] font-semibold text-text-primary">Till count</h2>
              {!signedOff ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => refreshEodDay(accessToken!, day.id),
                      'Expected figures refreshed from the latest checkouts.',
                    )
                  }
                  className="rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-[12px] font-medium text-text-secondary transition hover:bg-surface-alt disabled:opacity-60"
                >
                  Refresh expected
                </button>
              ) : null}
            </div>
            <table className="w-full text-left text-[13px]">
              <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                <tr>
                  <th className="px-5 py-2.5">Tender</th>
                  <th className="px-5 py-2.5 text-right">Expected</th>
                  <th className="px-5 py-2.5 text-right">Counted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <CountRow
                  label="Cash"
                  expectedCents={expectedCash}
                  currency={currency}
                  value={countedCash}
                  onChange={setCountedCash}
                  readOnly={signedOff}
                />
                <CountRow
                  label="Card"
                  expectedCents={expectedCard}
                  currency={currency}
                  value={countedCard}
                  onChange={setCountedCard}
                  readOnly={signedOff}
                />
              </tbody>
            </table>
            <div
              className={`flex items-center justify-between border-t border-border px-5 py-3 text-[13px] ${
                shownVariance === undefined
                  ? ''
                  : varianceOk
                    ? 'bg-success-soft'
                    : 'bg-danger-soft'
              }`}
            >
              <span className="font-medium text-text-secondary">
                Variance {signedOff ? '(signed off)' : '(live)'}
                <span className="ml-1.5 text-[11px] text-text-muted">
                  {/* The threshold is not stored at sign-off: this is always today's setting. */}
                  current threshold {formatMoney(threshold, currency)}
                </span>
              </span>
              <span
                className={`font-semibold tabular-nums ${
                  shownVariance === undefined
                    ? 'text-text-muted'
                    : varianceOk
                      ? 'text-success'
                      : 'text-danger'
                }`}
              >
                {shownVariance === undefined
                  ? 'Enter counted amounts'
                  : `${shownVariance > 0 ? '+' : ''}${formatMoney(shownVariance, currency)}`}
              </span>
            </div>
          </section>

          {/* Day context: what the feed found */}
          <section className="rounded-card-lg border border-border bg-surface px-5 py-4">
            <h2 className="text-[14px] font-semibold text-text-primary">Day summary</h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
              <SummaryRow
                label="Deposits collected (Stripe)"
                value={formatMoney(day.depositsCollectedCents, currency)}
              />
              <SummaryRow
                label="Deposits redeemed on bills"
                value={formatMoney(day.depositsRedeemedCents, currency)}
              />
              {day.unclassifiedRetailCents > 0 ? (
                <SummaryRow
                  label="Retail without payment method"
                  value={formatMoney(day.unclassifiedRetailCents, currency)}
                  tone="warning"
                />
              ) : null}
              <SummaryRow
                label="Petty cash out"
                value={formatMoney(day.pettyCashOutCents, currency)}
              />
            </dl>
            <p className="mt-3 text-[12px] text-text-muted">
              Refunds and voids aren&apos;t captured automatically yet — enter them manually below
              if any occurred.
            </p>
          </section>

          {/* Manual figures */}
          <section className="rounded-card-lg border border-border bg-surface px-5 py-4">
            <h2 className="text-[14px] font-semibold text-text-primary">Float & manual entries</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <MoneyField
                label="Opening float (£)"
                value={openingFloat}
                onChange={setOpeningFloat}
                readOnly={signedOff}
              />
              <MoneyField label="Refunds (£)" value={refunds} onChange={setRefunds} readOnly={signedOff} />
              <MoneyField label="Voids (£)" value={voids} onChange={setVoids} readOnly={signedOff} />
            </div>
            <label className="mt-3 block text-[12px] font-medium text-text-secondary">
              Notes
              <textarea
                value={notes}
                readOnly={signedOff}
                onChange={(event) => setNotes(event.target.value)}
                className="mt-1 min-h-[64px] w-full rounded-input-lg border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 read-only:opacity-60"
              />
            </label>
            {!signedOff ? (
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        updateEodDay(accessToken!, day.id, {
                          openingFloatCents: poundsToCents(openingFloat) ?? 0,
                          countedCashCents: countedCashCents,
                          countedCardCents: countedCardCents,
                          refundsCents: poundsToCents(refunds) ?? 0,
                          voidsCents: poundsToCents(voids) ?? 0,
                          notes,
                        }),
                      'Saved.',
                    )
                  }
                  className="h-9 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-60"
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            ) : null}
          </section>

          {/* Petty cash */}
          <section className="rounded-card-lg border border-border bg-surface px-5 py-4">
            <h2 className="text-[14px] font-semibold text-text-primary">Petty cash</h2>
            {day.pettyCash.length > 0 ? (
              <ul className="mt-3 space-y-1.5 text-[13px]">
                {day.pettyCash.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3">
                    <span className="text-text-secondary">{entry.reason}</span>
                    <span className="font-medium text-text-primary tabular-nums">
                      {formatMoney(entry.amountCents, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[13px] text-text-secondary">No petty cash recorded today.</p>
            )}
            {!signedOff ? (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <MoneyField label="Amount (£)" value={pettyAmount} onChange={setPettyAmount} />
                <label className="min-w-40 flex-1 text-[12px] font-medium text-text-secondary">
                  Reason
                  <input
                    type="text"
                    value={pettyReason}
                    onChange={(event) => setPettyReason(event.target.value)}
                    placeholder="e.g. window cleaner"
                    className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || !poundsToCents(pettyAmount) || !pettyReason.trim()}
                  onClick={() => {
                    const entriesBefore = day.pettyCash.length;
                    void run(
                      async () => {
                        const response = await addEodPettyCash(accessToken!, day.id, {
                          amountCents: poundsToCents(pettyAmount)!,
                          reason: pettyReason.trim(),
                        });
                        setPettyAmount('');
                        setPettyReason('');
                        return response;
                      },
                      'Petty cash recorded.',
                      () => reloadAfterPettyCashFailure(entriesBefore),
                    );
                  }}
                  className="h-10 rounded-pill border border-border-strong bg-surface px-4 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt disabled:opacity-60"
                >
                  Add
                </button>
              </div>
            ) : null}
          </section>

          {/* Sign-off */}
          {signedOff ? (
            <div className="rounded-card-lg border border-success-border bg-success-soft px-5 py-4 text-[13px] text-success">
              Signed off{day.signedOffAt ? ` ${formatDateTime(day.signedOffAt)}` : ''} — this day is
              frozen and feeds the Cash Up report.
            </div>
          ) : canSignOff ? (
            <div className="flex justify-end">
              <button
                type="button"
                disabled={busy || !haveCounts}
                title={haveCounts ? undefined : 'Enter counted cash and card first'}
                onClick={() => {
                  if (!armedSignOff) {
                    setArmedSignOff(true);
                    return;
                  }
                  void run(
                    async () => {
                      // Persist the latest edits, then freeze.
                      await updateEodDay(accessToken!, day.id, {
                        openingFloatCents: poundsToCents(openingFloat) ?? 0,
                        countedCashCents: countedCashCents,
                        countedCardCents: countedCardCents,
                        refundsCents: poundsToCents(refunds) ?? 0,
                        voidsCents: poundsToCents(voids) ?? 0,
                        notes,
                      });
                      return signOffEodDay(accessToken!, day.id);
                    },
                    'Day signed off — the variance is now frozen.',
                  );
                }}
                className={`h-10 rounded-pill px-6 text-[13px] font-semibold transition disabled:opacity-60 ${
                  armedSignOff
                    ? 'border border-danger-border bg-danger-soft text-danger'
                    : 'bg-primary text-text-on-primary hover:bg-primary-deep'
                }`}
              >
                {busy
                  ? 'Signing off…'
                  : armedSignOff
                    ? 'Confirm sign-off — the day can never change again'
                    : 'Sign off the day'}
              </button>
            </div>
          ) : (
            <p className="text-right text-[12px] text-text-muted">
              Sign-off requires a manager or owner.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CountRow({
  label,
  expectedCents,
  currency,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  expectedCents: number;
  currency: string;
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
}) {
  return (
    <tr>
      <td className="px-5 py-3 font-medium text-text-primary">{label}</td>
      <td className="px-5 py-3 text-right text-text-secondary tabular-nums">
        {formatMoney(expectedCents, currency)}
      </td>
      <td className="px-5 py-3 text-right">
        <input
          type="number"
          min={0}
          step="0.01"
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0.00"
          aria-label={`Counted ${label.toLowerCase()} (£)`}
          className="h-9 w-32 rounded-input-lg border border-border-strong bg-surface px-2.5 text-right text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 read-only:opacity-60"
        />
      </td>
    </tr>
  );
}

function SummaryRow({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={tone === 'warning' ? 'font-medium text-warning' : 'text-text-secondary'}>
        {label}
      </dt>
      <dd className="font-medium text-text-primary tabular-nums">{value}</dd>
    </div>
  );
}

function MoneyField({
  label,
  value,
  onChange,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="text-[12px] font-medium text-text-secondary">
      {label}
      <input
        type="number"
        min={0}
        step="0.01"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0.00"
        className="mt-1 h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 read-only:opacity-60"
      />
    </label>
  );
}

function centsToPounds(cents: number): string {
  return (cents / 100).toFixed(2);
}

function poundsToCents(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100);
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function messageFrom(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
