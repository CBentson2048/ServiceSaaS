import { ConflictException, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type RebookSource = 'stylist' | 'client';

interface VisitRebookingCandidateRow {
  id: string;
  business_id: string;
  location_id: string;
  appointment_id: string | null;
  client_profile_id: string;
  primary_staff_profile_id: string | null;
  status: string;
  completed_at: string | null;
  started_at: string | null;
  checked_in_at: string | null;
  created_at: string;
}

interface AppointmentRebookingCandidateRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string;
  assigned_staff_profile_id: string | null;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
}

interface RebookingOutcomeRow {
  id: string;
  business_id?: string;
  location_id?: string;
  source_visit_id: string;
  rebooked_appointment_id: string;
  rebook_source: RebookSource;
}

interface LinkRebookingInput {
  businessId: string;
  sourceVisitId: string;
  rebookedAppointmentId: string;
  source: RebookSource;
  rebookedByUserProfileId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class RebookingService {
  private readonly logger = new Logger(RebookingService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async linkPersistedAppointment(input: LinkRebookingInput): Promise<RebookingOutcomeRow | undefined> {
    const [sourceVisit, followUp] = await Promise.all([
      this.fetchSourceVisit(input.businessId, input.sourceVisitId),
      this.fetchFollowUpAppointment(input.businessId, input.rebookedAppointmentId),
    ]);

    if (sourceVisit.client_profile_id !== followUp.client_profile_id) {
      throw new ConflictException('Rebooking appointment must belong to the same client as the source visit');
    }
    if (sourceVisit.location_id !== followUp.location_id) {
      throw new ConflictException('Rebooking appointment must belong to the same location as the source visit');
    }
    if (sourceVisit.appointment_id && sourceVisit.appointment_id === followUp.id) {
      throw new ConflictException('Source appointment cannot be linked as its own rebooking');
    }
    if (!isCompletedSourceVisit(sourceVisit)) {
      throw new ConflictException('Only completed or paid visits can be credited for rebooking');
    }
    if (!isValidFollowUpAppointment(followUp)) {
      throw new ConflictException('Only real active future appointments can be linked as rebookings');
    }
    if (new Date(followUp.scheduled_start_at).getTime() <= sourceVisitTime(sourceVisit).getTime()) {
      throw new ConflictException('Rebooking appointment must be after the completed source visit');
    }

    const existing = await this.fetchOutcomeForSourceVisit(sourceVisit.id);
    if (existing) {
      if (existing.rebooked_appointment_id !== followUp.id) {
        throw new ConflictException('Source visit already has a linked rebooking appointment');
      }
      return existing;
    }

    const { data, error } = await this.admin
      .schema('booking')
      .from('rebooking_outcomes')
      .insert({
        business_id: sourceVisit.business_id,
        location_id: sourceVisit.location_id,
        source_visit_id: sourceVisit.id,
        source_appointment_id: sourceVisit.appointment_id,
        source_client_profile_id: sourceVisit.client_profile_id,
        source_staff_profile_id: sourceVisit.primary_staff_profile_id,
        rebooked_appointment_id: followUp.id,
        rebook_source: input.source,
        rebooked_by_user_profile_id: input.rebookedByUserProfileId ?? null,
        metadata: input.metadata ?? {},
      })
      .select('id,source_visit_id,rebooked_appointment_id,rebook_source')
      .maybeSingle<RebookingOutcomeRow>();

    if (error) {
      if (error.message.toLowerCase().includes('duplicate')) {
        const replayed = await this.fetchOutcomeForSourceVisit(sourceVisit.id);
        if (replayed?.rebooked_appointment_id === followUp.id) return replayed;
        throw new ConflictException('Source visit already has a linked rebooking appointment');
      }
      this.logger.error(`linkPersistedAppointment failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to record rebooking outcome');
    }
    return data ?? undefined;
  }

  async linkLatestEligibleClientVisit(input: {
    businessId: string;
    clientProfileId: string;
    rebookedAppointmentId: string;
    rebookedByUserProfileId?: string | null;
    source: RebookSource;
    metadata?: Record<string, unknown>;
  }): Promise<RebookingOutcomeRow | undefined> {
    const followUp = await this.fetchFollowUpAppointment(input.businessId, input.rebookedAppointmentId);
    if (followUp.client_profile_id !== input.clientProfileId) return undefined;
    if (!isValidFollowUpAppointment(followUp)) return undefined;

    const sourceVisit = await this.fetchLatestUnlinkedCompletedVisitForClient({
      businessId: input.businessId,
      clientProfileId: input.clientProfileId,
      beforeAppointmentStartAt: followUp.scheduled_start_at,
      followUpAppointmentId: followUp.id,
    });
    if (!sourceVisit) return undefined;

    return this.linkPersistedAppointment({
      businessId: input.businessId,
      sourceVisitId: sourceVisit.id,
      rebookedAppointmentId: followUp.id,
      source: input.source,
      rebookedByUserProfileId: input.rebookedByUserProfileId,
      metadata: input.metadata,
    });
  }

  private async fetchSourceVisit(
    businessId: string,
    sourceVisitId: string,
  ): Promise<VisitRebookingCandidateRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(
        'id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,completed_at,started_at,checked_in_at,created_at',
      )
      .eq('id', sourceVisitId)
      .eq('business_id', businessId)
      .maybeSingle<VisitRebookingCandidateRow>();

    if (error) {
      this.logger.error(`fetchSourceVisit failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load source visit');
    }
    if (!data) throw new ConflictException('Source visit was not found');
    return data;
  }

  private async fetchFollowUpAppointment(
    businessId: string,
    appointmentId: string,
  ): Promise<AppointmentRebookingCandidateRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id,business_id,location_id,client_profile_id,assigned_staff_profile_id,status,scheduled_start_at,scheduled_end_at')
      .eq('id', appointmentId)
      .eq('business_id', businessId)
      .maybeSingle<AppointmentRebookingCandidateRow>();

    if (error) {
      this.logger.error(`fetchFollowUpAppointment failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load rebooking appointment');
    }
    if (!data) throw new ConflictException('Rebooking appointment was not found');
    return data;
  }

  private async fetchLatestUnlinkedCompletedVisitForClient(input: {
    businessId: string;
    clientProfileId: string;
    beforeAppointmentStartAt: string;
    followUpAppointmentId: string;
  }): Promise<VisitRebookingCandidateRow | undefined> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(
        'id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,completed_at,started_at,checked_in_at,created_at',
      )
      .eq('business_id', input.businessId)
      .eq('client_profile_id', input.clientProfileId)
      .in('status', ['completed', 'awaiting_payment', 'paid'])
      .lt('completed_at', input.beforeAppointmentStartAt)
      .order('completed_at', { ascending: false })
      .limit(10)
      .returns<VisitRebookingCandidateRow[]>();

    if (error) {
      this.logger.error(`fetchLatestUnlinkedCompletedVisitForClient failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load eligible source visit');
    }

    const candidates = data ?? [];
    if (candidates.length === 0) return undefined;

    const linkedVisitIds = await this.fetchLinkedSourceVisitIds(candidates.map((row) => row.id));
    return candidates.find(
      (row) => !linkedVisitIds.has(row.id) && row.appointment_id !== input.followUpAppointmentId,
    );
  }

  private async fetchLinkedSourceVisitIds(sourceVisitIds: string[]): Promise<Set<string>> {
    if (sourceVisitIds.length === 0) return new Set();
    const { data, error } = await this.admin
      .schema('booking')
      .from('rebooking_outcomes')
      .select('source_visit_id')
      .in('source_visit_id', sourceVisitIds)
      .returns<Array<{ source_visit_id: string }>>();

    if (error) {
      this.logger.error(`fetchLinkedSourceVisitIds failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load existing rebooking outcomes');
    }
    return new Set((data ?? []).map((row) => row.source_visit_id));
  }

  private async fetchOutcomeForSourceVisit(sourceVisitId: string): Promise<RebookingOutcomeRow | undefined> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('rebooking_outcomes')
      .select('id,source_visit_id,rebooked_appointment_id,rebook_source')
      .eq('source_visit_id', sourceVisitId)
      .maybeSingle<RebookingOutcomeRow>();

    if (error) {
      this.logger.error(`fetchOutcomeForSourceVisit failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load existing rebooking outcome');
    }
    return data ?? undefined;
  }
}

function isCompletedSourceVisit(row: VisitRebookingCandidateRow): boolean {
  return (
    (row.status === 'completed' || row.status === 'awaiting_payment' || row.status === 'paid') &&
    Boolean(row.completed_at)
  );
}

function isValidFollowUpAppointment(row: AppointmentRebookingCandidateRow): boolean {
  if (row.status === 'cancelled' || row.status === 'no_show') return false;
  return new Date(row.scheduled_start_at).getTime() > Date.now() && row.scheduled_end_at !== row.scheduled_start_at;
}

function sourceVisitTime(row: VisitRebookingCandidateRow): Date {
  return new Date(row.completed_at ?? row.started_at ?? row.checked_in_at ?? row.created_at);
}
