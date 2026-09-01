import type { UpsellSuggestion } from '@sheer/domain';
import { AppButton } from '../../design';

/**
 * Suggested add-ons, shown at booking and at checkout.
 *
 * PRESENTATIONAL ONLY. This component never adds anything: it renders what the
 * server suggested and calls `onAdd` so the surrounding screen can put the
 * service through the EXISTING booking / checkout flow. Nothing here mutates an
 * appointment, a bill or a schedule.
 *
 * IT ALSO RENDERS NOTHING WHEN THERE IS NOTHING TO SAY. No empty state, no
 * error box, no spinner: suggestions are optional intelligence layered over two
 * Tier 1 screens, so when the endpoint is slow, fails, or has no answer, staff
 * simply see the booking screen they came for. The caller passes `suggestions:
 * []` on failure and this disappears — that is the whole failure mode.
 *
 * LANGUAGE. "Suggested add-ons", never "AI recommends". These are deterministic
 * rules and booking history; implying ZAC wrote them would be untrue and would
 * make staff distrust a list they should be able to check.
 */
export function UpsellSuggestions({
  suggestions,
  onAdd,
  addingServiceId,
  compact = false,
}: {
  suggestions: UpsellSuggestion[];
  /** Hands the chosen add-on back to the existing add-service workflow. */
  onAdd?: (suggestion: UpsellSuggestion) => void;
  /** The suggestion currently being added, so its button can show progress. */
  addingServiceId?: string | null;
  /** Tighter spacing for the checkout modal. */
  compact?: boolean;
}) {
  if (suggestions.length === 0) return null;

  return (
    <section
      aria-label="Suggested add-ons"
      className={`rounded-input-lg border border-border bg-surface-alt ${compact ? 'p-3' : 'p-4'}`}
    >
      <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Suggested add-ons</h3>
      <ul className="flex flex-col gap-2">
        {suggestions.map((suggestion) => (
          <li
            key={suggestion.serviceId}
            className="flex items-center justify-between gap-3 rounded-input border border-border bg-surface px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-text-primary">{suggestion.name}</p>
              <p className="truncate text-[12px] text-text-secondary">
                +{suggestion.durationMinutes} min ·{' '}
                {formatPrice(suggestion.priceAmount, suggestion.currencyCode)}
              </p>
              {/* The reason is the whole point of a deterministic engine: a
                  member of staff can see WHY this is on the list and decide. */}
              <p className="truncate text-[11px] text-text-tertiary">{suggestion.reason}</p>
            </div>
            {onAdd ? (
              <AppButton
                type="button"
                size="sm"
                variant="secondary"
                loading={addingServiceId === suggestion.serviceId}
                disabled={Boolean(addingServiceId) && addingServiceId !== suggestion.serviceId}
                onClick={() => onAdd(suggestion)}
              >
                Add
              </AppButton>
            ) : null}
          </li>
        ))}
      </ul>
      {suggestions.some((suggestion) => suggestion.requiresAvailabilityCheck) ? (
        <p className="mt-2 text-[11px] text-text-tertiary">
          Adding an add-on changes the appointment length — availability is confirmed when you add it.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Service prices are decimal currency amounts (booking.services.base_price),
 * not the integer cents the bill uses — so this deliberately does NOT reuse
 * ItemisedBill's formatMoney, which divides by 100.
 */
function formatPrice(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amount);
}
