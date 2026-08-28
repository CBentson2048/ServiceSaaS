import { Injectable } from '@nestjs/common';
import type {
  NotificationEventRow,
  NotificationSubject,
  NotificationSubjectResolver,
} from './notification-subject';
import { AppointmentSubjectResolver } from './subjects/appointment-subject.resolver';
import { ClientSubjectResolver } from './subjects/client-subject.resolver';

/**
 * Picks the resolver that owns a queue row. This is the seam that made the dispatcher general: it
 * previously cancelled outright any event without an `appointment_id`, which meant a campaign
 * message queued into `comms.notification_events` was silently discarded. Resolution is by
 * specificity — an appointment-anchored row is always an appointment subject — so booking
 * notifications keep their exact previous behaviour.
 */
@Injectable()
export class NotificationSubjectRegistry {
  private readonly resolvers: NotificationSubjectResolver[];

  constructor(appointment: AppointmentSubjectResolver, client: ClientSubjectResolver) {
    this.resolvers = [appointment, client];
  }

  /** The subject this event is about, or null when nothing can own it (the event is then retired). */
  async resolve(event: NotificationEventRow): Promise<NotificationSubject | null> {
    for (const resolver of this.resolvers) {
      if (resolver.supports(event)) return resolver.resolve(event);
    }
    return null;
  }
}
