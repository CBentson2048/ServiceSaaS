import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CommunicationPreference } from '@sheer/domain';
import type { ContactEligibility, DeliveryChannel } from '../channel-policy';
import {
  readMessageClass,
  readSnapshotContent,
  type MessageClass,
  type NotificationEventRow,
  type NotificationSubject,
  type NotificationSubjectResolver,
  type RenderedChannelMessage,
  type SnapshotContent,
  type SubjectPrecheckFailure,
} from '../notification-subject';
import { isValidEmail, normalizeE164 } from '../phone';

interface ClientRow {
  first_name: string | null;
  phone: string | null;
  email: string | null;
  communication_preference: string | null;
  marketing_opt_in: boolean | null;
}

/**
 * Messages addressed to a client rather than to an appointment: marketing campaigns, retention
 * win-backs, client-intelligence alerts.
 *
 * Content is **snapshotted into `payload_json.content` at enqueue time** rather than re-rendered from
 * a template registry at send time. A campaign body is composed once, by the caller that knows what
 * it wants to say, and the exact text that was queued is the exact text that is sent — including on a
 * fallback channel days later. That keeps a sent campaign reproducible and auditable, and avoids a
 * second template system living alongside the approved booking templates.
 */
@Injectable()
export class ClientSubjectResolver implements NotificationSubjectResolver {
  readonly kind = 'client' as const;
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  supports(event: NotificationEventRow): boolean {
    return !event.appointment_id && Boolean(event.client_profile_id);
  }

  async resolve(event: NotificationEventRow): Promise<NotificationSubject | null> {
    if (!event.client_profile_id) return null;
    const content = readSnapshotContent(event.payload_json);
    // No snapshot means nothing to send. Rendering an empty body would be a silent lie; the caller
    // must supply content at enqueue time (MessagingService enforces this on the way in).
    if (!content) return null;

    const [client, location] = await Promise.all([
      this.admin
        .schema('core')
        .from('client_profiles')
        .select('first_name,phone,email,communication_preference,marketing_opt_in')
        .eq('id', event.client_profile_id)
        .maybeSingle<ClientRow>(),
      this.admin
        .schema('core')
        .from('locations')
        .select('name,timezone')
        .eq('id', event.location_id)
        .maybeSingle<{ name: string; timezone: string }>(),
    ]);

    if (client.error) throw new Error(`load client failed: ${client.error.message}`);
    if (location.error) throw new Error(`load location failed: ${location.error.message}`);
    if (!client.data) return null;

    return new ClientSubject(event, content, client.data, location.data?.name ?? 'our salon');
  }
}

class ClientSubject implements NotificationSubject {
  readonly kind = 'client' as const;

  constructor(
    private readonly event: NotificationEventRow,
    private readonly content: SnapshotContent,
    private readonly client: ClientRow,
    private readonly locationName: string,
  ) {}

  get messageClass(): MessageClass {
    return readMessageClass(this.event.payload_json);
  }

  get businessId(): string {
    return this.event.business_id;
  }

  get locationId(): string {
    return this.event.location_id;
  }

  get clientProfileId(): string | null {
    return this.event.client_profile_id;
  }

  get preference(): CommunicationPreference | null {
    return (this.client.communication_preference as CommunicationPreference | null) ?? null;
  }

  get phone(): string | null {
    return this.client.phone;
  }

  get email(): string | null {
    return this.client.email;
  }

  contact(): ContactEligibility {
    return {
      phoneValid: Boolean(normalizeE164(this.client.phone)),
      emailValid: isValidEmail(this.client.email),
    };
  }

  /**
   * Marketing consent is re-checked at send time, not only at enqueue time: a campaign queued today
   * may not deliver until a fallback fires days later, and a client who withdrew consent in between
   * must not receive it.
   */
  async precheck(): Promise<SubjectPrecheckFailure | null> {
    if (readMessageClass(this.event.payload_json) === 'marketing' && this.client.marketing_opt_in !== true) {
      return { cancel: true, reason: 'client has not opted in to marketing', logSkip: true };
    }
    return null;
  }

  /** The content snapshot travels with every fallback, so a later channel sends the same message. */
  payloadSnapshot(): Record<string, unknown> {
    return {
      content: this.content,
      message_class: readMessageClass(this.event.payload_json),
    };
  }

  render(channel: DeliveryChannel): RenderedChannelMessage {
    const preview = this.content.preview ?? this.content.body.slice(0, 120);
    if (channel === 'email') {
      return {
        body: this.content.body,
        preview,
        subject: this.content.subject ?? `A message from ${this.locationName}`,
        html: this.content.html ?? `<p>${escapeHtml(this.content.body)}</p>`,
        text: this.content.text ?? this.content.body,
        templateVariables: this.content.template_variables ?? {},
      };
    }
    return {
      body: this.content.body,
      preview,
      templateId: channel === 'whatsapp' ? this.content.template_id : undefined,
      templateVariables: this.content.template_variables ?? {},
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
