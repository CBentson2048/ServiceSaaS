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
    const context = await this.resolveFormulaContext(actor, dto);
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

    if (result.visitId && totalCostCents > 0) {
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

  latestForClient(actor: AuthUser, clientProfileId: string): FormulaHistoryRecord | null {
    return this.historyForClient(actor, clientProfileId)[0] ?? null;
  }

  // A customer's own saved formulas, stripped of cost/waste/billing data before
  // it ever leaves the API. Reuses historyForClient (which already scopes a
  // client to their own clientProfileId) and maps to the client-safe shape.
  historyForSelf(actor: AuthUser): ClientLabHistoryResponse {
    if (!userHasRole(actor, 'client') || !actor.clientProfileId) {
      throw new ForbiddenException('Lab history requires a client account');
    }
    const records = this.historyForClient(actor, actor.clientProfileId);
    return { formulas: records.map(toClientLabFormulaSummary) };
  }

  historyForClient(actor: AuthUser, clientProfileId: string): FormulaHistoryRecord[] {
    if (userHasRole(actor, 'client') && actor.clientProfileId !== clientProfileId) {
      throw new ForbiddenException('Client formula history is outside your scope');
    }
    return Array.from(this.formulas.values())
      .filter(
        (formula): formula is FormulaHistoryRecord =>
          formula.status === 'saved' &&
          formula.clientProfileId === clientProfileId &&
          formula.businessId === actor.businessId &&
          this.canReadFormula(actor, formula) &&
          Boolean(formula.savedAt),
      )
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
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
  ): Promise<FormulaContext> {
    if (dto.businessId && dto.businessId !== actor.businessId) {
      throw new ForbiddenException('Formula business scope does not match the signed-in user');
    }

    if (dto.visitId) return this.resolveVisitFormulaContext(actor, dto.visitId, dto.clientProfileId);
    if (dto.appointmentId) return this.resolveAppointmentFormulaContext(actor, dto.appointmentId, dto.clientProfileId);

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

    const visitId = await this.ensureVisitForAppointment(data);

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

  private async ensureVisitForAppointment(appointment: AppointmentFormulaContextRow): Promise<string> {
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
    locations: [{ id: session.locationId, name: 'Sheer Lab location' }],
    profile: {
      id: session.userProfileId,
      email: 'sheer-lab-session@local',
      fullName: 'Sheer Lab session',
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
