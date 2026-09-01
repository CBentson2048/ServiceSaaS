import type { CommunicationPreference } from '@sheer/domain';
import type { ContactEligibility, DeliveryChannel } from './channel-policy';

/**
 * The `comms.notification_events` row shape the dispatcher, the escalation service and the subject
 * resolvers all agree on. Kept in one place so the queue contract is stated once.
 */
export interface NotificationEventRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string | null;
  appointment_id: string | null;
  channel: string;
  event_key: string;
  status: string;
  scheduled_for: string | null;
  attempts: number;
  message_log_id: string | null;
  payload_json: Record<string, unknown> | null;
  dedupe_key?: string | null;
}

/** Column list for {@link NotificationEventRow} — used by every reader of the queue. */
export const NOTIFICATION_EVENT_COLUMNS =
  'id,business_id,location_id,client_profile_id,appointment_id,channel,event_key,status,scheduled_for,attempts,message_log_id,payload_json,dedupe_key';

/** One channel's rendered content. Channels read only the fields that apply to them. */
export interface RenderedChannelMessage {
  /** Plain body (WhatsApp freeform / SMS / email text alternative). */
  body: string;
  /** Single-line summary stored in `comms.message_logs.content_preview`. */
  preview: string;
  subject?: string;
  html?: string;
  text?: string;
  /** Approved Twilio Content template SID, when one is configured for this message. */
  templateId?: string;
  /** Positional Content template variables for {@link templateId}. */
  templateVariables: Record<string, string>;
}

/**
 * When a precheck runs. `enqueue` guards queue writes; `dispatch` guards the actual send (and the
 * fallback that follows one). Some suppressions are deliberately send-time only — a rebooking nudge
 * is scheduled weeks ahead and is judged against the client's state when it fires, not when it was
 * queued.
 */
export type SubjectPrecheckPhase = 'enqueue' | 'dispatch';

/** Why an event must be retired before sending. `logSkip` records a truthful skipped attempt first. */
export interface SubjectPrecheckFailure {
  cancel: true;
  reason: string;
  logSkip?: boolean;
}

/**
 * What a queued message is *about*, independent of whether that is an appointment.
 *
 * The dispatcher used to reach straight into `booking.appointments`, which made an appointment id a
 * hard precondition for delivering anything at all. Everything it actually needs is behind this
 * interface: who the recipient is, whether the message is still warranted, and how it renders on a
 * given channel. Campaigns and client-intelligence alerts implement the same interface and therefore
 * travel the identical WhatsApp → SMS → Email chain, queue, retry and logging path.
 */
export interface NotificationSubject {
  readonly kind: NotificationSubjectKind;
  /**
   * Transactional or marketing. Marketing carries stricter rules: it requires
   * `core.client_profiles.marketing_opt_in`, and it is withheld rather than guessed at when the
   * opt-out record cannot be read.
   */
  readonly messageClass: MessageClass;
  readonly businessId: string;
  readonly locationId: string;
  readonly clientProfileId: string | null;
  readonly preference: CommunicationPreference | null;
  /** Recipient phone in raw form (normalised at send time). */
  readonly phone: string | null;
  readonly email: string | null;
  /**
   * Address validity for this recipient. Opt-outs are NOT included — the caller loads those and
   * merges them in, so this stays a pure property of the contact details.
   */
  contact(): ContactEligibility;
  /**
   * Reasons to retire the event before sending — appointment cancelled/rescheduled, the client
   * already rebooked, marketing consent withdrawn. `null` means proceed.
   */
  precheck(now: Date, phase: SubjectPrecheckPhase): Promise<SubjectPrecheckFailure | null>;
  render(channel: DeliveryChannel): RenderedChannelMessage;
  /**
   * Subject-owned fields that must be present on every event generated for this subject, including
   * a fallback queued days after the original. For an appointment that is the start-time snapshot
   * the staleness check compares against; for a client message it is the content snapshot and the
   * message class, without which a fallback event would have nothing to send.
   */
  payloadSnapshot(): Record<string, unknown>;
}

export type NotificationSubjectKind = 'appointment' | 'client';

/** Resolves a queue row into the thing it is about. One implementation per {@link NotificationSubjectKind}. */
export interface NotificationSubjectResolver {
  readonly kind: NotificationSubjectKind;
  /** True when this resolver owns the row. */
  supports(event: NotificationEventRow): boolean;
  /** Null when the subject no longer exists (deleted appointment, deleted client) — the event is retired. */
  resolve(event: NotificationEventRow): Promise<NotificationSubject | null>;
}

/** Transactional messages always send; marketing messages require `core.client_profiles.marketing_opt_in`. */
export type MessageClass = 'transactional' | 'marketing';

/** Content snapshotted into `payload_json.content` at enqueue time for non-appointment messages. */
export interface SnapshotContent {
  body: string;
  preview?: string;
  subject?: string;
  html?: string;
  text?: string;
  template_id?: string;
  template_variables?: Record<string, string>;
}

/** Read the enqueue-time content snapshot off an event payload. */
export function readSnapshotContent(payload: Record<string, unknown> | null): SnapshotContent | null {
  const raw = payload?.['content'];
  if (!raw || typeof raw !== 'object') return null;
  const content = raw as Record<string, unknown>;
  if (typeof content['body'] !== 'string' || content['body'].trim().length === 0) return null;
  return {
    body: content['body'],
    preview: typeof content['preview'] === 'string' ? content['preview'] : undefined,
    subject: typeof content['subject'] === 'string' ? content['subject'] : undefined,
    html: typeof content['html'] === 'string' ? content['html'] : undefined,
    text: typeof content['text'] === 'string' ? content['text'] : undefined,
    template_id: typeof content['template_id'] === 'string' ? content['template_id'] : undefined,
    template_variables: isStringRecord(content['template_variables'])
      ? (content['template_variables'] as Record<string, string>)
      : undefined,
  };
}

/** The message class recorded on an event payload (defaults to transactional). */
export function readMessageClass(payload: Record<string, unknown> | null): MessageClass {
  return payload?.['message_class'] === 'marketing' ? 'marketing' : 'transactional';
}

/** The canonical chain order. Must match CANONICAL_ORDER in channel-policy.ts. */
const CANONICAL_PREFERENCE_ORDER: CommunicationPreference[] = ['whatsapp', 'sms', 'email'];

/**
 * A caller-supplied narrowing of the delivery chain, snapshotted onto the event
 * payload at enqueue time (`payload_json.channel_preference`).
 *
 * Campaigns need this: an owner may configure a campaign to go out by email only.
 * It is stored on the EVENT rather than passed at send time so it survives into
 * every fallback the dispatcher later queues for the same message — otherwise a
 * WhatsApp-excluded campaign could escalate onto WhatsApp days later.
 */
export function readChannelPreference(
  payload: Record<string, unknown> | null,
): CommunicationPreference | null {
  const raw = payload?.['channel_preference'];
  return CANONICAL_PREFERENCE_ORDER.includes(raw as CommunicationPreference)
    ? (raw as CommunicationPreference)
    : null;
}

/**
 * The more RESTRICTIVE of two starting points in the WhatsApp → SMS → Email
 * chain — the one further down it.
 *
 * Narrow-only by construction. A caller's preference can remove channels from a
 * client's chain but can never move the client back up it: a client who has
 * chosen email is never messaged on WhatsApp because a campaign asked for
 * WhatsApp. This is what stops a campaign becoming a second channel policy.
 */
export function narrowerPreference(
  a: CommunicationPreference | null | undefined,
  b: CommunicationPreference | null | undefined,
): CommunicationPreference | null {
  const ia = a ? CANONICAL_PREFERENCE_ORDER.indexOf(a) : -1;
  const ib = b ? CANONICAL_PREFERENCE_ORDER.indexOf(b) : -1;
  const i = Math.max(ia, ib);
  return i < 0 ? null : CANONICAL_PREFERENCE_ORDER[i];
}

function isStringRecord(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
  );
}
