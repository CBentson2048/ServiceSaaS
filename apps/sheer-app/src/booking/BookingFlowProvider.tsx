import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type {
  PublicBookingAppointmentSummary,
  PublicBookingAvailabilitySlot,
  PublicBookingFinishingRequirement,
  PublicBookingLocationSummary,
  PublicBookingServiceSummary,
  PublicBookingStylistSummary,
  PublicBookingUpgradeSuggestion,
} from '@sheer/domain';

export interface BookingDraft {
  location?: PublicBookingLocationSummary;
  services: PublicBookingServiceSummary[];
  finishingRequirements: PublicBookingFinishingRequirement[];
  upgradeSuggestions: PublicBookingUpgradeSuggestion[];
  staffRequestMode: 'specific_staff' | 'next_available';
  stylist?: PublicBookingStylistSummary;
  selectedSlot?: PublicBookingAvailabilitySlot;
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

export function totalPrice(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.startingPriceAmount, 0);
}

export function totalDuration(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.estimatedDurationMinutes, 0);
}

export function totalDeposit(services: PublicBookingServiceSummary[]): number {
  return services.reduce((sum, service) => sum + service.depositRequiredAmount, 0);
}
