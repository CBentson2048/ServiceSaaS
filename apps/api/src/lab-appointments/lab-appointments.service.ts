import { Injectable } from '@nestjs/common';
import type { AppointmentDetail, AppointmentSummary } from '@sheer/booking-core';

@Injectable()
export class LabAppointmentsService {
  today(locationId?: string): AppointmentSummary[] {
    // TODO: filter by active lab session role: stylist sees own appointments, manager sees location.
    return [
      {
        id: 'appointment_scaffold',
        businessId: 'business_scaffold',
        locationId: locationId ?? 'location_scaffold',
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        status: 'confirmed',
        clientDisplayName: 'Client Scaffold',
        serviceNames: ['Colour service'],
        assignedUserProfileId: 'user_profile_scaffold',
      },
    ];
  }

  detail(id: string): AppointmentDetail {
    // TODO: load appointment, visit context, client formula history, and access rules transactionally.
    const appointment = this.today()[0];

    if (!appointment) {
      throw new Error('Appointment scaffold missing');
    }

    return {
      ...appointment,
      id,
      clientProfileId: 'client_profile_scaffold',
      colourHistorySummary: 'Formula history placeholder',
    };
  }
}
