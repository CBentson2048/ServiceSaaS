import type { AppointmentStatus } from '@sheer/domain';

export interface AppointmentSummary {
  id: string;
  businessId: string;
  locationId: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  clientDisplayName: string;
  serviceNames: string[];
  assignedUserProfileId?: string;
}

export interface AppointmentDetail extends AppointmentSummary {
  clientProfileId: string;
  notes?: string;
  colourHistorySummary?: string;
  formulaIds?: string[];
}

export interface VisitContext {
  appointmentId?: string;
  clientProfileId: string;
  locationId: string;
  stylistUserProfileId?: string;
  visitReason?: string;
}

export interface ActiveQueueItem {
  appointmentId: string;
  clientDisplayName: string;
  assignedUserProfileId?: string;
  status: AppointmentStatus;
  readyForLab: boolean;
  labFormulaSessionId?: string;
}
