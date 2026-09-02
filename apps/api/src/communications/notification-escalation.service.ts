import { Injectable, Logger } from '@nestjs/common';
import { nextChannelAfter, type ChannelPlan, type DeliveryChannel } from './channel-policy';
import { MessagingService } from './messaging.service';
import type { NotificationEventRow, NotificationSubject } from './notification-subject';
import { NotificationSubjectRegistry } from './notification-subject.registry';

/**
 * Moves a notification to the next channel in its WhatsApp → SMS → Email chain after the current one
 * was ineligible or genuinely failed.
 *
 * Escalation is keyed on the **notification event**, not on an appointment. It previously took an
 * appointment id, which meant a message with no appointment could never escalate at all — the
 * delivery callbacks passed `log.appointment_id` and silently did nothing when it was null. Keying
 * on the event makes the fallback chain work identically for a reminder and for a campaign, and the
 * delivery callbacks already carry `notification_event_id` on the message log.
 *
 * This is the ONLY place a fallback event is created, and only ever for the single next channel — so
 * a pending or accepted message never triggers a fallback, and one real failure produces at most one
 * further channel attempt.
 */
@Injectable()
export class NotificationEscalationService {
  private readonly logger = new Logger(NotificationEscalationService.name);

  constructor(
    private readonly subjects: NotificationSubjectRegistry,
    private readonly messaging: MessagingService,
  ) {}

  /** Never throws — used from delivery/callback paths where a failure must not break the response. */
  async escalateFromEventSafe(
    event: NotificationEventRow | string,
    failedChannel: DeliveryChannel,
    reason: string,
  ): Promise<DeliveryChannel | null> {
    try {
      return await this.escalateFromEvent(event, failedChannel, reason);
    } catch (err) {
      const id = typeof event === 'string' ? event : event.id;
      this.logger.error(`escalateFromEvent failed for event ${id}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Queue the next channel after `failedChannel`. Returns the channel that was enqueued (or already
   * existed — idempotent), or `null` when there is no further channel to try or the message is no
   * longer warranted (appointment cancelled, reminder no longer time-valid, client already rebooked,
   * marketing consent withdrawn since it was queued).
   */
  async escalateFromEvent(
    event: NotificationEventRow | string,
    failedChannel: DeliveryChannel,
    reason: string,
    now: Date = new Date(),
  ): Promise<DeliveryChannel | null> {
    const row = typeof event === 'string' ? await this.messaging.findEvent(event) : event;
    if (!row) return null;

    const subject = await this.subjects.resolve(row);
    if (!subject) return null;

    // A fallback is a send-time decision, so it is judged by the send-time rules.
    const blocked = await subject.precheck(now, 'dispatch');
    if (blocked) return null;

    const plan = await this.messaging.resolvePlan(subject);
    return this.escalateWithSubject(row, subject, plan, failedChannel, reason, now);
  }

  /**
   * The escalation itself, for a caller that has already resolved the subject and the plan and has
   * already run the send-time precheck — the dispatcher, which did all three to make the attempt
   * that just failed. Saves re-reading the appointment and settings on every failure.
   */
  async escalateWithSubject(
    row: NotificationEventRow,
    subject: NotificationSubject,
    plan: ChannelPlan,
    failedChannel: DeliveryChannel,
    reason: string,
    now: Date = new Date(),
  ): Promise<DeliveryChannel | null> {
    const next = nextChannelAfter(plan, failedChannel);
    if (!next) return null;

    const outcome = await this.messaging.enqueueOnChannel({
      businessId: row.business_id,
      locationId: row.location_id,
      clientProfileId: row.client_profile_id,
      appointmentId: row.appointment_id,
      channel: next,
      eventKey: row.event_key,
      scheduledFor: now,
      payload: {
        ...(row.payload_json ?? {}),
        ...subject.payloadSnapshot(),
        event_key: row.event_key,
        channel: next,
        fallback: true,
        primary_channel: failedChannel,
        fallback_reason: reason,
        generated_at: now.toISOString(),
      },
      dedupeKey: row.dedupe_key ?? null,
      // THE CHAIN'S IDENTITY (0108). The fallback inherits the ORIGINAL's root —
      // `row.root_event_id ?? row.id` — so a three-hop WhatsApp -> SMS -> Email
      // chain carries one root rather than each hop pointing at its predecessor.
      // For a message with a dedupe key or an appointment this changes nothing,
      // because those branches already win; it is what stops a message with
      // NEITHER from becoming a new logical message, and a new billed unit, on
      // every hop.
      rootEventId: row.root_event_id ?? row.id,
    });

    // The handover is what makes the source event `fallback_pending`, so every route into a
    // fallback records it: the dispatcher's synchronous ineligibility and terminal-failure paths,
    // and the asynchronous Twilio/Resend delivery callbacks alike. Marking it here rather than in
    // each caller is why an async provider failure no longer leaves the event reading `failed` while
    // its successor is still in flight.
    await this.messaging.markFallbackPending(row.id, `${reason}; fell back to ${next}`);

    if (outcome.status === 'duplicate') return next; // fallback already exists — idempotent.
    this.logger.log(
      `${next} fallback queued for event ${row.id} / ${row.event_key} (after ${failedChannel} ${reason})`,
    );
    return next;
  }
}
