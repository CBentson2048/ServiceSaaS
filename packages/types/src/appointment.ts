export type AppointmentStatus =
  | 'pending'
  | 'confirmed'
  | 'checked_in'
  | 'in_progress'
  | 'awaiting_payment'
  | 'paid'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export interface AppointmentSummary {
  id: string;
  locationId: string;
  clientId: string;
  stylistId: string;
  serviceIds: string[];
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
}
