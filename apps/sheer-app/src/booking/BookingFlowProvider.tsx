import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  applyStylistServicePrices,
  type PublicBookingAppointmentSummary,
  type PublicBookingAvailabilitySlot,
  type PublicBookingFinishingRequirement,
  type PublicBookingLocationSummary,
  type PublicBookingServiceSummary,
  type PublicBookingStylistSummary,
  type PublicBookingUpgradeSuggestion,
} from '@sheer/domain';

export interface BookingDraft {
  location?: PublicBookingLocationSummary;
  services: PublicBookingServiceSummary[];
  finishingRequirements: PublicBookingFinishingRequirement[];
  upgradeSuggestions: PublicBookingUpgradeSuggestion[];
  staffRequestMode: 'specific_staff' | 'next_available';
  stylist?: PublicBookingStylistSummary;
  selectedSlot?: PublicBookingAvailabilitySlot;
  /**
   * Per-service prices for the stylist resolved for `selectedSlot`, set when a
   * slot is picked. Drives effectiveServices so a next-available booking shows +
   * is charged at the resolved stylist's price, matching the server.
   */
  slotServicePrices?: { serviceId: string; priceAmount: number }[];
  clientNote?: string;
  bookingAttemptId?: string;
  paymentClientSecret?: string;
  appointment?: PublicBookingAppointmentSummary;
}

interface BookingFlowState {
  draft: BookingDraft;
  updateDraft: (patch: Partial<BookingDraft>) => void;
  resetDraft: () => void;
}

const EMPTY_DRAFT: BookingDraft = {
  services: [],
  finishingRequirements: [],
  upgradeSuggestions: [],
  staffRequestMode: 'next_available',
};

const BookingFlowContext = createContext<BookingFlowState | undefined>(undefined);

export function BookingFlowProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<BookingDraft>(EMPTY_DRAFT);
  const updateDraft = useCallback((patch: Partial<BookingDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);
  const resetDraft = useCallback(() => setDraft(EMPTY_DRAFT), []);

  const value = useMemo<BookingFlowState>(
    () => ({
      draft,
      updateDraft,
      resetDraft,
    }),
    [draft, resetDraft, updateDraft],
  );

  return <BookingFlowContext.Provider value={value}>{children}</BookingFlowContext.Provider>;
}

export function useBookingFlow(): BookingFlowState {
  const value = useContext(BookingFlowContext);
  if (!value) throw new Error('useBookingFlow must be used inside BookingFlowProvider');
  return value;
}

/**
 * The services to use for ALL price displays + totals. We always keep the base
 * `draft.services` (so reverting to "any available" / next-available restores
 * base prices for free) and only swap in per-stylist prices:
 *   - once a SLOT is picked, the stylist resolved for that slot's prices (what
 *     the server will actually charge — covers next-available too); else
 *   - a SPECIFIC stylist chosen up-front previews their prices.
 * Deposits are recomputed for percentage deposits by applyStylistServicePrices.
 * Durations are untouched.
 */
export function effectiveServices(draft: BookingDraft): PublicBookingServiceSummary[] {
  if (draft.slotServicePrices) {
    return applyStylistServicePrices(draft.services, draft.slotServicePrices);
  }
  if (draft.staffRequestMode === 'specific_staff' && draft.stylist) {
    return applyStylistServicePrices(draft.services, draft.stylist.servicePrices);
  }
  return draft.services;
}

export function totalPrice(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.startingPriceAmount, 0);
}

export function totalDuration(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.estimatedDurationMinutes, 0);
}

export function totalDeposit(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.depositRequiredAmount, 0);
}
