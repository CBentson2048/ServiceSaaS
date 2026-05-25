import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import {
  calculateFormulaBillableChargeCents,
  createFormulaDraft,
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

interface FormulaContext {
  businessId: string;
  locationId: string;
  clientProfileId?: string;
}

interface AppointmentFormulaContextRow {
  business_id: string;
  location_id: string;
  client_profile_id: string;
  assigned_staff_profile_id: string | null;
}

interface VisitFormulaContextRow {
  business_id: string;
  location_id: string;
  client_profile_id: string;
  primary_staff_profile_id: string | null;
  appointment_id: string | null;
}

@Injectable()
export class LabFormulaService {
  private readonly logger = new Logger(LabFormulaService.name);
  private readonly admin: SupabaseClient;
  private readonly formulas = new Map<string, FormulaDraft | FormulaHistoryRecord>();
  private readonly visitLineItems = new Map<string, { amountCents: number; formulaBreakdown: unknown[] }>();

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
      appointmentId: dto.appointmentId,
      visitId: dto.visitId,
      businessId: context.businessId,
      locationId: context.locationId,
      clientProfileId: context.clientProfileId ?? dto.clientProfileId,
      sourceFormulaId: dto.sourceFormulaId,
      status: 'saved',
      items: normalizeItems(dto.items),
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

    this.formulas.set(formula.id, formula);

    const fallbackResult = this.applyInMemoryReconciliation(formula, dto);

    try {
      const { error } = await this.admin.rpc('save_formula_with_reconciliation', {
        p_payload: {
          ...dto,
          formulaId: id,
          businessId: context.businessId,
          locationId: context.locationId,
          clientProfileId: context.clientProfileId ?? dto.clientProfileId,
          totalCostCents,
          totalWasteCostCents,
          billableChargeCents,
        },
      });

      if (error) {
        this.logger.warn(`save_formula_with_reconciliation failed, using in-memory fallback: ${error.message}`);
      }
    } catch (error) {
      this.logger.warn(`save_formula_with_reconciliation unavailable, using in-memory fallback: ${String(error)}`);
    }

    return fallbackResult;
  }

  recalculate(id: string) {
    // TODO: recalculate charge preview from product usage and location billing rules.
    return { formulaId: id, chargePreviewCents: 4250, currencyCode: 'GBP' };
  }

  latestForClient(actor: AuthUser, clientProfileId: string): FormulaHistoryRecord | null {
    return this.historyForClient(actor, clientProfileId)[0] ?? null;
  }

  historyForClient(actor: AuthUser, clientProfileId: string): FormulaHistoryRecord[] {
    if (actor.role === 'client' && actor.clientProfileId !== clientProfileId) {
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

  private applyInMemoryReconciliation(formula: FormulaHistoryRecord, dto: SaveFormulaDto): FormulaSaveResult {
    const visitId = formula.visitId;
    const visitFormulas = Array.from(this.formulas.values()).filter(
      (candidate): candidate is FormulaHistoryRecord =>
        candidate.status === 'saved' && Boolean(visitId) && candidate.visitId === visitId,
    );
    const formulaBreakdown = visitFormulas.map((candidate) => ({
      formulaId: candidate.id,
      actualCostCents: candidate.totalCostCents ?? 0,
      billableChargeCents: candidate.billableChargeCents ?? candidate.totalCostCents ?? 0,
      currencyCode: candidate.currencyCode,
    }));
    const amountCents = formulaBreakdown.reduce((sum, item) => sum + item.billableChargeCents, 0);

    if (visitId && dto.billingHandoffRequested) {
      this.visitLineItems.set(visitId, { amountCents, formulaBreakdown });
    }

    return {
      ...formula,
      billingLineItem:
        visitId && dto.billingHandoffRequested
          ? {
              visitId,
              amountCents,
              currencyCode: formula.currencyCode,
              formulaBreakdown,
              updatedAt: new Date().toISOString(),
            }
          : undefined,
      inventoryMovements: formula.items
        .filter((item) => item.productId && ((item.capturedGrams ?? 0) > 0 || (item.wasteGrams ?? 0) > 0))
        .flatMap((item) => [
          {
            productId: item.productId ?? '',
            quantityDeltaGrams: -(item.capturedGrams ?? 0),
            movementType: 'formula_usage' as const,
          },
          ...(item.wasteGrams
            ? [
                {
                  productId: item.productId ?? '',
                  quantityDeltaGrams: -item.wasteGrams,
                  movementType: 'formula_waste' as const,
                },
              ]
            : []),
        ]),
      lowStockAlerts: [],
    };
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

    if (actor.role === 'client') {
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
      .select('business_id,location_id,client_profile_id,assigned_staff_profile_id')
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
    if (actor.role === 'stylist' && data.assigned_staff_profile_id !== actor.staffProfileId) {
      throw new ForbiddenException('Appointment is outside your stylist scope');
    }
    if (actor.role === 'client' && data.client_profile_id !== actor.clientProfileId) {
      throw new ForbiddenException('Appointment is outside your client scope');
    }

    return {
      businessId: data.business_id,
      locationId: data.location_id,
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
    if (actor.role === 'stylist' && data.primary_staff_profile_id !== actor.staffProfileId) {
      throw new ForbiddenException('Visit is outside your stylist scope');
    }
    if (actor.role === 'client' && data.client_profile_id !== actor.clientProfileId) {
      throw new ForbiddenException('Visit is outside your client scope');
    }

    return {
      businessId: data.business_id,
      locationId: data.location_id,
      clientProfileId: data.client_profile_id,
    };
  }

  private assertLocationScope(actor: AuthUser, locationId: string): void {
    if (actor.role === 'owner') return;
    if (!actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Formula location is outside your scope');
    }
  }

  private canReadFormula(actor: AuthUser, formula: FormulaDraft | FormulaHistoryRecord): boolean {
    if (formula.businessId !== actor.businessId) return false;
    if (actor.role === 'owner') return true;
    if (actor.role === 'client') return formula.clientProfileId === actor.clientProfileId;
    return Boolean(formula.locationId && actor.allowedLocationIds.includes(formula.locationId));
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
