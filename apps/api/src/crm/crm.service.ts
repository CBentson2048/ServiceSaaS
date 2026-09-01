import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  FormulaChangeAssessment,
  AuthUser,
  ClientDuplicateGroup,
  CreateCrmAllergyRecordRequest,
  CreateCrmClientNoteRequest,
  CreateCrmClientRequest,
  CreateCrmPatchTestRequest,
  CreateCrmVisitPhotoRequest,
  CrmAllergyRecord,
  CrmClientDetailResponse,
  CrmClientFormula,
  CrmClientNote,
  CrmClientProfile,
  CrmClientSearchResult,
  CrmClientsPagination,
  CrmClientSummary,
  CrmMessageLog,
  CrmPatchTestRecord,
  CrmVisitPhoto,
  CrmVisitSummary,
  ListCrmClientAllergiesResponse,
  ListCrmClientMessagesResponse,
  ListCrmClientNotesResponse,
  ListCrmClientPatchTestsResponse,
  ListCrmClientVisitsResponse,
  ListCrmClientsResponse,
  ListCrmVisitPhotosResponse,
  ListClientDuplicatesResponse,
  MergeClientsResponse,
  SearchCrmClientsResponse,
  UpdateCrmClientRequest,
} from '@sheer/domain';
import { userHasRole, userHasAnyRole } from '@sheer/domain';
import type { ListCrmClientsQueryDto, SearchCrmClientsQueryDto } from './dto';
import { AuditService } from '../audit/audit.service';
import { FormulaChangeService } from '../formula-change/formula-change.service';
import {
  LabFormulaService,
  type LabClientFormulaHistoryRecord,
} from '../lab-formula/lab-formula.service';

interface ClientProfileRow {
  id: string;
  business_id: string;
  client_code: string;
  user_profile_id: string | null;
  primary_location_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  communication_preference: string | null;
  notes: string | null;
  marketing_opt_in: boolean;
  source: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Row shape returned by the `crm.search_clients` RPC (migration 0083). */
interface ClientSearchRpcRow {
  id: string;
  client_code: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  primary_location_id: string | null;
  rank: number;
  /** Full match count for the term, windowed onto every returned row. */
  total_count: number;
}

interface AppointmentVisitRow {
  id?: string;
  business_id?: string;
  location_id?: string;
  client_profile_id?: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  status: string;
  assigned_staff_profile_id: string | null;
  appointment_services:
    | Array<{ service_name_snapshot: string; price_amount: number | string }>
    | { service_name_snapshot: string; price_amount: number | string }
    | null;
}

interface VisitRow {
  id: string;
  business_id: string;
  location_id: string;
  appointment_id: string | null;
  client_profile_id: string;
  primary_staff_profile_id: string | null;
  status: string;
  checked_in_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  service_summary: string | null;
  client_visible_summary: string | null;
  created_at: string;
  appointments?: AppointmentVisitRow | AppointmentVisitRow[] | null;
  rebooking_outcomes?: RebookingOutcomeRelation | RebookingOutcomeRelation[] | null;
}

interface RebookingOutcomeRelation {
  id: string;
  rebooked_appointment_id: string;
  rebook_source: 'stylist' | 'client';
  rebooked_at: string;
}

interface AppointmentHistoryRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string;
  assigned_staff_profile_id: string | null;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  completed_at: string | null;
  appointment_services:
    | Array<{ service_name_snapshot: string; price_amount: number | string }>
    | { service_name_snapshot: string; price_amount: number | string }
    | null;
}

interface StaffNameRow {
  id: string;
  display_name: string | null;
}

interface PaymentRow {
  visit_id: string | null;
  appointment_id: string | null;
  amount_cents: number | string | null;
  currency_code: string | null;
}

interface DepositRow {
  appointment_id: string | null;
  amount: number | string | null;
  currency_code: string | null;
  paid_at: string | null;
}

interface NoteRow {
  id: string;
  business_id: string;
  location_id: string | null;
  client_profile_id: string;
  visit_id: string | null;
  note_type: CrmClientNote['noteType'];
  content: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AllergyRow {
  id: string;
  business_id: string;
  client_profile_id: string;
  allergen_name: string;
  severity: CrmAllergyRecord['severity'];
  notes: string | null;
  is_active: boolean;
  recorded_at: string;
  recorded_by_user_id: string | null;
}

interface PatchTestRow {
  id: string;
  business_id: string;
  location_id: string | null;
  client_profile_id: string;
  performed_at: string;
  expires_at: string | null;
  status: CrmPatchTestRecord['status'];
  notes: string | null;
  recorded_by_user_id: string | null;
  created_at: string;
}

interface MessageRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string | null;
  appointment_id: string | null;
  visit_id: string | null;
  channel: CrmMessageLog['channel'];
  message_type: string | null;
  delivery_status: CrmMessageLog['deliveryStatus'];
  provider: string | null;
  provider_message_id: string | null;
  provider_status: string | null;
  recipient: string | null;
  template_key: string | null;
  content_preview: string | null;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  created_at: string;
}

interface PhotoRow {
  id: string;
  business_id: string;
  location_id: string;
  visit_id: string;
  client_profile_id: string;
  photo_type: CrmVisitPhoto['photoType'];
  storage_bucket: string;
  storage_path: string;
  mime_type: string | null;
  uploaded_by_user_id: string | null;
  created_at: string;
}

interface GdprRequestRow {
  id: string;
  request_type: string;
  status: string;
}

const CLIENT_COLUMNS =
  'id,business_id,client_code,user_profile_id,primary_location_id,first_name,last_name,email,phone,date_of_birth,communication_preference,notes,marketing_opt_in,source,tags,metadata,created_at,updated_at';

// Default preserves the previous hard cap so the staff booking client search
// (which reuses listClients without a pageSize) behaves exactly as before.
const DEFAULT_CLIENTS_PAGE_SIZE = 50;
const MAX_CLIENTS_PAGE_SIZE = 100;

// The typeahead palette shows a short list; its endpoint still supports real
// pagination for any consumer that wants to walk the full match set.
const DEFAULT_SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_PAGE_SIZE = 50;

type CrmStaffScope = 'owner' | 'manager' | 'stylist';

@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly labFormulas: LabFormulaService,
    private readonly audit: AuditService,
    private readonly formulaChange: FormulaChangeService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async listClients(
    actor: AuthUser,
    query: ListCrmClientsQueryDto,
  ): Promise<ListCrmClientsResponse> {
    this.assertStaffRole(actor);
    const requestedLocationId = query.locationId;
    if (requestedLocationId) this.assertLocationScope(actor, requestedLocationId);

    const pageSize = clampInt(query.pageSize ?? DEFAULT_CLIENTS_PAGE_SIZE, 1, MAX_CLIENTS_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(query.page ?? 1));

    const locationIds = this.resolveReadableLocationIds(actor, requestedLocationId);
    if (locationIds && locationIds.length === 0) {
      return {
        clients: [],
        scope: crmScope(actor),
        pagination: buildClientsPagination(0, page, pageSize),
      };
    }

    const search = query.q?.trim();
    if (search) {
      // Index-backed fuzzy path (migration 0083): the RPC returns rank-ordered
      // ids plus the exact total; full rows and enrichment are then hydrated in
      // rank order so the response shape is identical to the browse path. This
      // replaces the old five-column leading-wildcard ILIKE, which could not
      // use an index and missed reformatted phone numbers and misspellings.
      const { rows: matches, total } = await this.runClientSearch(
        actor.businessId,
        locationIds ?? null,
        search,
        pageSize,
        (page - 1) * pageSize,
      );
      const rows = await this.fetchClientRowsByIds(
        actor.businessId,
        matches.map((match) => match.id),
      );
      return {
        clients: await this.buildClientSummaries(actor.businessId, rows),
        scope: crmScope(actor),
        pagination: buildClientsPagination(total, page, pageSize),
      };
    }

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    let request = this.admin
      .schema('core')
      .from('client_profiles')
      // `count: 'exact'` returns the total matching rows (ignoring the range)
      // so the client can render real pagination, not just the current slice.
      .select(CLIENT_COLUMNS, { count: 'exact' })
      .eq('business_id', actor.businessId)
      // Tombstoned (merged) profiles stay out of every list.
      .is('merged_into_id', null)
      .order('updated_at', { ascending: false })
      .range(from, to);
    if (locationIds) request = request.in('primary_location_id', locationIds);

    const { data, error, count } = await request.returns<ClientProfileRow[]>();
    if (error) {
      this.logger.error(`listClients failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load CRM clients');
    }

    const rows = data ?? [];
    return {
      clients: await this.buildClientSummaries(actor.businessId, rows),
      scope: crmScope(actor),
      pagination: buildClientsPagination(count ?? rows.length, page, pageSize),
    };
  }

  /**
   * Lean typeahead behind the global search palette. Same scoping rules as
   * {@link listClients} but skips the visit/alert enrichment fan-out — the
   * palette refetches on every keystroke, so this stays one indexed query.
   */
  async searchClients(
    actor: AuthUser,
    query: SearchCrmClientsQueryDto,
  ): Promise<SearchCrmClientsResponse> {
    this.assertStaffRole(actor);
    if (query.locationId) this.assertLocationScope(actor, query.locationId);

    const pageSize = clampInt(query.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE, 1, MAX_SEARCH_PAGE_SIZE);
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const term = query.q.trim();
    const locationIds = this.resolveReadableLocationIds(actor, query.locationId);
    if (!term || (locationIds && locationIds.length === 0)) {
      return { results: [], pagination: buildClientsPagination(0, page, pageSize) };
    }

    const { rows, total } = await this.runClientSearch(
      actor.businessId,
      locationIds ?? null,
      term,
      pageSize,
      (page - 1) * pageSize,
    );
    return {
      results: rows.map(toClientSearchResult),
      pagination: buildClientsPagination(total, page, pageSize),
    };
  }

  /**
   * Calls the `crm.search_clients` RPC (0083). The total arrives windowed onto
   * every row, so a beyond-the-end page returns no rows and therefore no total;
   * a one-row probe at offset 0 recovers the real count in that case, keeping
   * pagination truthful instead of collapsing to zero.
   */
  private async runClientSearch(
    businessId: string,
    locationIds: string[] | null,
    term: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: ClientSearchRpcRow[]; total: number }> {
    const call = async (callLimit: number, callOffset: number) => {
      const { data, error } = await this.admin.schema('crm').rpc('search_clients', {
        p_business_id: businessId,
        p_location_ids: locationIds,
        p_term: term,
        p_limit: callLimit,
        p_offset: callOffset,
      });
      if (error) {
        this.logger.error(`search_clients RPC failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to search clients');
      }
      return (data ?? []) as ClientSearchRpcRow[];
    };

    const rows = await call(limit, offset);
    if (rows.length > 0) return { rows, total: Number(rows[0].total_count) };
    if (offset === 0) return { rows, total: 0 };
    const probe = await call(1, 0);
    return { rows, total: probe.length > 0 ? Number(probe[0].total_count) : 0 };
  }

  /** Hydrates full client rows for the given ids, preserving the ids' order. */
  private async fetchClientRowsByIds(
    businessId: string,
    ids: string[],
  ): Promise<ClientProfileRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<ClientProfileRow[]>();
    if (error) {
      this.logger.error(`fetchClientRowsByIds failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load CRM clients');
    }
    const byId = new Map((data ?? []).map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)).filter((row): row is ClientProfileRow => Boolean(row));
  }

  /** Enriches raw client rows with last-visit and alert counts. */
  private async buildClientSummaries(
    businessId: string,
    rows: ClientProfileRow[],
  ): Promise<CrmClientSummary[]> {
    const [lastVisitByClient, allergyCounts, expiredPatchCounts] = await Promise.all([
      this.fetchLastVisitByClient(businessId, rows.map((row) => row.id)),
      this.fetchActiveAllergyCounts(businessId, rows.map((row) => row.id)),
      this.fetchExpiredPatchCounts(businessId, rows.map((row) => row.id)),
    ]);
    return rows.map((row) =>
      toClientSummary(row, {
        lastVisitAt: lastVisitByClient.get(row.id),
        activeAllergies: allergyCounts.get(row.id) ?? 0,
        expiredPatchTests: expiredPatchCounts.get(row.id) ?? 0,
      }),
    );
  }

  async createClient(
    actor: AuthUser,
    input: CreateCrmClientRequest,
  ): Promise<{ client: CrmClientSummary }> {
    this.assertManagerOrOwner(actor);
    return this.persistClient(actor, input);
  }

  /**
   * Quick-create used by the staff booking flow. Unlike {@link createClient}
   * (full CRM management, owner/manager only) this also allows stylists to
   * register a walk-in / phone client at the point of booking. Still scoped to
   * the actor's locations and blocked for client-role users.
   */
  async createClientForBooking(
    actor: AuthUser,
    input: CreateCrmClientRequest,
  ): Promise<{ client: CrmClientSummary }> {
    this.assertStaffRole(actor);
    return this.persistClient(actor, input);
  }

  private async persistClient(
    actor: AuthUser,
    input: CreateCrmClientRequest,
  ): Promise<{ client: CrmClientSummary }> {
    const locationId = this.resolveWriteLocation(actor, input.primaryLocationId);
    // A scoped (non-owner) actor whose location can't be resolved would otherwise
    // be written with primary_location_id = NULL. listClients filters non-owners
    // by `primary_location_id IN (allowedLocationIds)` (NULL never matches) and
    // fetchClientForActor rejects a NULL-location row, so the creator would never
    // see or open the client they just made. Fail loudly instead of orphaning it.
    // resolveWriteLocation auto-assigns the sole location for single-location
    // actors, so this only triggers for multi-location managers/stylists who did
    // not choose one. Owners intentionally may create unscoped clients.
    if (!locationId && !userHasRole(actor, 'owner')) {
      throw new BadRequestException('primaryLocationId is required');
    }
    if (locationId) this.assertLocationScope(actor, locationId);

    const email = cleanOptional(input.email, { lowercase: true });
    const phone = cleanOptional(input.phone);

    // A stored preference that names a channel the client can't be reached on
    // makes booking notifications silently undeliverable. Reject it up front.
    assertPreferenceReachable(input.communicationPreference ?? null, email, phone);

    // Guard against silently creating a second profile for the same person.
    // client_profile_id is the join key for the whole footprint (visits, notes,
    // allergies, patch tests, messages), so a duplicate splits history and,
    // worse, hides allergy/patch-test alerts. Staff can override for a genuine
    // shared-inbox / shared-phone case via allowDuplicate. Phone matches too:
    // the till flow often has ONLY a phone number, and the phone is the
    // strongest identity signal a walk-in gives.
    if (!input.allowDuplicate) {
      if (email) {
        const existing = await this.findClientByEmail(actor.businessId, email);
        if (existing) throw duplicateClientConflict(existing, 'email');
      }
      if (phone) {
        const existing = await this.findClientByPhone(actor.businessId, phone);
        if (existing) throw duplicateClientConflict(existing, 'phone');
      }
    }

    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .insert({
        business_id: actor.businessId,
        primary_location_id: locationId ?? null,
        first_name: cleanRequired(input.firstName, 'firstName'),
        last_name: cleanRequired(input.lastName, 'lastName'),
        email,
        phone,
        communication_preference: input.communicationPreference ?? null,
        marketing_opt_in: input.marketingOptIn ?? false,
        source: cleanOptional(input.source) ?? 'crm_manual',
        created_by_user_profile_id: actor.id,
      })
      .select(CLIENT_COLUMNS)
      .single<ClientProfileRow>();

    if (error || !data) {
      this.logger.error(`createClient failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create CRM client');
    }

    return { client: toClientSummary(data) };
  }

  async getClientDetail(actor: AuthUser, clientId: string): Promise<CrmClientDetailResponse> {
    const client = await this.fetchClientForActor(actor, clientId);
    const [
      notes,
      visits,
      formulas,
      allergies,
      patchTests,
      messages,
      photos,
      gdprRequests,
      activeAllergyCounts,
      expiredPatchCounts,
      lastVisitByClient,
      formulaChange,
    ] = await Promise.all([
      this.fetchNotes(actor.businessId, client.id),
      this.fetchVisitsForClient(actor.businessId, client.id),
      this.fetchClientFormulas(actor, client.id),
      this.fetchAllergies(actor.businessId, client.id),
      this.fetchPatchTests(actor.businessId, client.id),
      this.fetchMessages(actor.businessId, client.id),
      this.fetchPhotosForClient(actor.businessId, client.id),
      this.fetchGdprRequests(actor.businessId, client.id),
      this.fetchActiveAllergyCounts(actor.businessId, [client.id]),
      this.fetchExpiredPatchCounts(actor.businessId, [client.id]),
      this.fetchLastVisitByClient(actor.businessId, [client.id]),
      // Best-effort intelligence: a detection failure must not blank a client
      // record the salon needs to run the appointment (Wrike section 58).
      this.fetchFormulaChange(actor, client.id),
    ]);

    return {
      profile: toClientProfile(client, {
        lastVisitAt: lastVisitByClient.get(client.id),
        activeAllergies: activeAllergyCounts.get(client.id) ?? 0,
        expiredPatchTests: expiredPatchCounts.get(client.id) ?? 0,
        gdprRequests,
      }),
      notes,
      visits,
      formulas,
      allergies,
      patchTests,
      messages,
      photos,
      formulaChange,
    };
  }

  /**
   * The client's current formula-change assessment.
   *
   * Computed on read from live formula rows, so it always reflects the salon's
   * CURRENT sensitivity settings. Best-effort by design: if detection fails the
   * profile still renders with every other section intact, and the flag is
   * simply absent rather than the page being lost.
   */
  private async fetchFormulaChange(
    actor: AuthUser,
    clientId: string,
  ): Promise<FormulaChangeAssessment | undefined> {
    try {
      return await this.formulaChange.assessForClient(actor, clientId);
    } catch (err) {
      this.logger.error(`fetchFormulaChange failed for client ${clientId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * A client's saved colour-formula history for their staff-facing profile.
   * Reuses the durable, DB-backed {@link LabFormulaService.historyForClient}
   * (same actor scoping) and projects it to the lean CRM shape — recipe +
   * stylist only, no product cost/waste/billing. Best-effort: a lab read hiccup
   * degrades to an empty list rather than blanking the whole profile.
   */
  private async fetchClientFormulas(actor: AuthUser, clientId: string): Promise<CrmClientFormula[]> {
    try {
      // Staff-facing profile: include durable drafts (badged via isDraft).
      const records = await this.labFormulas.historyForClient(actor, clientId, { includeDrafts: true });
      return records.map(toCrmClientFormula);
    } catch (error) {
      this.logger.error(
        `fetchClientFormulas failed for client ${clientId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return [];
    }
  }

  async updateClient(
    actor: AuthUser,
    clientId: string,
    input: UpdateCrmClientRequest,
  ): Promise<{ client: CrmClientSummary }> {
    const existing = await this.fetchClientForActor(actor, clientId);
    this.assertManagerOrOwner(actor);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.firstName !== undefined) patch.first_name = cleanRequired(input.firstName, 'firstName');
    if (input.lastName !== undefined) patch.last_name = cleanRequired(input.lastName, 'lastName');
    if (input.email !== undefined) patch.email = cleanOptional(input.email, { lowercase: true });
    if (input.phone !== undefined) patch.phone = cleanOptional(input.phone);
    if (input.communicationPreference !== undefined) {
      patch.communication_preference = input.communicationPreference;
    }
    if (input.marketingOptIn !== undefined) patch.marketing_opt_in = input.marketingOptIn;
    if (input.tags !== undefined) patch.tags = input.tags.map((tag) => tag.trim()).filter(Boolean);
    if (input.notesSummary !== undefined) {
      patch.notes = cleanOptional(input.notesSummary);
      patch.metadata = {
        ...(existing.metadata ?? {}),
        notesSummary: cleanOptional(input.notesSummary),
      };
    }
    if (input.primaryLocationId !== undefined) {
      if (input.primaryLocationId) this.assertLocationScope(actor, input.primaryLocationId);
      patch.primary_location_id = input.primaryLocationId;
    }

    // Validate the preference against the resulting contact details (the patch
    // where present, otherwise the stored values), so an edit can't leave the
    // client preferring a channel they can't be reached on.
    const nextEmail =
      input.email !== undefined ? cleanOptional(input.email, { lowercase: true }) : existing.email;
    const nextPhone = input.phone !== undefined ? cleanOptional(input.phone) : existing.phone;
    const nextPreference =
      input.communicationPreference !== undefined
        ? input.communicationPreference
        : existing.communication_preference;
    assertPreferenceReachable(nextPreference, nextEmail, nextPhone);

    // An email edit gets the same duplicate guard as create — without it, two
    // profiles created separately could silently converge on one email here.
    const emailChanged =
      nextEmail && nextEmail.toLowerCase() !== (existing.email ?? '').toLowerCase();
    if (emailChanged && !input.allowDuplicate) {
      const collision = await this.findClientByEmail(actor.businessId, nextEmail);
      if (collision && collision.id !== clientId) {
        throw duplicateClientConflict(collision, 'email');
      }
    }

    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .update(patch)
      .eq('id', clientId)
      .eq('business_id', actor.businessId)
      .select(CLIENT_COLUMNS)
      .single<ClientProfileRow>();

    if (error || !data) {
      this.logger.error(`updateClient failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to update CRM client');
    }

    return { client: toClientSummary(data) };
  }

  /**
   * Scans every readable client for shared emails / shared phone numbers (the
   * same last-9-digits equivalence the search uses). Backs the Client Hub's
   * "possible duplicates" banner and the merge tool.
   */
  async listDuplicates(actor: AuthUser): Promise<ListClientDuplicatesResponse> {
    this.assertManagerOrOwner(actor);
    const locationIds = this.resolveReadableLocationIds(actor, undefined);
    if (locationIds && locationIds.length === 0) return { groups: [] };

    // Page explicitly — PostgREST caps unpaged reads at max-rows (1000).
    const PAGE = 500;
    const rows: ClientProfileRow[] = [];
    for (let from = 0; ; from += PAGE) {
      let request = this.admin
        .schema('core')
        .from('client_profiles')
        .select(CLIENT_COLUMNS)
        .eq('business_id', actor.businessId)
        .is('merged_into_id', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (locationIds) request = request.in('primary_location_id', locationIds);
      const { data, error } = await request.returns<ClientProfileRow[]>();
      if (error) {
        this.logger.error(`listDuplicates scan failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to scan for duplicate clients');
      }
      const page = data ?? [];
      rows.push(...page);
      if (page.length < PAGE) break;
    }

    const byEmail = new Map<string, ClientProfileRow[]>();
    const byPhone = new Map<string, ClientProfileRow[]>();
    for (const row of rows) {
      const email = row.email?.trim().toLowerCase();
      if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), row]);
      const suffix = row.phone ? phoneSuffix9(row.phone) : null;
      if (suffix) byPhone.set(suffix, [...(byPhone.get(suffix) ?? []), row]);
    }

    const groups: ClientDuplicateGroup[] = [];
    const seenMemberSets = new Set<string>();
    const memberKey = (members: ClientProfileRow[]) =>
      members.map((member) => member.id).sort().join(',');
    for (const [value, members] of byEmail) {
      if (members.length < 2) continue;
      seenMemberSets.add(memberKey(members));
      groups.push({ matchType: 'email', value, clients: members.map(toDuplicateEntry) });
    }
    for (const [, members] of byPhone) {
      if (members.length < 2) continue;
      // A pair already grouped by email doesn't need a second, identical
      // phone group — only phone-only matches add information.
      if (seenMemberSets.has(memberKey(members))) continue;
      groups.push({
        matchType: 'phone',
        value: members[0].phone ?? '',
        clients: members.map(toDuplicateEntry),
      });
    }
    groups.sort((a, b) => b.clients.length - a.clients.length);
    return { groups: groups.slice(0, 50) };
  }

  /**
   * Merges a duplicate profile into a surviving one via the crm.merge_clients
   * RPC (0087): every FK repointed, login link moved, contact gaps filled,
   * duplicate tombstoned — one transaction. The actor must be able to read
   * both records; the merge is audited as `client.merged`.
   */
  async mergeClients(
    actor: AuthUser,
    primaryId: string,
    duplicateId: string,
  ): Promise<MergeClientsResponse> {
    this.assertManagerOrOwner(actor);
    if (primaryId === duplicateId) {
      throw new BadRequestException('Choose two different clients to merge');
    }
    const [primary, duplicate] = await Promise.all([
      this.fetchClientForActor(actor, primaryId),
      this.fetchClientForActor(actor, duplicateId),
    ]);

    const { data, error } = await this.admin.schema('crm').rpc('merge_clients', {
      p_business_id: actor.businessId,
      p_primary_id: primaryId,
      p_duplicate_id: duplicateId,
    });
    if (error) {
      this.logger.error(`merge_clients failed: ${error.message}`);
      throw new BadRequestException(error.message || 'Unable to merge clients');
    }
    const movedRecords = ((data as { moved?: Record<string, number> } | null)?.moved) ?? {};

    await this.audit.record(actor, {
      action: 'client.merged',
      entityType: 'client',
      entityId: primaryId,
      locationId: primary.primary_location_id ?? undefined,
      before: {
        duplicateClientId: duplicateId,
        duplicateClientCode: duplicate.client_code,
        duplicateDisplayName: `${duplicate.first_name} ${duplicate.last_name}`.trim(),
      },
      metadata: { movedRecords },
    });

    const refreshed = await this.fetchClientForActor(actor, primaryId);
    return { client: toClientSummary(refreshed), movedRecords };
  }

  async listVisits(actor: AuthUser, clientId: string): Promise<ListCrmClientVisitsResponse> {
    await this.fetchClientForActor(actor, clientId);
    return { visits: await this.fetchVisitsForClient(actor.businessId, clientId) };
  }

  async listNotes(actor: AuthUser, clientId: string): Promise<ListCrmClientNotesResponse> {
    await this.fetchClientForActor(actor, clientId);
    return { notes: await this.fetchNotes(actor.businessId, clientId) };
  }

  async createNote(
    actor: AuthUser,
    clientId: string,
    input: CreateCrmClientNoteRequest,
  ): Promise<ListCrmClientNotesResponse> {
    const client = await this.fetchClientForActor(actor, clientId);
    const locationId = await this.resolveNoteLocation(actor, client, input);

    const { error } = await this.admin.schema('crm').from('client_notes').insert({
      business_id: actor.businessId,
      location_id: locationId,
      client_profile_id: clientId,
      visit_id: input.visitId ?? null,
      note_type: input.noteType ?? 'general',
      content: cleanRequired(input.content, 'content'),
      created_by_user_id: actor.id,
    });

    if (error) {
      this.logger.error(`createNote failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to save CRM note');
    }

    return this.listNotes(actor, clientId);
  }

  async listAllergies(actor: AuthUser, clientId: string): Promise<ListCrmClientAllergiesResponse> {
    await this.fetchClientForActor(actor, clientId);
    return { allergies: await this.fetchAllergies(actor.businessId, clientId) };
  }

  async createAllergy(
    actor: AuthUser,
    clientId: string,
    input: CreateCrmAllergyRecordRequest,
  ): Promise<ListCrmClientAllergiesResponse> {
    await this.fetchClientForActor(actor, clientId);
    this.assertManagerOrOwner(actor);

    const { error } = await this.admin.schema('crm').from('allergy_records').insert({
      business_id: actor.businessId,
      client_profile_id: clientId,
      allergen_name: cleanRequired(input.allergenName, 'allergenName'),
      severity: input.severity ?? 'unknown',
      notes: cleanOptional(input.notes),
      is_active: input.isActive ?? true,
      recorded_by_user_id: actor.id,
    });

    if (error) {
      this.logger.error(`createAllergy failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to save allergy record');
    }

    return this.listAllergies(actor, clientId);
  }

  async listPatchTests(actor: AuthUser, clientId: string): Promise<ListCrmClientPatchTestsResponse> {
    await this.fetchClientForActor(actor, clientId);
    return { patchTests: await this.fetchPatchTests(actor.businessId, clientId) };
  }

  async createPatchTest(
    actor: AuthUser,
    clientId: string,
    input: CreateCrmPatchTestRequest,
  ): Promise<ListCrmClientPatchTestsResponse> {
    const client = await this.fetchClientForActor(actor, clientId);
    this.assertManagerOrOwner(actor);
    const locationId = this.resolveWriteLocation(actor, input.locationId ?? client.primary_location_id ?? undefined);
    if (!locationId) throw new BadRequestException('locationId is required for patch tests');
    this.assertLocationScope(actor, locationId);

    const performedAt = new Date(input.performedAt);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
    if (Number.isNaN(performedAt.getTime())) throw new BadRequestException('performedAt is invalid');
    if (expiresAt && expiresAt.getTime() < performedAt.getTime()) {
      throw new BadRequestException('expiresAt must be after performedAt');
    }

    const { error } = await this.admin.schema('crm').from('patch_tests').insert({
      business_id: actor.businessId,
      location_id: locationId,
      client_profile_id: clientId,
      performed_at: input.performedAt,
      expires_at: input.expiresAt ?? null,
      status: input.status,
      notes: cleanOptional(input.notes),
      recorded_by_user_id: actor.id,
    });

    if (error) {
      this.logger.error(`createPatchTest failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to save patch test');
    }

    return this.listPatchTests(actor, clientId);
  }

  async listMessages(actor: AuthUser, clientId: string): Promise<ListCrmClientMessagesResponse> {
    await this.fetchClientForActor(actor, clientId);
    return { messages: await this.fetchMessages(actor.businessId, clientId) };
  }

  async listVisitPhotos(actor: AuthUser, visitId: string): Promise<ListCrmVisitPhotosResponse> {
    const visit = await this.fetchVisitForActor(actor, visitId);
    return { photos: await this.fetchPhotosForVisit(actor.businessId, visit.id) };
  }

  async createVisitPhoto(
    actor: AuthUser,
    visitId: string,
    input: CreateCrmVisitPhotoRequest,
  ): Promise<{ photo: CrmVisitPhoto }> {
    this.assertManagerOrOwner(actor);
    const visit = await this.fetchVisitForActor(actor, visitId);
    if (visit.client_profile_id !== input.clientProfileId) {
      throw new BadRequestException('Photo clientProfileId must match the visit client');
    }

    const { data, error } = await this.admin
      .schema('crm')
      .from('visit_photos')
      .insert({
        business_id: actor.businessId,
        location_id: visit.location_id,
        visit_id: visitId,
        client_profile_id: visit.client_profile_id,
        photo_type: input.photoType ?? 'other',
        storage_bucket: cleanRequired(input.storageBucket, 'storageBucket'),
        storage_path: cleanRequired(input.storagePath, 'storagePath'),
        mime_type: cleanOptional(input.mimeType),
        uploaded_by_user_id: actor.id,
      })
      .select('*')
      .single<PhotoRow>();

    if (error || !data) {
      this.logger.error(`createVisitPhoto failed: ${error?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to save visit photo');
    }

    return { photo: toPhoto(data) };
  }

  private async fetchClientForActor(actor: AuthUser, clientId: string): Promise<ClientProfileRow> {
    this.assertStaffRole(actor);
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('id', clientId)
      .eq('business_id', actor.businessId)
      .maybeSingle<ClientProfileRow>();

    if (error) {
      this.logger.error(`fetchClientForActor failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load CRM client');
    }
    if (!data) throw new NotFoundException('CRM client not found');

    if (userHasRole(actor, 'owner')) return data;
    if (data.primary_location_id && actor.allowedLocationIds.includes(data.primary_location_id)) {
      return data;
    }
    if (userHasRole(actor, 'stylist') && actor.staffProfileId) {
      const hasVisit = await this.hasStylistClientAccess(actor, clientId);
      if (hasVisit) return data;
    }
    throw new ForbiddenException('CRM client is outside your scope');
  }

  private async fetchVisitForActor(actor: AuthUser, visitId: string): Promise<VisitRow> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select(
        'id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,checked_in_at,started_at,completed_at,service_summary,client_visible_summary,created_at',
      )
      .eq('id', visitId)
      .eq('business_id', actor.businessId)
      .maybeSingle<VisitRow>();

    if (error) {
      this.logger.error(`fetchVisitForActor failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load visit');
    }
    if (!data) throw new NotFoundException('Visit not found');
    await this.fetchClientForActor(actor, data.client_profile_id);
    return data;
  }

  private async hasStylistClientAccess(actor: AuthUser, clientId: string): Promise<boolean> {
    if (!actor.staffProfileId) return false;
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id')
      .eq('business_id', actor.businessId)
      .eq('client_profile_id', clientId)
      .or(
        `assigned_staff_profile_id.eq.${actor.staffProfileId},requested_staff_profile_id.eq.${actor.staffProfileId}`,
      )
      .limit(1);

    if (error) return false;
    if ((data ?? []).length > 0) return true;

    const { data: visits } = await this.admin
      .schema('booking')
      .from('visits')
      .select('id')
      .eq('business_id', actor.businessId)
      .eq('client_profile_id', clientId)
      .eq('primary_staff_profile_id', actor.staffProfileId)
      .limit(1);

    return (visits ?? []).length > 0;
  }

  private async fetchVisitsForClient(
    businessId: string,
    clientId: string,
  ): Promise<CrmVisitSummary[]> {
    const [visitsResult, appointmentsResult] = await Promise.all([
      this.admin
        .schema('booking')
        .from('visits')
        .select(
          'id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,checked_in_at,started_at,completed_at,service_summary,client_visible_summary,created_at,appointments(id,scheduled_start_at,scheduled_end_at,status,assigned_staff_profile_id,appointment_services(service_name_snapshot,price_amount)),rebooking_outcomes(id,rebooked_appointment_id,rebook_source,rebooked_at)',
        )
        .eq('business_id', businessId)
        .eq('client_profile_id', clientId)
        .order('created_at', { ascending: false })
        .limit(25)
        .returns<VisitRow[]>(),
      this.admin
        .schema('booking')
        .from('appointments')
        .select(
          'id,business_id,location_id,client_profile_id,assigned_staff_profile_id,status,scheduled_start_at,scheduled_end_at,completed_at,appointment_services(service_name_snapshot,price_amount)',
        )
        .eq('business_id', businessId)
        .eq('client_profile_id', clientId)
        .order('scheduled_start_at', { ascending: false })
        .limit(25)
        .returns<AppointmentHistoryRow[]>(),
    ]);

    if (visitsResult.error) {
      this.logger.error(`fetchVisitsForClient failed: ${visitsResult.error.message}`);
      throw new InternalServerErrorException('Unable to load visit history');
    }
    if (appointmentsResult.error) {
      this.logger.error(`fetchAppointmentsForClient failed: ${appointmentsResult.error.message}`);
      throw new InternalServerErrorException('Unable to load visit history');
    }

    const visits = visitsResult.data ?? [];
    const visitedAppointmentIds = new Set(
      visits.map((visit) => visit.appointment_id).filter((id): id is string => Boolean(id)),
    );
    const appointments = (appointmentsResult.data ?? []).filter(
      (appointment) => !visitedAppointmentIds.has(appointment.id),
    );
    const staffNames = await this.fetchStaffNames(
      businessId,
      [
        ...visits.map((visit) => visit.primary_staff_profile_id ?? first(visit.appointments)?.assigned_staff_profile_id),
        ...appointments.map((appointment) => appointment.assigned_staff_profile_id),
      ].filter((id): id is string => Boolean(id)),
    );

    const summaries = [
      ...visits.map((visit) => toVisitSummary(visit, staffNames)),
      ...appointments.map((appointment) => toAppointmentVisitSummary(appointment, staffNames)),
    ];

    // Overlay the amount the client has actually paid so the history reflects
    // money in, not the planned service price (which is often 0 until checkout).
    // Rule: an unprocessed appointment shows the deposit paid so far; once it is
    // processed (checked out → billing.salon_payments), it shows the full total.
    const appointmentIds = [
      ...visits.map((visit) => visit.appointment_id),
      ...appointments.map((appointment) => appointment.id),
    ].filter((id): id is string => Boolean(id));
    const [paid, deposits] = await Promise.all([
      this.fetchPaidTotals(businessId, {
        visitIds: visits.map((visit) => visit.id),
        appointmentIds,
      }),
      this.fetchDepositTotals(businessId, appointmentIds),
    ]);
    for (const summary of summaries) {
      const paidEntry =
        paid.byVisit.get(summary.id) ??
        (summary.appointmentId ? paid.byAppointment.get(summary.appointmentId) : undefined);
      if (paidEntry && paidEntry.amountCents > 0) {
        // Processed: the full amount taken at checkout (major currency units).
        summary.priceAmount = paidEntry.amountCents / 100;
        summary.amountKind = 'paid';
        summary.currencyCode = paidEntry.currency ?? summary.currencyCode;
        continue;
      }

      // Not processed: show only the deposit the client has paid, if any.
      const depositEntry = summary.appointmentId
        ? deposits.get(summary.appointmentId)
        : undefined;
      if (depositEntry && depositEntry.amount > 0) {
        summary.priceAmount = depositEntry.amount;
        summary.amountKind = 'deposit';
        summary.currencyCode = depositEntry.currency ?? summary.currencyCode;
      } else {
        summary.priceAmount = undefined;
        summary.amountKind = undefined;
      }
    }

    return summaries
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, 25);
  }

  /**
   * Actual amounts paid per visit / appointment from billing.salon_payments.
   * Used to show the real charge in visit history rather than the (often zero)
   * planned service price.
   */
  private async fetchPaidTotals(
    businessId: string,
    keys: { visitIds: string[]; appointmentIds: string[] },
  ): Promise<{
    byVisit: Map<string, { amountCents: number; currency?: string }>;
    byAppointment: Map<string, { amountCents: number; currency?: string }>;
  }> {
    const byVisit = new Map<string, { amountCents: number; currency?: string }>();
    const byAppointment = new Map<string, { amountCents: number; currency?: string }>();
    const visitIds = [...new Set(keys.visitIds.filter(Boolean))];
    const appointmentIds = [...new Set(keys.appointmentIds.filter(Boolean))];
    if (visitIds.length === 0 && appointmentIds.length === 0) return { byVisit, byAppointment };

    const [visitRows, appointmentRows] = await Promise.all([
      this.fetchPaymentRows(businessId, 'visit_id', visitIds),
      this.fetchPaymentRows(businessId, 'appointment_id', appointmentIds),
    ]);

    for (const row of visitRows) {
      if (!row.visit_id) continue;
      const prev = byVisit.get(row.visit_id);
      byVisit.set(row.visit_id, {
        amountCents: (prev?.amountCents ?? 0) + Number(row.amount_cents ?? 0),
        currency: row.currency_code ?? prev?.currency,
      });
    }
    for (const row of appointmentRows) {
      if (!row.appointment_id) continue;
      const prev = byAppointment.get(row.appointment_id);
      byAppointment.set(row.appointment_id, {
        amountCents: (prev?.amountCents ?? 0) + Number(row.amount_cents ?? 0),
        currency: row.currency_code ?? prev?.currency,
      });
    }
    return { byVisit, byAppointment };
  }

  private async fetchPaymentRows(
    businessId: string,
    column: 'visit_id' | 'appointment_id',
    ids: string[],
  ): Promise<PaymentRow[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.admin
      .schema('billing')
      .from('salon_payments')
      .select('visit_id,appointment_id,amount_cents,currency_code')
      .eq('business_id', businessId)
      .in(column, ids)
      .returns<PaymentRow[]>();
    if (error) {
      this.logger.error(`fetchPaymentRows(${column}) failed: ${error.message}`);
      return [];
    }
    return data ?? [];
  }

  /**
   * Deposits actually paid per appointment (booking.deposits, major units).
   * Only rows with a paid_at are counted — an unpaid/authorized-only deposit is
   * not money the client has parted with yet.
   */
  private async fetchDepositTotals(
    businessId: string,
    appointmentIds: string[],
  ): Promise<Map<string, { amount: number; currency?: string }>> {
    const byAppointment = new Map<string, { amount: number; currency?: string }>();
    const ids = [...new Set(appointmentIds.filter(Boolean))];
    if (ids.length === 0) return byAppointment;

    const { data, error } = await this.admin
      .schema('booking')
      .from('deposits')
      .select('appointment_id,amount,currency_code,paid_at')
      .eq('business_id', businessId)
      .in('appointment_id', ids)
      .not('paid_at', 'is', null)
      .returns<DepositRow[]>();

    if (error) {
      this.logger.error(`fetchDepositTotals failed: ${error.message}`);
      return byAppointment;
    }

    for (const row of data ?? []) {
      if (!row.appointment_id) continue;
      const prev = byAppointment.get(row.appointment_id);
      byAppointment.set(row.appointment_id, {
        amount: (prev?.amount ?? 0) + Number(row.amount ?? 0),
        currency: row.currency_code ?? prev?.currency,
      });
    }
    return byAppointment;
  }

  private async fetchStaffNames(
    businessId: string,
    staffProfileIds: string[],
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(staffProfileIds)];
    const names = new Map<string, string>();
    if (uniqueIds.length === 0) return names;

    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name')
      .eq('business_id', businessId)
      .in('id', uniqueIds)
      .returns<StaffNameRow[]>();

    if (error) {
      this.logger.error(`fetchStaffNames failed: ${error.message}`);
      return names;
    }

    for (const row of data ?? []) {
      if (row.display_name) names.set(row.id, row.display_name);
    }
    return names;
  }

  private async fetchNotes(businessId: string, clientId: string): Promise<CrmClientNote[]> {
    const { data, error } = await this.admin
      .schema('crm')
      .from('client_notes')
      .select('*')
      .eq('business_id', businessId)
      .eq('client_profile_id', clientId)
      .order('created_at', { ascending: false })
      .limit(50)
      .returns<NoteRow[]>();

    if (error) {
      this.logger.error(`fetchNotes failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load notes');
    }
    return (data ?? []).map(toNote);
  }

  private async fetchAllergies(businessId: string, clientId: string): Promise<CrmAllergyRecord[]> {
    const { data, error } = await this.admin
      .schema('crm')
      .from('allergy_records')
      .select('*')
      .eq('business_id', businessId)
      .eq('client_profile_id', clientId)
      .order('is_active', { ascending: false })
      .order('recorded_at', { ascending: false })
      .returns<AllergyRow[]>();

    if (error) {
      this.logger.error(`fetchAllergies failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load allergy records');
    }
    return (data ?? []).map(toAllergy);
  }

  private async fetchPatchTests(businessId: string, clientId: string): Promise<CrmPatchTestRecord[]> {
    const { data, error } = await this.admin
      .schema('crm')
      .from('patch_tests')
      .select('*')
      .eq('business_id', businessId)
      .eq('client_profile_id', clientId)
      .order('performed_at', { ascending: false })
      .returns<PatchTestRow[]>();

    if (error) {
      this.logger.error(`fetchPatchTests failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load patch tests');
    }
    return (data ?? []).map(toPatchTest);
  }

  private async fetchMessages(businessId: string, clientId: string): Promise<CrmMessageLog[]> {
    const { data, error } = await this.admin
      .schema('comms')
      .from('message_logs')
      .select(
        'id,business_id,location_id,client_profile_id,appointment_id,visit_id,channel,message_type,delivery_status,provider,provider_message_id,provider_status,recipient,template_key,content_preview,error_message,metadata,sent_at,delivered_at,failed_at,created_at',
      )
      .eq('business_id', businessId)
      .eq('client_profile_id', clientId)
      .order('created_at', { ascending: false })
      .limit(50)
      .returns<MessageRow[]>();

    if (error) {
      this.logger.error(`fetchMessages failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load message logs');
    }
    return (data ?? []).map(toMessage);
  }

  private async fetchPhotosForClient(businessId: string, clientId: string): Promise<CrmVisitPhoto[]> {
    const { data, error } = await this.admin
      .schema('crm')
      .from('visit_photos')
      .select('*')
      .eq('business_id', businessId)
      .eq('client_profile_id', clientId)
      .order('created_at', { ascending: false })
      .limit(40)
      .returns<PhotoRow[]>();

    if (error) {
      this.logger.error(`fetchPhotosForClient failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load visit photos');
    }
    return (data ?? []).map(toPhoto);
  }

  private async fetchPhotosForVisit(businessId: string, visitId: string): Promise<CrmVisitPhoto[]> {
    const { data, error } = await this.admin
      .schema('crm')
      .from('visit_photos')
      .select('*')
      .eq('business_id', businessId)
      .eq('visit_id', visitId)
      .order('created_at', { ascending: false })
      .returns<PhotoRow[]>();

    if (error) {
      this.logger.error(`fetchPhotosForVisit failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load visit photos');
    }
    return (data ?? []).map(toPhoto);
  }

  private async fetchGdprRequests(
    businessId: string,
    clientId: string,
  ): Promise<GdprRequestRow[]> {
    const { data, error } = await this.admin
      .schema('crm')
      .from('gdpr_requests')
      .select('id,request_type,status')
      .eq('business_id', businessId)
      .eq('client_profile_id', clientId)
      .returns<GdprRequestRow[]>();

    if (error) {
      this.logger.error(`fetchGdprRequests failed: ${error.message}`);
      return [];
    }
    return data ?? [];
  }

  private async fetchLastVisitByClient(
    businessId: string,
    clientIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (clientIds.length === 0) return map;

    const [visitsResult, appointmentsResult] = await Promise.all([
      this.admin
        .schema('booking')
        .from('visits')
        .select('client_profile_id,completed_at,started_at,checked_in_at,created_at')
        .eq('business_id', businessId)
        .in('client_profile_id', clientIds)
        .order('created_at', { ascending: false }),
      this.admin
        .schema('booking')
        .from('appointments')
        .select('client_profile_id,completed_at,scheduled_start_at,created_at')
        .eq('business_id', businessId)
        .in('client_profile_id', clientIds)
        .order('scheduled_start_at', { ascending: false }),
    ]);

    // "Last visit" means the last time the client actually attended — a
    // completed visit / appointment. We must NOT fall back to scheduled dates:
    // a future (re)scheduled appointment would otherwise be picked as the last
    // visit. Attended visits use completed/started/checked-in timestamps;
    // appointments count only once completed. Future timestamps are ignored.
    const now = Date.now();
    const rows = [
      ...((visitsResult.data ?? []) as Array<Record<string, string | null>>).map((row) => ({
        client_profile_id: row.client_profile_id,
        occurred_at: row.completed_at ?? row.started_at ?? row.checked_in_at ?? null,
      })),
      ...((appointmentsResult.data ?? []) as Array<Record<string, string | null>>).map((row) => ({
        client_profile_id: row.client_profile_id,
        occurred_at: row.completed_at ?? null,
      })),
    ]
      .filter(
        (row) => row.occurred_at && new Date(row.occurred_at).getTime() <= now,
      )
      .sort(
        (a, b) =>
          new Date(b.occurred_at ?? '').getTime() - new Date(a.occurred_at ?? '').getTime(),
      );

    for (const row of rows) {
      const clientId = row.client_profile_id;
      if (clientId && !map.has(clientId)) {
        map.set(clientId, row.occurred_at ?? '');
      }
    }
    return map;
  }

  private async fetchActiveAllergyCounts(
    businessId: string,
    clientIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (clientIds.length === 0) return counts;
    const { data } = await this.admin
      .schema('crm')
      .from('allergy_records')
      .select('client_profile_id')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .in('client_profile_id', clientIds);
    for (const row of (data ?? []) as Array<{ client_profile_id: string }>) {
      counts.set(row.client_profile_id, (counts.get(row.client_profile_id) ?? 0) + 1);
    }
    return counts;
  }

  private async fetchExpiredPatchCounts(
    businessId: string,
    clientIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (clientIds.length === 0) return counts;
    const { data } = await this.admin
      .schema('crm')
      .from('patch_tests')
      .select('client_profile_id,status,expires_at')
      .eq('business_id', businessId)
      .in('client_profile_id', clientIds);
    for (const row of (data ?? []) as Array<{ client_profile_id: string; status: string; expires_at: string | null }>) {
      if (row.status === 'expired' || (row.expires_at && new Date(row.expires_at).getTime() < Date.now())) {
        counts.set(row.client_profile_id, (counts.get(row.client_profile_id) ?? 0) + 1);
      }
    }
    return counts;
  }

  private resolveReadableLocationIds(actor: AuthUser, requested?: string): string[] | undefined {
    if (userHasRole(actor, 'owner')) return requested ? [requested] : undefined;
    return requested ? [requested] : actor.allowedLocationIds;
  }

  private async findClientByEmail(
    businessId: string,
    email: string,
  ): Promise<ClientProfileRow | null> {
    // email is stored as citext, so this match is case-insensitive. Tombstoned
    // (merged) profiles are excluded — a conflict must point at a live record.
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('business_id', businessId)
      .eq('email', email)
      .is('merged_into_id', null)
      .limit(1)
      .maybeSingle<ClientProfileRow>();
    if (error) {
      this.logger.error(`findClientByEmail failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to check for existing client');
    }
    return data ?? null;
  }

  /**
   * Duplicate check by phone: the search RPC (0083/0087) does the
   * format-insensitive digit matching, then the candidates are narrowed to a
   * true last-9-digits match so "…160" typed alone can never trigger a false
   * conflict. Returns the full row so the conflict can carry a usable summary.
   */
  private async findClientByPhone(
    businessId: string,
    phone: string,
  ): Promise<ClientProfileRow | null> {
    const targetSuffix = phoneSuffix9(phone);
    if (!targetSuffix) return null;
    const { rows } = await this.runClientSearch(businessId, null, phone, 5, 0);
    const match = rows.find((row) => phoneSuffix9(row.phone ?? '') === targetSuffix);
    if (!match) return null;
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select(CLIENT_COLUMNS)
      .eq('business_id', businessId)
      .eq('id', match.id)
      .maybeSingle<ClientProfileRow>();
    if (error) {
      this.logger.error(`findClientByPhone failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to check for existing client');
    }
    return data ?? null;
  }

  private resolveWriteLocation(actor: AuthUser, requested?: string | null): string | undefined {
    if (requested) return requested;
    if (!userHasRole(actor, 'owner') && actor.allowedLocationIds.length === 1) return actor.allowedLocationIds[0];
    return undefined;
  }

  private async resolveNoteLocation(
    actor: AuthUser,
    client: ClientProfileRow,
    input: CreateCrmClientNoteRequest,
  ): Promise<string | null> {
    if (input.visitId) {
      const visit = await this.fetchVisitForActor(actor, input.visitId);
      if (visit.client_profile_id !== client.id) throw new BadRequestException('visitId is not for this client');
      return visit.location_id;
    }
    const locationId = input.locationId ?? client.primary_location_id;
    if (locationId) this.assertLocationScope(actor, locationId);
    return locationId ?? null;
  }

  private assertStaffRole(actor: AuthUser): void {
    // CRM is staff-only. Block users who hold ONLY a client role — a user who is
    // also an owner/manager/stylist keeps access.
    if (!userHasAnyRole(actor, ['owner', 'manager', 'stylist'])) {
      throw new ForbiddenException('Clients cannot access CRM');
    }
  }

  private assertManagerOrOwner(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('This CRM action requires owner or manager access');
    }
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your CRM scope');
    }
  }
}

function toClientSummary(
  row: ClientProfileRow,
  extras: { lastVisitAt?: string; activeAllergies?: number; expiredPatchTests?: number } = {},
): CrmClientSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    clientCode: row.client_code,
    primaryLocationId: row.primary_location_id ?? undefined,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    communicationPreference: row.communication_preference ?? undefined,
    notes: row.notes ?? undefined,
    marketingOptIn: row.marketing_opt_in,
    tags: row.tags ?? [],
    source: row.source ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVisitAt: extras.lastVisitAt || undefined,
    alertCounts: {
      activeAllergies: extras.activeAllergies ?? 0,
      expiredPatchTests: extras.expiredPatchTests ?? 0,
    },
  };
}

function toClientProfile(
  row: ClientProfileRow,
  extras: {
    lastVisitAt?: string;
    activeAllergies: number;
    expiredPatchTests: number;
    gdprRequests: GdprRequestRow[];
  },
): CrmClientProfile {
  const pendingRequests = extras.gdprRequests.filter((request) => request.status !== 'completed');
  return {
    ...toClientSummary(row, extras),
    dateOfBirth: row.date_of_birth ?? undefined,
    notesSummary: row.notes ?? (typeof row.metadata?.notesSummary === 'string' ? row.metadata.notesSummary : undefined),
    gdpr: {
      exportReady: true,
      pendingRequests: pendingRequests.length,
      deletionRequestPending: pendingRequests.some((request) => request.request_type === 'delete'),
    },
  };
}

function toVisitSummary(row: VisitRow, staffNames: Map<string, string> = new Map()): CrmVisitSummary {
  const appointment = first(row.appointments);
  const services = arrayOf(appointment?.appointment_services);
  const priceAmount = services.reduce((sum, service) => sum + Number(service.price_amount ?? 0), 0);
  const serviceNames = services.map((service) => service.service_name_snapshot).filter(Boolean);
  const staffProfileId = row.primary_staff_profile_id ?? appointment?.assigned_staff_profile_id ?? undefined;
  const rebooking = first(row.rebooking_outcomes);
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    appointmentId: row.appointment_id ?? undefined,
    clientProfileId: row.client_profile_id,
    primaryStaffProfileId: staffProfileId,
    stylistName: staffProfileId ? staffNames.get(staffProfileId) : undefined,
    status: row.status,
    occurredAt:
      row.completed_at ?? row.started_at ?? row.checked_in_at ?? appointment?.scheduled_start_at ?? row.created_at,
    serviceSummary: (row.service_summary ?? serviceNames.join(', ')) || undefined,
    clientVisibleSummary:
      (row.client_visible_summary ?? row.service_summary ?? serviceNames.join(', ')) || undefined,
    priceAmount: priceAmount > 0 ? priceAmount : undefined,
    currencyCode: 'GBP',
    rebooked: Boolean(rebooking),
    rebookSource: rebooking?.rebook_source,
    rebookedAppointmentId: rebooking?.rebooked_appointment_id,
    rebookedAt: rebooking?.rebooked_at,
  };
}

function toAppointmentVisitSummary(
  row: AppointmentHistoryRow,
  staffNames: Map<string, string> = new Map(),
): CrmVisitSummary {
  const services = arrayOf(row.appointment_services);
  const priceAmount = services.reduce((sum, service) => sum + Number(service.price_amount ?? 0), 0);
  const serviceNames = services.map((service) => service.service_name_snapshot).filter(Boolean);
  const serviceSummary = serviceNames.join(', ');
  return {
    id: `appointment:${row.id}`,
    businessId: row.business_id,
    locationId: row.location_id,
    appointmentId: row.id,
    clientProfileId: row.client_profile_id,
    primaryStaffProfileId: row.assigned_staff_profile_id ?? undefined,
    stylistName: row.assigned_staff_profile_id
      ? staffNames.get(row.assigned_staff_profile_id)
      : undefined,
    status: row.status,
    occurredAt: row.completed_at ?? row.scheduled_start_at,
    serviceSummary: serviceSummary || undefined,
    clientVisibleSummary: serviceSummary || undefined,
    priceAmount: priceAmount > 0 ? priceAmount : undefined,
    currencyCode: 'GBP',
  };
}

// Projects a durable lab formula-history record down to the staff-facing CRM
// profile shape: the recipe, when it was mixed and by which stylist. Product
// cost, waste and billing are deliberately dropped — they belong to the Lab
// billing views, not the client profile.
function toCrmClientFormula(record: LabClientFormulaHistoryRecord): CrmClientFormula {
  return {
    id: record.id,
    savedAt: record.savedAt,
    appointmentId: record.appointmentId,
    visitId: record.visitId,
    staffProfileId: record.staffProfileId,
    stylistName: record.stylistName,
    serviceType: record.visit?.serviceType,
    notes: record.notes,
    isDraft: record.isDraft || undefined,
    items: record.items.map((item) => ({
      productName: item.productName,
      brand: item.brand,
      shade: item.shade,
      developer: item.developer,
      ratio: item.ratio,
      processingTimeMinutes: item.processingTimeMinutes,
    })),
  };
}

function toNote(row: NoteRow): CrmClientNote {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id ?? undefined,
    clientProfileId: row.client_profile_id,
    visitId: row.visit_id ?? undefined,
    noteType: row.note_type,
    content: row.content,
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAllergy(row: AllergyRow): CrmAllergyRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    clientProfileId: row.client_profile_id,
    allergenName: row.allergen_name,
    severity: row.severity,
    notes: row.notes ?? undefined,
    isActive: row.is_active,
    recordedAt: row.recorded_at,
    recordedByUserId: row.recorded_by_user_id ?? undefined,
  };
}

function toPatchTest(row: PatchTestRow): CrmPatchTestRecord {
  const isExpired =
    row.status === 'expired' || Boolean(row.expires_at && new Date(row.expires_at).getTime() < Date.now());
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id ?? undefined,
    clientProfileId: row.client_profile_id,
    performedAt: row.performed_at,
    expiresAt: row.expires_at ?? undefined,
    status: row.status,
    notes: row.notes ?? undefined,
    recordedByUserId: row.recorded_by_user_id ?? undefined,
    createdAt: row.created_at,
    isExpired,
  };
}

function toMessage(row: MessageRow): CrmMessageLog {
  const primaryIntended =
    row.metadata && typeof row.metadata['primary_intended_channel'] === 'string'
      ? (row.metadata['primary_intended_channel'] as CrmMessageLog['channel'])
      : undefined;
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    clientProfileId: row.client_profile_id ?? undefined,
    appointmentId: row.appointment_id ?? undefined,
    visitId: row.visit_id ?? undefined,
    channel: row.channel,
    primaryIntendedChannel: primaryIntended,
    // `message_type` is the notification event key (e.g. booking_confirmation, appointment_reminder_24h).
    eventKey: row.message_type ?? undefined,
    messageType: row.message_type ?? undefined,
    deliveryStatus: row.delivery_status,
    provider: row.provider ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    providerStatus: row.provider_status ?? undefined,
    recipient: row.recipient ?? undefined,
    templateKey: row.template_key ?? undefined,
    contentPreview: row.content_preview ?? undefined,
    failureReason: row.error_message ?? undefined,
    sentAt: row.sent_at ?? undefined,
    deliveredAt: row.delivered_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    createdAt: row.created_at,
  };
}

function toPhoto(row: PhotoRow): CrmVisitPhoto {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    visitId: row.visit_id,
    clientProfileId: row.client_profile_id,
    photoType: row.photo_type,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    mimeType: row.mime_type ?? undefined,
    uploadedByUserId: row.uploaded_by_user_id ?? undefined,
    createdAt: row.created_at,
  };
}

// A communication preference is the starting point of the notification chain.
// Storing one that names a channel the client has no contact detail for makes
// booking notifications silently undeliverable, so reject the mismatch on write.
function assertPreferenceReachable(
  preference: string | null | undefined,
  email: string | null | undefined,
  phone: string | null | undefined,
): void {
  if (!preference) return;
  if ((preference === 'sms' || preference === 'whatsapp') && !phone) {
    throw new BadRequestException(`communicationPreference ${preference} requires a phone number`);
  }
  if (preference === 'email' && !email) {
    throw new BadRequestException('communicationPreference email requires an email address');
  }
}

function cleanRequired(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new BadRequestException(`${field} is required`);
  return trimmed;
}

function cleanOptional(
  value: string | null | undefined,
  options: { lowercase?: boolean } = {},
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return options.lowercase ? trimmed.toLowerCase() : trimmed;
}

/** 409 payload shared by every duplicate-client guard (create + email edit). */
function duplicateClientConflict(
  row: ClientProfileRow,
  matchedBy: 'email' | 'phone',
): ConflictException {
  const displayName = `${row.first_name} ${row.last_name}`.trim();
  return new ConflictException({
    message: `A client with this ${
      matchedBy === 'email' ? 'email' : 'phone number'
    } already exists: ${displayName} (${row.client_code}). Use the existing record or create anyway.`,
    matchedBy,
    existingClient: { id: row.id, displayName, clientCode: row.client_code },
    // Full summary so a till flow can adopt the existing client in place.
    client: toClientSummary(row),
  });
}

/**
 * Last 9 digits after dropping an international dial prefix ("00…") and a
 * trunk zero — the same equivalence the search RPC (0083) applies, so the
 * phone duplicate guard and phone search can never disagree.
 */
function phoneSuffix9(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

function toDuplicateEntry(row: ClientProfileRow): CrmClientSearchResult {
  return {
    id: row.id,
    clientCode: row.client_code,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    primaryLocationId: row.primary_location_id ?? undefined,
  };
}

function toClientSearchResult(row: ClientSearchRpcRow): CrmClientSearchResult {
  return {
    id: row.id,
    clientCode: row.client_code,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    primaryLocationId: row.primary_location_id ?? undefined,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function buildClientsPagination(
  total: number,
  page: number,
  pageSize: number,
): CrmClientsPagination {
  const safeTotal = Math.max(0, total);
  return {
    total: safeTotal,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(safeTotal / pageSize)),
  };
}

function first<T>(value: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

function arrayOf<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function crmScope(actor: AuthUser): CrmStaffScope {
  if (userHasAnyRole(actor, ['owner', 'manager', 'stylist'])) {
    return actor.primaryRole as CrmStaffScope;
  }
  throw new ForbiddenException('Clients cannot access CRM');
}
