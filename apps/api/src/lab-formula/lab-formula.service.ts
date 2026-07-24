import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  ClientLabFormulaSummary,
  ClientLabHistoryResponse,
  LocationProductBillingSettings,
  ProductBillingRule,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { buildProductBillingSnapshot } from '../common/product-billing.helper';
import {
  calculateFormulaBillableChargeCents,
  createFormulaDraft,
  type FormulaBillingBreakdown,
  type FormulaDraft,
  type FormulaHistoryRecord,
  type FormulaItem,
  type FormulaSaveResult,
} from '@sheer/lab-core';
import type {
  AddFormulaItemDto,
  CaptureWeightDto,
  DuplicateFormulaDto,
  SaveFormulaDto,
  StartFormulaDto,
} from './dto';
import type { LabRuntimeSession } from '../lab-session/lab-session.service';

interface FormulaContext {
  businessId: string;
  locationId: string;
  appointmentId?: string;
  visitId?: string;
  clientProfileId?: string;
}

interface AppointmentFormulaContextRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string;
  assigned_staff_profile_id: string | null;
  appointment_services?: { service_name_snapshot: string }[] | { service_name_snapshot: string } | null;
}

interface VisitFormulaContextRow {
  id: string;
  business_id: string;
  location_id: string;
  client_profile_id: string;
  primary_staff_profile_id: string | null;
  appointment_id: string | null;
}

interface FormulaReconciliationRpcResult {
  formulaId?: string;
  persistedFormulaId?: string;
  actualCostCents?: number | string;
  wasteCostCents?: number | string;
  billableChargeCents?: number | string;
  currencyCode?: string;
  billingApplied?: boolean;
  visitId?: string;
}

interface FormulaMovementRow {
  product_id: string;
  quantity_delta_grams: number | string;
  movement_type: 'formula_usage' | 'formula_waste' | 'formula_reversal';
}

interface FormulaLowStockAlertRow {
  product_id: string;
  remaining_quantity_grams: number | string;
  threshold_quantity_grams: number | string;
}

interface FormulaVisitLineItemRow {
  visit_id: string;
  amount_cents: number;
  currency_code: string;
  formula_breakdown: unknown;
  updated_at: string;
}

interface FormulaItemUsageRow {
  product_name: string | null;
  captured_grams: number | string;
}

/** Per-product grams actually spent in a finalized mix, aggregated for a visit. */
export interface FormulaProductUsage {
  productName: string;
  grams: number;
}

interface ProductBillingRulesRow {
  product_billing_enabled: boolean;
  product_billing_rule: string;
  product_markup_percent: number | null;
  product_fixed_uplift_amount: number | null;
  product_round_up_enabled: boolean | null;
  product_round_up_increment: number | null;
}

/**
 * A durably-stored saved formula, enriched with the stylist who mixed it. The
 * stylist is resolved from the owning visit/appointment (there is no stylist
 * column on lab.formulas), keeping every saved formula "linked to the
 * stylist/client" without a schema change.
 */
export interface LabClientFormulaHistoryRecord extends FormulaHistoryRecord {
  staffProfileId?: string;
  stylistName?: string;
  /** True for a durably-saved draft (recipe persisted, billing/stock not yet reconciled). */
  isDraft?: boolean;
}

/** Resolved stylist/service context for a saved formula, keyed by formula row id. */
interface FormulaStylistContext {
  staffProfileId?: string;
  stylistName?: string;
  serviceType?: string;
}

interface SavedFormulaItemRow {
  id: string;
  external_item_id: string | null;
  product_id: string | null;
  product_name: string;
  brand: string | null;
  shade: string | null;
  developer: string | null;
  ratio: string | null;
  processing_time_minutes: number | null;
  captured_grams: number | string;
  waste_grams: number | string;
  entry_mode: 'ble_scale' | 'manual';
  captured_at: string | null;
  cost_per_gram_cents: number | null;
  cost_cents: number;
  waste_cost_cents: number;
  notes: string | null;
}

interface SavedFormulaRow {
  id: string;
  external_formula_id: string | null;
  lab_session_id: string | null;
  appointment_id: string | null;
  visit_id: string | null;
  business_id: string;
  location_id: string;
  client_profile_id: string;
  source_formula_id: string | null;
  notes: string | null;
  status: string;
  actual_cost_cents: number;
  waste_cost_cents: number;
  billable_charge_cents: number;
  currency_code: string;
  saved_at: string;
  created_at: string;
  updated_at: string;
  formula_items: SavedFormulaItemRow[] | null;
}

interface VisitStylistRow {
  id: string;
  primary_staff_profile_id: string | null;
  service_summary: string | null;
}

interface AppointmentStylistRow {
  id: string;
  assigned_staff_profile_id: string | null;
  appointment_services?: { service_name_snapshot: string }[] | { service_name_snapshot: string } | null;
}

interface StaffDisplayNameRow {
  id: string;
  display_name: string | null;
}

/** Upper bound on how many saved formulas a single client-history read returns. */
const FORMULA_HISTORY_LIMIT = 100;

const SAVED_FORMULA_COLUMNS =
  'id,external_formula_id,lab_session_id,appointment_id,visit_id,business_id,location_id,client_profile_id,source_formula_id,notes,status,actual_cost_cents,waste_cost_cents,billable_charge_cents,currency_code,saved_at,created_at,updated_at,formula_items(id,external_item_id,product_id,product_name,brand,shade,developer,ratio,processing_time_minutes,captured_grams,waste_grams,entry_mode,captured_at,cost_per_gram_cents,cost_cents,waste_cost_cents,notes)';

@Injectable()
export class LabFormulaService {
  private readonly logger = new Logger(LabFormulaService.name);
  private readonly admin: SupabaseClient;
  private readonly formulas = new Map<string, FormulaDraft | FormulaHistoryRecord>();

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async start(actor: AuthUser, dto: StartFormulaDto): Promise<FormulaDraft> {
    const context = await this.resolveFormulaContext(actor, dto);
    return {
      ...createFormulaDraft({
      id: `formula_${Date.now()}`,
      labSessionId: dto.labSessionId,
      appointmentId: dto.appointmentId,
      clientProfileId: context.clientProfileId ?? dto.clientProfileId,
      currencyCode: 'GBP',
      }),
      visitId: dto.visitId,
      businessId: context.businessId,
      locationId: context.locationId,
    } satisfies FormulaDraft;
  }

  get(id: string): FormulaDraft {
    return createFormulaDraft({
      id,
      labSessionId: 'lab_session_scaffold',
    });
  }

  addItem(id: string, dto: AddFormulaItemDto) {
    // TODO: append formula item with product validation and local inventory cost snapshot.
    return {
      formulaId: id,
      item: {
        id: 'formula_item_scaffold',
        productId: dto.productId,
        productName: dto.productName,
        targetGrams: dto.targetGrams,
        entryMode: 'manual',
      },
    };
  }

  captureWeight(id: string, dto: CaptureWeightDto) {
    // TODO: validate active session/device, capture BLE/manual audit metadata, and buffer if offline.
    return {
      formulaId: id,
      capturedGrams: dto.grams,
      source: dto.source ?? 'ble_scale',
    };
  }

  finishMixing(id: string) {
    return { formulaId: id, status: 'ready_for_review' };
  }

  async save(actor: AuthUser, id: string, dto: SaveFormulaDto): Promise<FormulaSaveResult> {
    // A draft save must not fabricate a checked_in visit for a client who may
    // not have arrived yet — the visit is created at finalize instead.
    const context = await this.resolveFormulaContext(actor, dto, {
      createVisitIfMissing: dto.finalizeRequested !== false,
    });
    const savedAt = new Date().toISOString();
    const items = normalizeItems(dto.items);
    const totalCostCents = dto.totalCostCents ?? sumItemCostCents(normalizeItems(dto.items));
    const totalWasteCostCents = dto.totalWasteCostCents ?? sumWasteCostCents(normalizeItems(dto.items));
    const billableChargeCents =
      dto.billableChargeCents ??
      calculateFormulaBillableChargeCents(totalCostCents, {
        mode: 'cost_only',
        autoBillFormulaOnSave: true,
        rebillFormulaOnEdit: true,
        combineFormulasIntoSingleCharge: true,
      });
    const formula: FormulaHistoryRecord = {
      id,
      labSessionId: dto.labSessionId,
      appointmentId: context.appointmentId ?? dto.appointmentId,
      visitId: context.visitId ?? dto.visitId,
      businessId: context.businessId,
      locationId: context.locationId,
      clientProfileId: context.clientProfileId ?? dto.clientProfileId,
      sourceFormulaId: dto.sourceFormulaId,
      notes: dto.notes,
      status: 'saved',
      items,
      totalCostCents,
      totalWasteCostCents,
      billableChargeCents,
      chargePreviewCents: billableChargeCents,
      billingStatus: dto.billingHandoffRequested ? 'applied' : 'not_requested',
      inventoryStatus: dto.inventoryDeductionRequested === false ? 'not_requested' : 'applied',
      currencyCode: dto.currencyCode ?? 'GBP',
      savedAt,
      updatedAt: savedAt,
    };

    const rpcPayload = {
      ...dto,
      formulaId: id,
      appointmentId: context.appointmentId ?? dto.appointmentId,
      visitId: context.visitId ?? dto.visitId,
      businessId: context.businessId,
      locationId: context.locationId,
      clientProfileId: context.clientProfileId ?? dto.clientProfileId,
      // Audit identity for the durable formula record (who created/last modified
      // it). Undefined for actors without a staff profile (e.g. some owners).
      actingStaffProfileId: actor.staffProfileId,
      items,
      totalCostCents,
      totalWasteCostCents,
      billableChargeCents,
    };

    const { data, error } = await this.admin.schema('lab').rpc('save_formula_with_reconciliation', {
      p_payload: rpcPayload,
    });

    if (error) {
      this.logger.error(`save_formula_with_reconciliation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to finalize formula');
    }

    const result = await this.buildFormulaSaveResult(formula, data, context.locationId);
    this.formulas.set(formula.id, result);

    // Billing is only handed off when requested: a draft save persists the
    // recipe without putting a product-usage charge on the client's visit.
    if (result.visitId && totalCostCents > 0 && dto.billingHandoffRequested) {
      await this.applyProductBillingLineItem(
        context.businessId,
        context.locationId,
        result.visitId,
        totalCostCents,
        formula.currencyCode,
      );
    }

    this.logger.log(
      JSON.stringify({
        event: 'formula_finalized',
        formulaId: id,
        visitId: result.visitId,
        itemCount: result.items.length,
        inventoryMovements: result.inventoryMovements.length,
        lowStockAlerts: result.lowStockAlerts.length,
      }),
    );

    return result;
  }

  async saveForLabSession(session: LabRuntimeSession, id: string, dto: SaveFormulaDto): Promise<FormulaSaveResult> {
    return this.finalizeForLabSession(session, id, dto);
  }

  /**
   * Durably saves an in-progress (draft) formula from a lab station WITHOUT
   * touching billing or stock: no product-usage line item is written and no
   * inventory is deducted — both reconcile when the mix is finalized, which
   * upserts the same lab.formulas row via external_formula_id. Validation is
   * looser than finalize: the draft must belong to a real appointment/visit
   * (that link is what lands it on the client's durable colour record) and
   * name at least one ingredient, but rows may be unweighed or missing cost.
   */
  async saveDraftForLabSession(
    session: LabRuntimeSession,
    id: string,
    dto: SaveFormulaDto,
  ): Promise<FormulaSaveResult> {
    this.validateDraftSavePayload(dto);
    this.logger.log(
      JSON.stringify({
        event: 'formula_draft_save_requested',
        formulaId: id,
        labSessionId: session.sessionId,
        itemCount: Array.isArray(dto.items) ? dto.items.length : 0,
      }),
    );
    return this.save(toAuthUserFromLabSession(session), id, {
      ...dto,
      labSessionId: session.sessionId,
      businessId: session.businessId,
      locationId: session.locationId,
      billingHandoffRequested: false,
      inventoryDeductionRequested: false,
      finalizeRequested: false,
    });
  }

  async finalizeForLabSession(session: LabRuntimeSession, id: string, dto: SaveFormulaDto): Promise<FormulaSaveResult> {
    this.validateFinalSavePayload(dto);
    this.logger.log(
      JSON.stringify({
        event: 'formula_finalize_requested',
        formulaId: id,
        labSessionId: session.sessionId,
        itemCount: Array.isArray(dto.items) ? dto.items.length : 0,
      }),
    );
    return this.save(toAuthUserFromLabSession(session), id, {
      ...dto,
      labSessionId: session.sessionId,
      businessId: session.businessId,
      locationId: session.locationId,
      billingHandoffRequested: true,
      inventoryDeductionRequested: true,
      finalizeRequested: true,
    });
  }

  recalculate(id: string) {
    // TODO: recalculate charge preview from product usage and location billing rules.
    return { formulaId: id, chargePreviewCents: 4250, currencyCode: 'GBP' };
  }

  /**
   * Exposes the location's product billing rule to the Sheer Lab app so the
   * formula colour-charge preview can mirror the markup/uplift that will be
   * applied at finalize time. Falls back to a disabled cost-only rule when the
   * location has no billing rules row yet.
   */
  async getProductBillingSettingsForLabSession(
    session: LabRuntimeSession,
  ): Promise<LocationProductBillingSettings> {
    const rules = await this.fetchProductBillingRules(session.businessId, session.locationId);
    if (!rules) {
      return {
        locationId: session.locationId,
        productBillingEnabled: false,
        productBillingRule: 'cost_only',
        productMarkupPercent: null,
        productFixedUpliftAmount: null,
        productRoundUpEnabled: false,
        productRoundUpIncrement: null,
      };
    }

    return {
      locationId: session.locationId,
      productBillingEnabled: rules.product_billing_enabled,
      productBillingRule: rules.product_billing_rule as ProductBillingRule,
      productMarkupPercent: rules.product_markup_percent,
      productFixedUpliftAmount: rules.product_fixed_uplift_amount,
      productRoundUpEnabled: rules.product_round_up_enabled ?? false,
      productRoundUpIncrement: rules.product_round_up_increment,
    };
  }

  /**
   * Read-only billing breakdown for a finalized appointment, scoped to the lab
   * station's location. Surfaces the durable product-usage line item written at
   * finalize time (lab cost, billed charge and per-formula breakdown) so the
   * Sheer Lab history view can show real billing without the JWT-only formula
   * store. Returns a null line item when the appointment has no visit yet or no
   * mix has been finalized — never fabricates figures, and never creates a visit.
   */
  async getBillingBreakdownForLabSession(
    session: LabRuntimeSession,
    appointmentId: string,
  ): Promise<{
    appointmentId: string;
    billingLineItem: FormulaSaveResult['billingLineItem'] | null;
    productUsage: FormulaProductUsage[];
  }> {
    const actor = toAuthUserFromLabSession(session);

    const { data: appointment, error: appointmentError } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id,business_id,location_id')
      .eq('id', appointmentId)
      .eq('business_id', actor.businessId)
      .maybeSingle<{ id: string; business_id: string; location_id: string }>();

    if (appointmentError) {
      this.logger.error(`getBillingBreakdownForLabSession appointment lookup failed: ${appointmentError.message}`);
      throw new InternalServerErrorException('Unable to load appointment for billing breakdown');
    }
    if (!appointment) throw new BadRequestException('appointmentId is not valid for this business');
    this.assertLocationScope(actor, appointment.location_id);

    const { data: visit, error: visitError } = await this.admin
      .schema('booking')
      .from('visits')
      .select('id')
      .eq('appointment_id', appointment.id)
      .maybeSingle<{ id: string }>();

    if (visitError) {
      this.logger.error(`getBillingBreakdownForLabSession visit lookup failed: ${visitError.message}`);
      throw new InternalServerErrorException('Unable to resolve appointment visit');
    }
    if (!visit) return { appointmentId: appointment.id, billingLineItem: null, productUsage: [] };

    const [billingLineItem, productUsage] = await Promise.all([
      this.fetchProductUsageLineItem(visit.id),
      this.fetchFormulaProductUsage(visit.id),
    ]);
    return { appointmentId: appointment.id, billingLineItem: billingLineItem ?? null, productUsage };
  }

  /**
   * Per-product grams spent in the finalized mix(es) for a visit, read straight
   * from lab.formula_items (which stores product_name + captured_grams at save
   * time). Aggregated across every saved formula on the visit and sorted by
   * grams desc. Empty when no mix has been finalized yet.
   */
  private async fetchFormulaProductUsage(visitId: string): Promise<FormulaProductUsage[]> {
    const { data: formulas, error: formulasError } = await this.admin
      .schema('lab')
      .from('formulas')
      .select('id')
      .eq('visit_id', visitId)
      .eq('status', 'saved')
      .returns<{ id: string }[]>();

    if (formulasError) {
      this.logger.error(`fetchFormulaProductUsage formulas lookup failed: ${formulasError.message}`);
      throw new InternalServerErrorException('Unable to load formula product usage');
    }

    const formulaIds = (formulas ?? []).map((row) => row.id);
    if (formulaIds.length === 0) return [];

    const { data: items, error: itemsError } = await this.admin
      .schema('lab')
      .from('formula_items')
      .select('product_name,captured_grams')
      .in('formula_id', formulaIds)
      .returns<FormulaItemUsageRow[]>();

    if (itemsError) {
      this.logger.error(`fetchFormulaProductUsage items lookup failed: ${itemsError.message}`);
      throw new InternalServerErrorException('Unable to load formula product usage');
    }

    const gramsByProduct = new Map<string, number>();
    for (const item of items ?? []) {
      const grams = Number(item.captured_grams);
      if (!Number.isFinite(grams) || grams <= 0) continue;
      const name = item.product_name?.trim() || 'Unknown product';
      gramsByProduct.set(name, (gramsByProduct.get(name) ?? 0) + grams);
    }

    return Array.from(gramsByProduct, ([productName, grams]) => ({ productName, grams })).sort(
      (a, b) => b.grams - a.grams,
    );
  }

  async latestForClient(
    actor: AuthUser,
    clientProfileId: string,
  ): Promise<LabClientFormulaHistoryRecord | null> {
    return (await this.historyForClient(actor, clientProfileId))[0] ?? null;
  }

  // A customer's own saved formulas, stripped of cost/waste/billing data before
  // it ever leaves the API. Reuses historyForClient (which already scopes a
  // client to their own clientProfileId) and maps to the client-safe shape.
  async historyForSelf(actor: AuthUser): Promise<ClientLabHistoryResponse> {
    if (!userHasRole(actor, 'client')) {
      throw new ForbiddenException('Lab history requires a client account');
    }
    // A salon-less customer has no client profile (and no formulas) yet — return
    // an empty history so the profile's Lab tab renders instead of erroring.
    if (!actor.clientProfileId) {
      return { formulas: [] };
    }
    const records = await this.historyForClient(actor, actor.clientProfileId);
    return { formulas: records.map(toClientLabFormulaSummary) };
  }

  /**
   * A client's saved colour-formula history over time, read from the durable
   * `lab.formulas` table (not the in-process draft cache) so it persists across
   * restarts, deploys and visits. Each record is enriched with the stylist who
   * mixed it, resolved from the owning visit/appointment. Ordered newest-first.
   *
   * Scope mirrors {@link canReadFormula}: owners see the whole business, a
   * client sees only their own profile, and managers/stylists are bounded to
   * their allowed locations — a DB read can never widen visibility.
   */
  async historyForClient(
    actor: AuthUser,
    clientProfileId: string,
    options: { includeDrafts?: boolean } = {},
  ): Promise<LabClientFormulaHistoryRecord[]> {
    if (userHasRole(actor, 'client') && actor.clientProfileId !== clientProfileId) {
      throw new ForbiddenException('Client formula history is outside your scope');
    }

    let query = this.admin
      .schema('lab')
      .from('formulas')
      .select(SAVED_FORMULA_COLUMNS)
      .eq('business_id', actor.businessId)
      .eq('client_profile_id', clientProfileId)
      // Staff views may include durable drafts (badged); customer-facing and
      // billing-adjacent reads stay finalized-only.
      .in('status', options.includeDrafts ? ['draft', 'saved'] : ['saved'])
      .not('saved_at', 'is', null)
      .order('saved_at', { ascending: false })
      .limit(FORMULA_HISTORY_LIMIT);

    if (!userHasRole(actor, 'owner') && !userHasRole(actor, 'client')) {
      query = query.in('location_id', actor.allowedLocationIds);
    }

    const { data, error } = await query.returns<SavedFormulaRow[]>();
    if (error) {
      this.logger.error(`historyForClient failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load formula history');
    }

    const rows = data ?? [];
    if (rows.length === 0) return [];

    const stylists = await this.resolveFormulaStylists(actor.businessId, rows);
    return rows.map((row) => toHistoryRecord(row, stylists));
  }

  /**
   * Client-safe (cost/waste/billing-stripped) saved formulas for a specific
   * (business, client_profile) pair. The CALLER must have already authorized
   * that the requester owns this client profile — this method does no scope
   * check of its own. Used by the customer self-profile to show a customer their
   * colour history at a chosen salon (which may differ from the single salon
   * their session resolved to).
   */
  async clientSafeHistoryForProfile(
    businessId: string,
    clientProfileId: string,
  ): Promise<ClientLabFormulaSummary[]> {
    const { data, error } = await this.admin
      .schema('lab')
      .from('formulas')
      .select(SAVED_FORMULA_COLUMNS)
      .eq('business_id', businessId)
      .eq('client_profile_id', clientProfileId)
      .eq('status', 'saved')
      .not('saved_at', 'is', null)
      .order('saved_at', { ascending: false })
      .limit(FORMULA_HISTORY_LIMIT)
      .returns<SavedFormulaRow[]>();
    if (error) {
      this.logger.error(`clientSafeHistoryForProfile failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load formula history');
    }
    const rows = data ?? [];
    if (rows.length === 0) return [];
    const stylists = await this.resolveFormulaStylists(businessId, rows);
    return rows.map((row) => toClientLabFormulaSummary(toHistoryRecord(row, stylists)));
  }

  /**
   * Resolves the stylist (and a service label) for each saved formula by joining
   * back to its visit (`primary_staff_profile_id`) or appointment
   * (`assigned_staff_profile_id`) — there is no stylist column on the formula
   * itself. Returned map is keyed by the formula row id.
   */
  private async resolveFormulaStylists(
    businessId: string,
    rows: SavedFormulaRow[],
  ): Promise<Map<string, FormulaStylistContext>> {
    const visitIds = [...new Set(rows.map((row) => row.visit_id).filter((id): id is string => Boolean(id)))];
    const appointmentIds = [
      ...new Set(rows.map((row) => row.appointment_id).filter((id): id is string => Boolean(id))),
    ];

    const [visitRows, appointmentRows] = await Promise.all([
      this.fetchVisitStylists(businessId, visitIds),
      this.fetchAppointmentStylists(businessId, appointmentIds),
    ]);

    const visitById = new Map(visitRows.map((row) => [row.id, row]));
    const appointmentById = new Map(appointmentRows.map((row) => [row.id, row]));

    const staffNames = await this.fetchStaffDisplayNames(businessId, [
      ...visitRows.map((row) => row.primary_staff_profile_id),
      ...appointmentRows.map((row) => row.assigned_staff_profile_id),
    ]);

    const contextByFormula = new Map<string, FormulaStylistContext>();
    for (const row of rows) {
      const visit = row.visit_id ? visitById.get(row.visit_id) : undefined;
      const appointment = row.appointment_id ? appointmentById.get(row.appointment_id) : undefined;
      const staffProfileId =
        visit?.primary_staff_profile_id ?? appointment?.assigned_staff_profile_id ?? undefined;
      const serviceType =
        visit?.service_summary?.trim() ||
        summarizeAppointmentServices(appointment?.appointment_services) ||
        undefined;
      contextByFormula.set(row.id, {
        staffProfileId,
        stylistName: staffProfileId ? staffNames.get(staffProfileId) : undefined,
        serviceType,
      });
    }
    return contextByFormula;
  }

  private async fetchVisitStylists(businessId: string, visitIds: string[]): Promise<VisitStylistRow[]> {
    if (visitIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select('id,primary_staff_profile_id,service_summary')
      .eq('business_id', businessId)
      .in('id', visitIds)
      .returns<VisitStylistRow[]>();

    if (error) {
      this.logger.error(`fetchVisitStylists failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve formula stylists');
    }
    return data ?? [];
  }

  private async fetchAppointmentStylists(
    businessId: string,
    appointmentIds: string[],
  ): Promise<AppointmentStylistRow[]> {
    if (appointmentIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id,assigned_staff_profile_id,appointment_services(service_name_snapshot)')
      .eq('business_id', businessId)
      .in('id', appointmentIds)
      .returns<AppointmentStylistRow[]>();

    if (error) {
      this.logger.error(`fetchAppointmentStylists failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to resolve formula stylists');
    }
    return data ?? [];
  }

  private async fetchStaffDisplayNames(
    businessId: string,
    staffProfileIds: Array<string | null>,
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(staffProfileIds.filter((id): id is string => Boolean(id)))];
    const names = new Map<string, string>();
    if (uniqueIds.length === 0) return names;

    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name')
      .eq('business_id', businessId)
      .in('id', uniqueIds)
      .returns<StaffDisplayNameRow[]>();

    if (error) {
      // Non-fatal: history is still useful without the stylist's display name.
      this.logger.error(`fetchStaffDisplayNames failed: ${error.message}`);
      return names;
    }
    for (const row of data ?? []) {
      if (row.display_name) names.set(row.id, row.display_name);
    }
    return names;
  }

  async duplicate(actor: AuthUser, id: string, dto: DuplicateFormulaDto): Promise<FormulaDraft> {
    await this.resolveFormulaContext(actor, dto);
    const source = this.formulas.get(id);
    if (source && !this.canReadFormula(actor, source)) {
      throw new ForbiddenException('Formula is outside your scope');
    }
    const duplicatedAt = new Date().toISOString();

    return {
      id: `formula_duplicate_${Date.now()}`,
      labSessionId: dto.labSessionId,
      appointmentId: dto.appointmentId,
      clientProfileId: dto.clientProfileId ?? source?.clientProfileId,
      sourceFormulaId: id,
      status: 'draft',
      items: source?.items.map((item, index) => ({
        ...item,
        id: `duplicate_item_${Date.now()}_${index}`,
      })) ?? [],
      currencyCode: source?.currencyCode ?? 'GBP',
      createdAt: duplicatedAt,
      updatedAt: duplicatedAt,
    };
  }

  private validateDraftSavePayload(dto: SaveFormulaDto): void {
    if (!dto.appointmentId && !dto.visitId) {
      throw new BadRequestException('Draft save requires appointment or visit context');
    }

    const items = normalizeItems(dto.items);
    if (items.length === 0) throw new BadRequestException('Draft save requires at least one ingredient');

    for (const item of items) {
      if (!item.productName?.trim()) throw new BadRequestException('Every draft ingredient requires a product name');
      if ((item.capturedGrams ?? 0) < 0 || (item.wasteGrams ?? 0) < 0) {
        throw new BadRequestException('Draft ingredient grams cannot be negative');
      }
    }
  }

  private validateFinalSavePayload(dto: SaveFormulaDto): void {
    if (!dto.appointmentId && !dto.visitId) {
      throw new BadRequestException('Final save requires appointment or visit context');
    }

    const items = normalizeItems(dto.items);
    if (items.length === 0) throw new BadRequestException('Final save requires at least one ingredient');

    for (const item of items) {
      const capturedGrams = item.capturedGrams ?? 0;
      const wasteGrams = item.wasteGrams ?? 0;
      if (!item.productName?.trim()) throw new BadRequestException('Every final ingredient requires a product name');
      if (capturedGrams <= 0 && wasteGrams <= 0) {
        throw new BadRequestException('Every final ingredient requires captured grams or waste grams');
      }
      if (capturedGrams < 0 || wasteGrams < 0) {
        throw new BadRequestException('Final ingredient grams cannot be negative');
      }
      if (item.productId && item.costPerGramCents == null) {
        throw new BadRequestException('Catalogue ingredients require a cost basis before final save');
      }
    }
  }

  private async resolveFormulaContext(
    actor: AuthUser,
    dto: Pick<StartFormulaDto & SaveFormulaDto & DuplicateFormulaDto, 'appointmentId' | 'visitId' | 'businessId' | 'locationId' | 'clientProfileId'>,
    options: { createVisitIfMissing?: boolean } = {},
  ): Promise<FormulaContext> {
    if (dto.businessId && dto.businessId !== actor.businessId) {
      throw new ForbiddenException('Formula business scope does not match the signed-in user');
    }

    if (dto.visitId) return this.resolveVisitFormulaContext(actor, dto.visitId, dto.clientProfileId);
    if (dto.appointmentId) {
      return this.resolveAppointmentFormulaContext(
        actor,
        dto.appointmentId,
        dto.clientProfileId,
        options.createVisitIfMissing ?? true,
      );
    }

    const locationId = dto.locationId ?? actor.allowedLocationIds[0] ?? actor.locations[0]?.id;
    if (!locationId) throw new BadRequestException('locationId is required for formula operations');
    this.assertLocationScope(actor, locationId);

    if (userHasRole(actor, 'client')) {
      if (!actor.clientProfileId || dto.clientProfileId !== actor.clientProfileId) {
        throw new ForbiddenException('Client formula scope is limited to your own profile');
      }
    }

    return {
      businessId: actor.businessId,
      locationId,
      clientProfileId: dto.clientProfileId,
    };
  }

  private async resolveAppointmentFormulaContext(
    actor: AuthUser,
    appointmentId: string,
    requestedClientProfileId?: string,
    createVisitIfMissing = true,
  ): Promise<FormulaContext> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id,business_id,location_id,client_profile_id,assigned_staff_profile_id,appointment_services(service_name_snapshot)')
      .eq('id', appointmentId)
      .eq('business_id', actor.businessId)
      .maybeSingle<AppointmentFormulaContextRow>();

    if (error) {
      this.logger.error(`resolveAppointmentFormulaContext failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate formula appointment scope');
    }
    if (!data) throw new BadRequestException('appointmentId is not valid for this business');
    if (requestedClientProfileId && requestedClientProfileId !== data.client_profile_id) {
      throw new BadRequestException('clientProfileId does not match appointment');
    }
    this.assertLocationScope(actor, data.location_id);
    if (userHasRole(actor, 'stylist') && data.assigned_staff_profile_id !== actor.staffProfileId) {
      throw new ForbiddenException('Appointment is outside your stylist scope');
    }
    if (userHasRole(actor, 'client') && data.client_profile_id !== actor.clientProfileId) {
      throw new ForbiddenException('Appointment is outside your client scope');
    }

    const visitId = await this.ensureVisitForAppointment(data, createVisitIfMissing);

    return {
      businessId: data.business_id,
      locationId: data.location_id,
      appointmentId: data.id,
      visitId,
      clientProfileId: data.client_profile_id,
    };
  }

  private async resolveVisitFormulaContext(
    actor: AuthUser,
    visitId: string,
    requestedClientProfileId?: string,
  ): Promise<FormulaContext> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('visits')
      .select('business_id,location_id,client_profile_id,primary_staff_profile_id,appointment_id')
      .eq('id', visitId)
      .eq('business_id', actor.businessId)
      .maybeSingle<VisitFormulaContextRow>();

    if (error) {
      this.logger.error(`resolveVisitFormulaContext failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to validate formula visit scope');
    }
    if (!data) throw new BadRequestException('visitId is not valid for this business');
    if (requestedClientProfileId && requestedClientProfileId !== data.client_profile_id) {
      throw new BadRequestException('clientProfileId does not match visit');
    }
    this.assertLocationScope(actor, data.location_id);
    if (userHasRole(actor, 'stylist') && data.primary_staff_profile_id !== actor.staffProfileId) {
      throw new ForbiddenException('Visit is outside your stylist scope');
    }
    if (userHasRole(actor, 'client') && data.client_profile_id !== actor.clientProfileId) {
      throw new ForbiddenException('Visit is outside your client scope');
    }

    return {
      businessId: data.business_id,
      locationId: data.location_id,
      appointmentId: data.appointment_id ?? undefined,
      visitId: data.id,
      clientProfileId: data.client_profile_id,
    };
  }

  private async ensureVisitForAppointment(
    appointment: AppointmentFormulaContextRow,
    createIfMissing = true,
  ): Promise<string | undefined> {
    const { data: existing, error: existingError } = await this.admin
      .schema('booking')
      .from('visits')
      .select('id')
      .eq('appointment_id', appointment.id)
      .maybeSingle<{ id: string }>();

    if (existingError) {
      this.logger.error(`ensureVisitForAppointment lookup failed: ${existingError.message}`);
      throw new InternalServerErrorException('Unable to resolve appointment visit');
    }
    if (existing) return existing.id;
    if (!createIfMissing) return undefined;

    const { data: created, error: createError } = await this.admin
      .schema('booking')
      .from('visits')
      .insert({
        business_id: appointment.business_id,
        location_id: appointment.location_id,
        appointment_id: appointment.id,
        client_profile_id: appointment.client_profile_id,
        primary_staff_profile_id: appointment.assigned_staff_profile_id,
        status: 'checked_in',
        source: 'sheer_lab_formula',
        service_summary: summarizeAppointmentServices(appointment.appointment_services),
      })
      .select('id')
      .single<{ id: string }>();

    if (createError || !created) {
      this.logger.error(`ensureVisitForAppointment create failed: ${createError?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create formula visit');
    }

    return created.id;
  }

  private async buildFormulaSaveResult(
    formula: FormulaHistoryRecord,
    rpcResult: unknown,
    locationId: string,
  ): Promise<FormulaSaveResult> {
    const result = toRpcResult(rpcResult);
    const persistedFormulaId = result.persistedFormulaId;
    const billableChargeCents = toNumber(result.billableChargeCents) ?? formula.billableChargeCents ?? 0;
    const totalCostCents = toNumber(result.actualCostCents) ?? formula.totalCostCents ?? 0;
    const totalWasteCostCents = toNumber(result.wasteCostCents) ?? formula.totalWasteCostCents ?? 0;
    const visitId = result.visitId ?? formula.visitId;
    const currencyCode = result.currencyCode ?? formula.currencyCode;

    const [movements, lowStockAlerts, billingLineItem] = await Promise.all([
      persistedFormulaId ? this.fetchFormulaMovements(persistedFormulaId) : Promise.resolve([]),
      this.fetchOpenLowStockAlerts(
        locationId,
        formula.items.map((item) => item.productId).filter((id): id is string => Boolean(id)),
      ),
      visitId ? this.fetchProductUsageLineItem(visitId) : Promise.resolve(undefined),
    ]);

    return {
      ...formula,
      visitId,
      totalCostCents,
      totalWasteCostCents,
      billableChargeCents,
      chargePreviewCents: billableChargeCents,
      currencyCode,
      billingStatus: result.billingApplied ? 'applied' : 'not_requested',
      inventoryStatus: formula.inventoryStatus,
      billingLineItem,
      inventoryMovements: movements,
      lowStockAlerts,
    };
  }

  private async fetchFormulaMovements(persistedFormulaId: string): Promise<FormulaSaveResult['inventoryMovements']> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('stock_movements')
      .select('product_id,quantity_delta_grams,movement_type')
      .eq('formula_id', persistedFormulaId)
      .in('movement_type', ['formula_usage', 'formula_waste', 'formula_reversal'])
      .returns<FormulaMovementRow[]>();

    if (error) {
      this.logger.error(`fetchFormulaMovements failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load formula inventory movements');
    }

    return (data ?? []).map((row) => ({
      productId: row.product_id,
      quantityDeltaGrams: Number(row.quantity_delta_grams),
      movementType: row.movement_type,
    }));
  }

  private async fetchOpenLowStockAlerts(
    locationId: string,
    productIds: string[],
  ): Promise<FormulaSaveResult['lowStockAlerts']> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return [];

    const { data, error } = await this.admin
      .schema('inventory')
      .from('low_stock_alerts')
      .select('product_id,remaining_quantity_grams,threshold_quantity_grams')
      .eq('location_id', locationId)
      .eq('status', 'open')
      .in('product_id', ids)
      .returns<FormulaLowStockAlertRow[]>();

    if (error) {
      this.logger.error(`fetchOpenLowStockAlerts failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load formula low-stock alerts');
    }

    return (data ?? []).map((row) => ({
      productId: row.product_id,
      remainingQuantityGrams: Number(row.remaining_quantity_grams),
      thresholdQuantityGrams: Number(row.threshold_quantity_grams),
    }));
  }

  private async fetchProductUsageLineItem(
    visitId: string,
  ): Promise<FormulaSaveResult['billingLineItem'] | undefined> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('visit_line_items')
      .select('visit_id,amount_cents,currency_code,formula_breakdown,updated_at')
      .eq('visit_id', visitId)
      .eq('line_type', 'product_usage')
      .maybeSingle<FormulaVisitLineItemRow>();

    if (error) {
      this.logger.error(`fetchProductUsageLineItem failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load product usage line item');
    }
    if (!data) return undefined;

    return {
      visitId: data.visit_id,
      amountCents: data.amount_cents,
      currencyCode: data.currency_code,
      formulaBreakdown: parseFormulaBreakdown(data.formula_breakdown),
      updatedAt: data.updated_at,
    };
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (userHasRole(actor, 'owner')) return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Formula location is outside your scope');
    }
  }

  private canReadFormula(actor: AuthUser, formula: FormulaDraft | FormulaHistoryRecord): boolean {
    if (formula.businessId !== actor.businessId) return false;
    if (userHasRole(actor, 'owner')) return true;
    if (userHasRole(actor, 'client')) return formula.clientProfileId === actor.clientProfileId;
    return Boolean(formula.locationId && actor.allowedLocationIds.includes(formula.locationId));
  }

  private async fetchProductBillingRules(
    businessId: string,
    locationId: string,
  ): Promise<ProductBillingRulesRow | null> {
    const { data, error } = await this.admin
      .schema('billing')
      .from('billing_rules')
      .select(
        'product_billing_enabled,product_billing_rule,product_markup_percent,product_fixed_uplift_amount,product_round_up_enabled,product_round_up_increment',
      )
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .maybeSingle<ProductBillingRulesRow>();

    if (error) {
      this.logger.warn(`fetchProductBillingRules failed: ${error.message} — skipping product billing`);
      return null;
    }
    return data;
  }

  private async applyProductBillingLineItem(
    businessId: string,
    locationId: string,
    visitId: string,
    productCostAmountCents: number,
    currencyCode: string,
  ): Promise<void> {
    const rules = await this.fetchProductBillingRules(businessId, locationId);
    if (!rules || !rules.product_billing_enabled) return;

    const rule = rules.product_billing_rule as ProductBillingRule;
    const snapshot = buildProductBillingSnapshot(
      productCostAmountCents,
      rule,
      rules.product_markup_percent,
      rules.product_fixed_uplift_amount,
      rules.product_round_up_enabled ?? false,
      rules.product_round_up_increment,
    );

    const { error } = await this.admin
      .schema('billing')
      .from('visit_line_items')
      .upsert(
        {
          business_id: businessId,
          location_id: locationId,
          visit_id: visitId,
          line_type: 'product_usage',
          description: 'Product usage',
          amount_cents: snapshot.billableAmountCents,
          currency_code: currencyCode,
          cost_amount_cents: snapshot.costAmountCents,
          billable_amount_cents: snapshot.billableAmountCents,
          billing_rule_snapshot: snapshot.billingRuleSnapshot,
          markup_percent_snapshot: snapshot.markupPercentSnapshot,
          fixed_uplift_amount_snapshot: snapshot.fixedUpliftAmountSnapshot,
          round_up_enabled_snapshot: snapshot.roundUpEnabledSnapshot,
          round_up_increment_snapshot: snapshot.roundUpIncrementSnapshot,
        },
        { onConflict: 'visit_id,line_type' },
      );

    if (error) {
      this.logger.error(`applyProductBillingLineItem failed: ${error.message}`);
    }
  }
}

// Rebuilds a durable saved formula (+ its resolved stylist) from a DB row so the
// history read matches the in-memory FormulaHistoryRecord shape callers expect.
function toHistoryRecord(
  row: SavedFormulaRow,
  stylists: Map<string, FormulaStylistContext>,
): LabClientFormulaHistoryRecord {
  const stylist = stylists.get(row.id) ?? {};
  return {
    id: row.external_formula_id ?? row.id,
    labSessionId: row.lab_session_id ?? '',
    appointmentId: row.appointment_id ?? undefined,
    visitId: row.visit_id ?? undefined,
    businessId: row.business_id,
    locationId: row.location_id,
    clientProfileId: row.client_profile_id,
    sourceFormulaId: row.source_formula_id ?? undefined,
    notes: row.notes ?? undefined,
    status: 'saved',
    isDraft: row.status === 'draft',
    items: (row.formula_items ?? []).map(toFormulaItemFromRow),
    totalCostCents: row.actual_cost_cents,
    totalWasteCostCents: row.waste_cost_cents,
    billableChargeCents: row.billable_charge_cents,
    chargePreviewCents: row.billable_charge_cents,
    currencyCode: row.currency_code,
    visit: {
      appointmentId: row.appointment_id ?? undefined,
      visitId: row.visit_id ?? undefined,
      serviceType: stylist.serviceType,
    },
    savedAt: row.saved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    staffProfileId: stylist.staffProfileId,
    stylistName: stylist.stylistName,
  };
}

function toFormulaItemFromRow(row: SavedFormulaItemRow): FormulaItem {
  return {
    id: row.external_item_id ?? row.id,
    productId: row.product_id ?? undefined,
    productName: row.product_name,
    brand: row.brand ?? undefined,
    shade: row.shade ?? undefined,
    developer: row.developer ?? undefined,
    ratio: row.ratio ?? undefined,
    processingTimeMinutes: row.processing_time_minutes ?? undefined,
    capturedGrams: toNumber(row.captured_grams),
    wasteGrams: toNumber(row.waste_grams),
    entryMode: row.entry_mode,
    capturedAt: row.captured_at ?? undefined,
    costPerGramCents: row.cost_per_gram_cents ?? undefined,
    costCents: row.cost_cents,
    wasteCostCents: row.waste_cost_cents,
    notes: row.notes ?? undefined,
  };
}

function normalizeItems(items: unknown[] | undefined): FormulaItem[] {
  if (!items) return [];

  return items.filter(isFormulaItem);
}

function isFormulaItem(item: unknown): item is FormulaItem {
  if (!item || typeof item !== 'object') return false;

  const maybeItem = item as Partial<FormulaItem>;
  return typeof maybeItem.id === 'string' && typeof maybeItem.productName === 'string';
}

function sumItemCostCents(items: FormulaItem[]): number {
  return items.reduce((sum, item) => sum + (item.costCents ?? 0), 0);
}

function sumWasteCostCents(items: FormulaItem[]): number {
  return items.reduce((sum, item) => sum + (item.wasteCostCents ?? 0), 0);
}

function summarizeAppointmentServices(
  services: AppointmentFormulaContextRow['appointment_services'],
): string | null {
  const rows = Array.isArray(services) ? services : services ? [services] : [];
  const summary = rows.map((service) => service.service_name_snapshot).filter(Boolean).join(' + ');
  return summary || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function toRpcResult(value: unknown): FormulaReconciliationRpcResult {
  if (!isRecord(value)) return {};
  return {
    formulaId: toStringValue(value.formulaId),
    persistedFormulaId: toStringValue(value.persistedFormulaId),
    actualCostCents: toNumber(value.actualCostCents),
    wasteCostCents: toNumber(value.wasteCostCents),
    billableChargeCents: toNumber(value.billableChargeCents),
    currencyCode: toStringValue(value.currencyCode),
    billingApplied: value.billingApplied === true,
    visitId: toStringValue(value.visitId),
  };
}

function parseFormulaBreakdown(value: unknown): FormulaBillingBreakdown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const formulaId = toStringValue(entry.formulaId);
    const actualCostCents = toNumber(entry.actualCostCents);
    const billableChargeCents = toNumber(entry.billableChargeCents);
    const currencyCode = toStringValue(entry.currencyCode);
    if (!formulaId || actualCostCents == null || billableChargeCents == null || !currencyCode) return [];
    return [{ formulaId, actualCostCents, billableChargeCents, currencyCode }];
  });
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function toAuthUserFromLabSession(session: LabRuntimeSession): AuthUser {
  return {
    id: session.userProfileId,
    roles: [session.role],
    primaryRole: session.role,
    businessId: session.businessId,
    allowedLocationIds: [session.locationId],
    locationScope: { kind: 'locations', locationIds: [session.locationId] },
    locations: [{ id: session.locationId, name: 'Qlooqo Lab location' }],
    profile: {
      id: session.userProfileId,
      email: 'sheer-lab-session@local',
      fullName: 'Qlooqo Lab session',
    },
    staffProfileId: session.staffProfileId,
    permissions: session.permissions,
  };
}

// Projects a saved formula down to the fields a client may see. Cost, waste,
// grams, billing and inventory data are deliberately dropped here.
function toClientLabFormulaSummary(record: FormulaHistoryRecord): ClientLabFormulaSummary {
  return {
    id: record.id,
    savedAt: record.savedAt,
    serviceType: record.visit?.serviceType,
    appointmentId: record.appointmentId,
    visitId: record.visitId,
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
