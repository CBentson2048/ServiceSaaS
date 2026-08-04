/**
 * Pay-structure authoring: create-from-template, version lifecycle, live
 * preview and staff assignment.
 *
 * Semantic validation happens HERE (the DTO layer 0071 promised): stage
 * configs must match the ratified contracts in @sheer/domain, band bounds
 * must match the stage's threshold basis, thresholds must ascend, hour rules
 * must cover all eight categories, and unsatisfiable options (tips stages,
 * discount bases with no data) are refused with a reason — the authoring
 * mirror of the "never a misleading £0" rule.
 *
 * Version lifecycle: rules freeze once a pay run prices them
 * (assert_rule_version_unused). Changing rates = close the current version at
 * a date and insert version N+1 — never edit in place. The DB's freeze
 * refusal is mapped to a 409 with that instruction instead of surfacing as a
 * 500.
 */

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
import { SupabaseClient, createClient } from '@supabase/supabase-js';
import type {
  AssignPayStructureResponse,
  AuthUser,
  CreatePayStructureRequest,
  CreatePayStructureVersionRequest,
  HourCategory,
  PayStructureDetailResponse,
  PayStructurePreviewRequest,
  PayStructurePreviewResponse,
  PayStructureRulesInput,
  PayStructureStageInput,
  PayStructureVersionDetail,
  PayrollDataSource,
  ThresholdBasis,
} from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { PayrollInputsService } from './payroll-inputs.service';
import {
  calculatePaySummary,
  type EngineInput,
  type ResolvedRuleVersion,
  type ResolvedStage,
} from './payroll.calc';
import { numOrNull, numOrZero } from './payroll-money';
import { isBefore, isLocalDate } from './period-dates';

const ALL_HOUR_CATEGORIES: HourCategory[] = [
  'worked',
  'paid_holiday',
  'unpaid_leave',
  'sickness',
  'training',
  'authorised_absence',
  'additional',
  'manual_adjustment',
];

/** Bound column each threshold basis requires (mirrors the DB trigger). */
const BASIS_BOUND: Record<ThresholdBasis, 'fromMultiple' | 'fromAmountCents' | 'fromPercent'> = {
  multiple_of_base_pay: 'fromMultiple',
  absolute: 'fromAmountCents',
  per_client: 'fromAmountCents',
  percent_of_service_target: 'fromPercent',
  percent_of_service_revenue: 'fromPercent',
};

@Injectable()
export class PayrollStructuresService {
  private readonly logger = new Logger(PayrollStructuresService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly inputs: PayrollInputsService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // ---------------------------------------------------------------------------
  // Semantic validation (the authoring contract)
  // ---------------------------------------------------------------------------

  validateRules(rules: PayStructureRulesInput): void {
    if (!isLocalDate(rules.effectiveFrom)) {
      throw new BadRequestException('effectiveFrom must be YYYY-MM-DD');
    }
    if ((rules.discountBasis ?? 'headline_before_discount') !== 'headline_before_discount') {
      throw new BadRequestException(
        'Only headline_before_discount is supported: discount amounts are not captured yet, so other bases would silently mis-pay',
      );
    }
    if (!rules.stages || rules.stages.length === 0) {
      throw new BadRequestException('A pay structure needs at least one stage');
    }

    const covered = new Set(rules.hourRules?.map((r) => r.category) ?? []);
    const missing = ALL_HOUR_CATEGORIES.filter((c) => !covered.has(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Hour rules must cover all eight categories (missing: ${missing.join(', ')}) — absence is not a default`,
      );
    }

    let basePayCount = 0;
    let greaterOfCount = 0;
    rules.stages.forEach((stage, index) => {
      const where = `Stage ${index + 1} (${stage.stageType})`;
      switch (stage.stageType) {
        case 'tips_payout':
          throw new BadRequestException(
            `${where}: tips are not captured yet; a tips stage would only ever render "source not captured"`,
          );
        case 'base_pay': {
          basePayCount += 1;
          this.assertNoCommissionFields(stage, where);
          const source = stage.config?.['source'] ?? 'hourly_rate_x_payable_hours';
          if (source === 'fixed_amount') {
            this.assertPositiveConfigAmount(stage, where);
          } else if (source !== 'hourly_rate_x_payable_hours') {
            throw new BadRequestException(
              `${where}: config.source must be hourly_rate_x_payable_hours or fixed_amount`,
            );
          }
          break;
        }
        case 'commission': {
          if (!stage.tierSemantics || !stage.thresholdBasis || !stage.revenueStream) {
            throw new BadRequestException(
              `${where}: commission stages need tierSemantics, thresholdBasis and revenueStream`,
            );
          }
          if (!stage.bands || stage.bands.length === 0) {
            throw new BadRequestException(`${where}: commission stages need at least one band`);
          }
          const bound = BASIS_BOUND[stage.thresholdBasis];
          let previous = -Infinity;
          stage.bands.forEach((band, bandIndex) => {
            const set = (['fromMultiple', 'fromAmountCents', 'fromPercent'] as const).filter(
              (key) => band[key] !== null && band[key] !== undefined,
            );
            if (set.length !== 1 || set[0] !== bound) {
              throw new BadRequestException(
                `${where}, band ${bandIndex + 1}: exactly ${bound} must be set for a ${stage.thresholdBasis} stage`,
              );
            }
            const value = band[bound]!;
            if (value < 0) {
              throw new BadRequestException(`${where}, band ${bandIndex + 1}: bound must be >= 0`);
            }
            if (value <= previous) {
              throw new BadRequestException(
                `${where}: band thresholds must strictly ascend (band ${bandIndex + 1} does not)`,
              );
            }
            previous = value;
            if (band.ratePercent < 0 || band.ratePercent > 100) {
              throw new BadRequestException(`${where}, band ${bandIndex + 1}: rate must be 0-100`);
            }
          });
          if (stage.accelerator) {
            const acc = stage.accelerator;
            if (acc.conditions.length === 0) {
              throw new BadRequestException(`${where}: an accelerator needs conditions`);
            }
            if (acc.evaluationMode === 'at_least_n' && !acc.requiredConditionCount) {
              throw new BadRequestException(`${where}: at_least_n needs requiredConditionCount`);
            }
            if (acc.evaluationMode === 'weighted' && acc.requiredScore === undefined) {
              throw new BadRequestException(`${where}: weighted needs requiredScore`);
            }
            if (
              (acc.evaluationMode === 'all' || acc.evaluationMode === 'any') &&
              (acc.requiredConditionCount != null || acc.requiredScore != null)
            ) {
              throw new BadRequestException(
                `${where}: ${acc.evaluationMode} accelerators take no count/score parameters`,
              );
            }
            if (acc.evaluationMode === 'custom') {
              throw new BadRequestException(
                `${where}: custom accelerator rules have no engine semantics yet`,
              );
            }
            for (const condition of acc.conditions) {
              const needsThreshold =
                condition.basis !== 'staff_benchmark' && condition.basis !== 'target_met';
              if (needsThreshold && condition.thresholdValue == null) {
                throw new BadRequestException(
                  `${where}: condition on ${condition.metric} needs a thresholdValue`,
                );
              }
            }
          }
          break;
        }
        case 'revenue_split': {
          this.assertNoCommissionFields(stage, where);
          const split = numOrNull(stage.config?.['split_percent'] as never);
          if (split === null || split <= 0 || split > 100) {
            throw new BadRequestException(`${where}: config.split_percent must be 1-100`);
          }
          break;
        }
        case 'chair_rent': {
          this.assertNoCommissionFields(stage, where);
          this.assertPositiveConfigAmount(stage, where);
          const cadence = stage.config?.['cadence'] ?? 'per_period';
          if (cadence !== 'per_period') {
            throw new BadRequestException(
              `${where}: only per_period rent is supported this phase`,
            );
          }
          break;
        }
        case 'deduction': {
          this.assertNoCommissionFields(stage, where);
          const source = stage.config?.['source'];
          if (source === 'product_cost') break;
          if (source === 'fixed') {
            this.assertPositiveConfigAmount(stage, where);
            break;
          }
          throw new BadRequestException(
            `${where}: config.source must be product_cost or fixed`,
          );
        }
        case 'bonus': {
          this.assertNoCommissionFields(stage, where);
          if (stage.config?.['source'] !== 'fixed') {
            throw new BadRequestException(`${where}: config.source must be fixed`);
          }
          this.assertPositiveConfigAmount(stage, where);
          break;
        }
        case 'greater_of': {
          greaterOfCount += 1;
          this.assertNoCommissionFields(stage, where);
          if (stage.inGreaterOfComparison) {
            throw new BadRequestException(
              `${where}: the greater_of stage itself cannot be in the comparison`,
            );
          }
          break;
        }
      }
    });

    if (basePayCount > 1) {
      throw new BadRequestException('A pipeline supports one base_pay stage');
    }
    if (greaterOfCount > 1) {
      throw new BadRequestException('A pipeline supports one greater_of stage');
    }
    const comparisonCount = rules.stages.filter((s) => s.inGreaterOfComparison).length;
    if (greaterOfCount === 1 && comparisonCount < 2) {
      throw new BadRequestException(
        'A greater_of stage needs at least two stages marked inGreaterOfComparison',
      );
    }
    if (greaterOfCount === 0 && comparisonCount > 0) {
      throw new BadRequestException(
        'Stages are marked inGreaterOfComparison but there is no greater_of stage',
      );
    }
  }

  private assertNoCommissionFields(stage: PayStructureStageInput, where: string): void {
    if (stage.tierSemantics || stage.thresholdBasis || stage.revenueStream) {
      throw new BadRequestException(
        `${where}: tierSemantics/thresholdBasis/revenueStream belong to commission stages only`,
      );
    }
    if (stage.bands && stage.bands.length > 0) {
      throw new BadRequestException(`${where}: only commission stages carry bands`);
    }
    if (stage.accelerator) {
      throw new BadRequestException(`${where}: only commission stages carry accelerators`);
    }
  }

  private assertPositiveConfigAmount(stage: PayStructureStageInput, where: string): void {
    const amount = numOrNull(stage.config?.['amount_cents'] as never);
    if (amount === null || amount <= 0 || !Number.isInteger(amount)) {
      throw new BadRequestException(
        `${where}: config.amount_cents must be a positive integer (minor units)`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Preview — the wizard's live worked example, run through the REAL engine
  // ---------------------------------------------------------------------------

  preview(request: PayStructurePreviewRequest): PayStructurePreviewResponse {
    this.validateRules(request.rules);
    const sample = request.sample ?? {};
    const version = this.rulesToResolvedVersion(request.rules, 'preview');

    const workedHours = sample.workedHours ?? 40;
    const engineInput: EngineInput = {
      period: { periodStart: '2026-07-28', periodEnd: '2026-08-04' },
      currencyCode: 'GBP',
      staff: {
        staffProfileId: 'preview-staff',
        staffName: 'Sample stylist',
        employmentType: 'employed',
        hourlyRateCents: sample.hourlyRateCents ?? 1221,
        contractedHours: workedHours,
        averageBillBenchmarkCents: sample.averageBillBenchmarkCents ?? null,
      },
      version,
      hours: ALL_HOUR_CATEGORIES.map((category) => ({
        category,
        hours: category === 'worked' ? workedHours : 0,
        notes: null,
      })),
      serviceLines: [
        {
          sourceType: 'visit',
          sourceId: 'preview-visit',
          occurredOn: '2026-07-30',
          label: 'Sample service revenue',
          headlineAmountCents: sample.serviceRevenueCents ?? 180_000,
          actualAmountCents: sample.serviceRevenueCents ?? 180_000,
          amountsIncludeTax: false,
          taxRatePercent: 20,
        },
      ],
      retailRevenueCents: sample.retailRevenueCents ?? 0,
      productCostCents: null,
      // Illustration: treat every source as captured so drafted rules show
      // figures; the live engine still applies the real capture matrix.
      capture: {
        service_revenue: true,
        retail_sales: true,
        tips: true,
        refunds: true,
        cancellation_fees: true,
        product_cost: true,
      },
      metrics: {
        rebookingRatePercent: sample.rebookingRatePercent ?? null,
        averageBillCents: sample.averageBillCents ?? null,
        utilisationPercent: null,
        clientCount: sample.clientCount ?? null,
      },
      adjustments: [],
      trackingTargetCents: null,
      totalCollectedCents: sample.serviceRevenueCents ?? 180_000,
      serviceRevenueVariance: null,
    };

    const result = calculatePaySummary(engineInput);
    if (!result.ok || !result.figures) {
      throw new BadRequestException({
        message: 'These rules cannot be calculated with the sample inputs',
        warnings: result.warnings,
      });
    }
    return {
      illustrative: true,
      netPayableCents: result.figures.netPayableCents,
      basePayCents: result.figures.basePayCents,
      commissionCents: result.figures.commissionCents,
      revenueSplitCents: result.figures.revenueSplitCents,
      bonusCents: result.figures.bonusCents,
      chairRentCents: result.figures.chairRentCents,
      deductionsCents: result.figures.deductionsCents,
      target: result.target,
      bands: result.bands,
      accelerator: result.accelerator,
      greaterOf: result.greaterOf,
      warnings: result.warnings,
    };
  }

  private rulesToResolvedVersion(
    rules: PayStructureRulesInput,
    idPrefix: string,
  ): ResolvedRuleVersion {
    const stages: ResolvedStage[] = rules.stages.map((stage, index) => ({
      id: `${idPrefix}-stage-${index + 1}`,
      sequenceNo: index + 1,
      stageType: stage.stageType,
      label: stage.label ?? null,
      tierSemantics: stage.tierSemantics ?? null,
      thresholdBasis: stage.thresholdBasis ?? null,
      revenueStream: stage.revenueStream ?? null,
      inGreaterOfComparison: stage.inGreaterOfComparison ?? false,
      requiresDataSource: stage.requiresDataSource ?? null,
      config: stage.config ?? {},
      bands: (stage.bands ?? []).map((band, bandIndex) => ({
        id: `${idPrefix}-stage-${index + 1}-band-${bandIndex + 1}`,
        sequenceNo: bandIndex + 1,
        fromMultiple: band.fromMultiple ?? null,
        fromAmountCents: band.fromAmountCents ?? null,
        fromPercent: band.fromPercent ?? null,
        ratePercent: band.ratePercent,
        acceleratorRatePercent: band.acceleratorRatePercent ?? null,
      })),
      accelerator: stage.accelerator
        ? {
            evaluationMode: stage.accelerator.evaluationMode,
            requiredConditionCount: stage.accelerator.requiredConditionCount ?? null,
            requiredScore: stage.accelerator.requiredScore ?? null,
            conditions: stage.accelerator.conditions.map((condition, conditionIndex) => ({
              sequenceNo: conditionIndex + 1,
              metric: condition.metric,
              comparator: condition.comparator,
              basis: condition.basis,
              thresholdValue: condition.thresholdValue ?? null,
              weight: condition.weight ?? 1,
            })),
          }
        : null,
    }));
    const hourRules: ResolvedRuleVersion['hourRules'] = {};
    for (const rule of rules.hourRules) {
      hourRules[rule.category] = {
        countsTowardTarget: rule.countsTowardTarget,
        countsAsPaid: rule.countsAsPaid,
      };
    }
    return {
      versionId: `${idPrefix}-version`,
      structureId: `${idPrefix}-structure`,
      structureName: 'Preview',
      versionNo: 1,
      discountBasis: rules.discountBasis ?? 'headline_before_discount',
      vatBasis: rules.vatBasis ?? 'exclusive',
      tipsIncludedInCommission: false,
      depositRecognition: rules.depositRecognition ?? 'on_completion',
      productCostMode: rules.productCostMode ?? 'none',
      cancellationFeeSharePercent: null,
      stages,
      hourRules,
    };
  }

  // ---------------------------------------------------------------------------
  // Create structure (+ version 1)
  // ---------------------------------------------------------------------------

  async create(actor: AuthUser, request: CreatePayStructureRequest) {
    this.validateRules(request);
    const name = request.name.trim();
    if (!name) throw new BadRequestException('A structure needs a name');

    const { data: duplicate, error: duplicateError } = await this.admin
      .schema('payroll')
      .from('pay_structures')
      .select('id')
      .eq('business_id', actor.businessId)
      .ilike('name', name)
      .maybeSingle();
    if (duplicateError) {
      this.logger.error(`create duplicate check failed: ${duplicateError.message}`);
      throw new InternalServerErrorException('Unable to create pay structure');
    }
    if (duplicate) {
      throw new ConflictException('A pay structure with that name already exists');
    }

    const { data: structure, error: structureError } = await this.admin
      .schema('payroll')
      .from('pay_structures')
      .insert({
        business_id: actor.businessId,
        name,
        description: request.description?.trim() || null,
        created_by_user_profile_id: actor.id,
      })
      .select('id')
      .single<{ id: string }>();
    if (structureError || !structure) {
      this.logger.error(`create structure failed: ${structureError?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create pay structure');
    }

    try {
      await this.writeVersion(actor, structure.id, 1, request);
    } catch (error) {
      // No cross-request transactions via PostgREST: on failure, delete the
      // structure (children cascade; version 1 is unused so nothing is frozen).
      await this.admin.schema('payroll').from('pay_structures').delete().eq('id', structure.id);
      throw error;
    }

    await this.audit.record(actor, {
      entityType: 'pay_structure',
      entityId: structure.id,
      action: 'pay_structure.created',
      after: { name, stages: request.stages.map((s) => s.stageType) },
    });
    return this.getDetail(actor, structure.id);
  }

  // ---------------------------------------------------------------------------
  // Version lifecycle: close current, insert N+1
  // ---------------------------------------------------------------------------

  async createVersion(
    actor: AuthUser,
    structureId: string,
    request: CreatePayStructureVersionRequest,
  ) {
    this.validateRules(request);
    const structure = await this.fetchStructure(actor, structureId);

    const { data: versions, error } = await this.admin
      .schema('payroll')
      .from('pay_structure_versions')
      .select('id,version_no,effective_from,effective_to')
      .eq('structure_id', structure.id)
      .order('version_no', { ascending: false });
    if (error) {
      this.logger.error(`createVersion read failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load structure versions');
    }
    const current = (versions ?? []).find((v) => v.effective_to === null);
    const nextVersionNo = numOrZero(versions?.[0]?.version_no) + 1;

    if (current) {
      if (!isBefore(current.effective_from, request.effectiveFrom)) {
        throw new BadRequestException(
          'The new version must start after the current version started',
        );
      }
      // Closing a USED version is legal post-0078 only when the close date
      // clears everything it priced; the trigger enforces that — map its
      // refusal to a 409 with the actionable message.
      const { error: closeError } = await this.admin
        .schema('payroll')
        .from('pay_structure_versions')
        .update({ effective_to: request.effectiveFrom })
        .eq('id', current.id);
      if (closeError) {
        throw new ConflictException(
          `The current version cannot be closed on ${request.effectiveFrom}: it has priced pay up to a later date. Pick a close date after the last priced work. (${closeError.message})`,
        );
      }
    }

    try {
      await this.writeVersion(actor, structure.id, nextVersionNo, request);
    } catch (writeError) {
      // Reopen the version we just closed so a failed create leaves no gap.
      if (current) {
        await this.admin
          .schema('payroll')
          .from('pay_structure_versions')
          .update({ effective_to: null })
          .eq('id', current.id);
      }
      throw writeError;
    }

    await this.audit.record(actor, {
      entityType: 'pay_structure',
      entityId: structure.id,
      action: 'pay_structure.version_created',
      after: { versionNo: nextVersionNo, effectiveFrom: request.effectiveFrom },
    });
    return this.getDetail(actor, structure.id);
  }

  private async writeVersion(
    actor: AuthUser,
    structureId: string,
    versionNo: number,
    rules: PayStructureRulesInput,
  ): Promise<void> {
    const { data: version, error: versionError } = await this.admin
      .schema('payroll')
      .from('pay_structure_versions')
      .insert({
        business_id: actor.businessId,
        structure_id: structureId,
        version_no: versionNo,
        effective_from: rules.effectiveFrom,
        discount_basis: rules.discountBasis ?? 'headline_before_discount',
        vat_basis: rules.vatBasis ?? 'exclusive',
        deposit_recognition: rules.depositRecognition ?? 'on_completion',
        product_cost_mode: rules.productCostMode ?? 'none',
        notes: rules.notes?.trim() || null,
        created_by_user_profile_id: actor.id,
      })
      .select('id')
      .single<{ id: string }>();
    if (versionError || !version) {
      throw new InternalServerErrorException(
        `Unable to write pay structure version: ${versionError?.message ?? 'no row'}`,
      );
    }

    const { data: stages, error: stagesError } = await this.admin
      .schema('payroll')
      .from('pay_structure_stages')
      .insert(
        rules.stages.map((stage, index) => ({
          version_id: version.id,
          sequence_no: index + 1,
          stage_type: stage.stageType,
          label: stage.label?.trim() || null,
          tier_semantics: stage.tierSemantics ?? null,
          threshold_basis: stage.thresholdBasis ?? null,
          revenue_stream: stage.revenueStream ?? null,
          in_greater_of_comparison: stage.inGreaterOfComparison ?? false,
          requires_data_source: stage.requiresDataSource ?? null,
          config: stage.config ?? {},
        })),
      )
      .select('id,sequence_no');
    if (stagesError || !stages) {
      throw new InternalServerErrorException(
        `Unable to write stages: ${stagesError?.message ?? 'no rows'}`,
      );
    }
    const stageIdBySequence = new Map(stages.map((s) => [numOrZero(s.sequence_no), s.id]));

    const bandRows = rules.stages.flatMap((stage, index) =>
      (stage.bands ?? []).map((band, bandIndex) => ({
        stage_id: stageIdBySequence.get(index + 1)!,
        sequence_no: bandIndex + 1,
        from_multiple: band.fromMultiple ?? null,
        from_amount_cents: band.fromAmountCents ?? null,
        from_percent: band.fromPercent ?? null,
        rate_percent: band.ratePercent,
        accelerator_rate_percent: band.acceleratorRatePercent ?? null,
      })),
    );
    if (bandRows.length > 0) {
      const { error: bandsError } = await this.admin
        .schema('payroll')
        .from('pay_structure_bands')
        .insert(bandRows);
      if (bandsError) {
        throw new InternalServerErrorException(`Unable to write bands: ${bandsError.message}`);
      }
    }

    for (const [index, stage] of rules.stages.entries()) {
      if (!stage.accelerator) continue;
      const { data: accelerator, error: acceleratorError } = await this.admin
        .schema('payroll')
        .from('accelerators')
        .insert({
          version_id: version.id,
          stage_id: stageIdBySequence.get(index + 1)!,
          name: stage.accelerator.name?.trim() || 'Accelerator',
          evaluation_mode: stage.accelerator.evaluationMode,
          required_condition_count: stage.accelerator.requiredConditionCount ?? null,
          required_score: stage.accelerator.requiredScore ?? null,
        })
        .select('id')
        .single<{ id: string }>();
      if (acceleratorError || !accelerator) {
        throw new InternalServerErrorException(
          `Unable to write accelerator: ${acceleratorError?.message ?? 'no row'}`,
        );
      }
      const { error: conditionsError } = await this.admin
        .schema('payroll')
        .from('accelerator_conditions')
        .insert(
          stage.accelerator.conditions.map((condition, conditionIndex) => ({
            accelerator_id: accelerator.id,
            sequence_no: conditionIndex + 1,
            metric: condition.metric,
            comparator: condition.comparator,
            basis: condition.basis,
            threshold_value: condition.thresholdValue ?? null,
            weight: condition.weight ?? 1,
          })),
        );
      if (conditionsError) {
        throw new InternalServerErrorException(
          `Unable to write accelerator conditions: ${conditionsError.message}`,
        );
      }
    }

    const { error: hourRulesError } = await this.admin
      .schema('payroll')
      .from('version_hour_rules')
      .insert(
        rules.hourRules.map((rule) => ({
          version_id: version.id,
          category: rule.category,
          counts_toward_target: rule.countsTowardTarget,
          counts_as_paid: rule.countsAsPaid,
        })),
      );
    if (hourRulesError) {
      throw new InternalServerErrorException(
        `Unable to write hour rules: ${hourRulesError.message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------------------

  async getDetail(actor: AuthUser, structureId: string): Promise<PayStructureDetailResponse> {
    const structure = await this.fetchStructure(actor, structureId);

    const [{ data: versions, error: versionsError }, assignedStaffCount, usedVersionIds] =
      await Promise.all([
        this.admin
          .schema('payroll')
          .from('pay_structure_versions')
          .select(
            'id,version_no,effective_from,effective_to,discount_basis,vat_basis,deposit_recognition,product_cost_mode,notes',
          )
          .eq('structure_id', structure.id)
          .order('version_no', { ascending: false }),
        this.countActiveAssignments(actor.businessId, structure.id),
        this.usedVersionIds(structure.id),
      ]);
    if (versionsError) {
      this.logger.error(`getDetail versions failed: ${versionsError.message}`);
      throw new InternalServerErrorException('Unable to load structure versions');
    }

    const versionIds = (versions ?? []).map((v) => v.id);
    const [stages, bands, accelerators, conditions, hourRules] = await Promise.all([
      versionIds.length
        ? this.admin
            .schema('payroll')
            .from('pay_structure_stages')
            .select(
              'id,version_id,sequence_no,stage_type,label,tier_semantics,threshold_basis,revenue_stream,in_greater_of_comparison,requires_data_source,config',
            )
            .in('version_id', versionIds)
        : { data: [], error: null },
      versionIds.length
        ? this.admin
            .schema('payroll')
            .from('pay_structure_bands')
            .select(
              'id,stage_id,sequence_no,from_multiple,from_amount_cents,from_percent,rate_percent,accelerator_rate_percent',
            )
        : { data: [], error: null },
      versionIds.length
        ? this.admin
            .schema('payroll')
            .from('accelerators')
            .select('id,stage_id,name,evaluation_mode,required_condition_count,required_score')
            .in('version_id', versionIds)
        : { data: [], error: null },
      this.admin
        .schema('payroll')
        .from('accelerator_conditions')
        .select('accelerator_id,sequence_no,metric,comparator,basis,threshold_value,weight'),
      versionIds.length
        ? this.admin
            .schema('payroll')
            .from('version_hour_rules')
            .select('version_id,category,counts_toward_target,counts_as_paid')
            .in('version_id', versionIds)
        : { data: [], error: null },
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const versionDetails: PayStructureVersionDetail[] = (versions ?? []).map((version) => {
      const versionStages = (stages.data ?? [])
        .filter((s) => s.version_id === version.id)
        .sort((a, b) => numOrZero(a.sequence_no) - numOrZero(b.sequence_no))
        .map((stage) => {
          const acceleratorRow = (accelerators.data ?? []).find((a) => a.stage_id === stage.id);
          return {
            id: stage.id,
            sequenceNo: numOrZero(stage.sequence_no),
            stageType: stage.stage_type,
            label: stage.label,
            tierSemantics: stage.tier_semantics,
            thresholdBasis: stage.threshold_basis,
            revenueStream: stage.revenue_stream,
            inGreaterOfComparison: stage.in_greater_of_comparison === true,
            requiresDataSource: stage.requires_data_source,
            config: stage.config ?? {},
            bands: (bands.data ?? [])
              .filter((b) => b.stage_id === stage.id)
              .sort((a, b) => numOrZero(a.sequence_no) - numOrZero(b.sequence_no))
              .map((band) => ({
                id: band.id,
                sequenceNo: numOrZero(band.sequence_no),
                fromMultiple: numOrNull(band.from_multiple),
                fromAmountCents: numOrNull(band.from_amount_cents),
                fromPercent: numOrNull(band.from_percent),
                ratePercent: numOrZero(band.rate_percent),
                acceleratorRatePercent: numOrNull(band.accelerator_rate_percent),
              })),
            accelerator: acceleratorRow
              ? {
                  name: acceleratorRow.name,
                  evaluationMode: acceleratorRow.evaluation_mode,
                  requiredConditionCount: numOrNull(acceleratorRow.required_condition_count),
                  requiredScore: numOrNull(acceleratorRow.required_score),
                  conditions: (conditions.data ?? [])
                    .filter((c) => c.accelerator_id === acceleratorRow.id)
                    .sort((a, b) => numOrZero(a.sequence_no) - numOrZero(b.sequence_no))
                    .map((condition) => ({
                      sequenceNo: numOrZero(condition.sequence_no),
                      metric: condition.metric,
                      comparator: condition.comparator,
                      basis: condition.basis,
                      thresholdValue: numOrNull(condition.threshold_value),
                      weight: numOrZero(condition.weight),
                    })),
                }
              : null,
          };
        });
      return {
        id: version.id,
        versionNo: numOrZero(version.version_no),
        effectiveFrom: version.effective_from,
        effectiveTo: version.effective_to,
        discountBasis: version.discount_basis,
        vatBasis: version.vat_basis,
        depositRecognition: version.deposit_recognition,
        productCostMode: version.product_cost_mode,
        isUsed: usedVersionIds.has(version.id),
        stages: versionStages,
        hourRules: (hourRules.data ?? [])
          .filter((r) => r.version_id === version.id)
          .map((rule) => ({
            category: rule.category,
            countsTowardTarget: rule.counts_toward_target === true,
            countsAsPaid: rule.counts_as_paid === true,
          })),
        notes: version.notes,
      };
    });

    const currentVersion = versionDetails.find(
      (v) => v.effectiveFrom <= today && (v.effectiveTo === null || v.effectiveTo > today),
    );

    return {
      structure: {
        id: structure.id,
        name: structure.name,
        description: structure.description,
        isSystem: structure.is_system === true,
        isActive: structure.is_active === true,
        assignedStaffCount,
      },
      versions: versionDetails,
      currentVersionId: currentVersion?.id ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Assignment
  // ---------------------------------------------------------------------------

  async assign(
    actor: AuthUser,
    staffProfileId: string,
    request: { structureId: string; effectiveFrom: string },
  ): Promise<AssignPayStructureResponse> {
    if (!isLocalDate(request.effectiveFrom)) {
      throw new BadRequestException('effectiveFrom must be YYYY-MM-DD');
    }
    const structure = await this.fetchStructure(actor, request.structureId);

    // Manager scope: only staff at the manager's own locations.
    const staff = await this.inputs.loadStaff(actor.businessId);
    const member = staff.find((s) => s.staffProfileId === staffProfileId);
    if (!member) throw new NotFoundException('Staff member not found in your business');
    if (!userHasRole(actor, 'owner')) {
      if (
        member.primaryLocationId === null ||
        !actor.allowedLocationIds.includes(member.primaryLocationId)
      ) {
        throw new NotFoundException('Staff member not found in your business');
      }
    }

    const { data: open, error: openError } = await this.admin
      .schema('payroll')
      .from('staff_pay_assignments')
      .select('id,structure_id,effective_from,effective_to')
      .eq('business_id', actor.businessId)
      .eq('staff_profile_id', staffProfileId)
      .is('effective_to', null)
      .maybeSingle();
    if (openError) {
      this.logger.error(`assign open check failed: ${openError.message}`);
      throw new InternalServerErrorException('Unable to check current assignment');
    }

    let closedAssignment: AssignPayStructureResponse['closedAssignment'] = null;
    if (open) {
      if (open.structure_id === structure.id) {
        throw new ConflictException('This staff member is already on that structure');
      }
      if (!isBefore(open.effective_from, request.effectiveFrom)) {
        throw new BadRequestException(
          'The new assignment must start after the current one started',
        );
      }
      const { error: closeError } = await this.admin
        .schema('payroll')
        .from('staff_pay_assignments')
        .update({ effective_to: request.effectiveFrom })
        .eq('id', open.id)
        .eq('business_id', actor.businessId);
      if (closeError) {
        this.logger.error(`assign close failed: ${closeError.message}`);
        throw new InternalServerErrorException('Unable to close the current assignment');
      }
      closedAssignment = {
        id: open.id,
        staffProfileId,
        structureId: open.structure_id,
        structureName: '',
        effectiveFrom: open.effective_from,
        effectiveTo: request.effectiveFrom,
      };
    }

    const { data: created, error: createError } = await this.admin
      .schema('payroll')
      .from('staff_pay_assignments')
      .insert({
        business_id: actor.businessId,
        staff_profile_id: staffProfileId,
        structure_id: structure.id,
        effective_from: request.effectiveFrom,
        created_by_user_profile_id: actor.id,
      })
      .select('id,effective_from,effective_to')
      .single<{ id: string; effective_from: string; effective_to: string | null }>();
    if (createError || !created) {
      // Reopen the assignment we closed so a failure leaves no gap.
      if (open) {
        await this.admin
          .schema('payroll')
          .from('staff_pay_assignments')
          .update({ effective_to: null })
          .eq('id', open.id);
      }
      this.logger.error(`assign insert failed: ${createError?.message ?? 'no row'}`);
      throw new InternalServerErrorException('Unable to create the assignment');
    }

    await this.audit.record(actor, {
      entityType: 'pay_structure',
      entityId: structure.id,
      action: 'pay_structure.assigned',
      after: { staffProfileId, effectiveFrom: request.effectiveFrom },
    });

    return {
      assignment: {
        id: created.id,
        staffProfileId,
        structureId: structure.id,
        structureName: structure.name,
        effectiveFrom: created.effective_from,
        effectiveTo: created.effective_to,
      },
      closedAssignment,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async fetchStructure(actor: AuthUser, structureId: string) {
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_structures')
      .select('id,name,description,is_system,is_active')
      .eq('id', structureId)
      .eq('business_id', actor.businessId)
      .maybeSingle();
    if (error) {
      this.logger.error(`fetchStructure failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load pay structure');
    }
    if (!data) throw new NotFoundException('Pay structure not found in your business');
    return data;
  }

  private async countActiveAssignments(businessId: string, structureId: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await this.admin
      .schema('payroll')
      .from('staff_pay_assignments')
      .select('id,effective_from,effective_to')
      .eq('business_id', businessId)
      .eq('structure_id', structureId);
    if (error) {
      this.logger.error(`countActiveAssignments failed: ${error.message}`);
      return 0;
    }
    return (data ?? []).filter(
      (a) => a.effective_from <= today && (a.effective_to === null || a.effective_to > today),
    ).length;
  }

  private async usedVersionIds(structureId: string): Promise<Set<string>> {
    const { data, error } = await this.admin
      .schema('payroll')
      .from('pay_summaries')
      .select('structure_version_id')
      .eq('structure_id', structureId)
      .not('structure_version_id', 'is', null);
    if (error) {
      this.logger.error(`usedVersionIds failed: ${error.message}`);
      return new Set();
    }
    return new Set(
      (data ?? [])
        .map((row) => row.structure_version_id as string | null)
        .filter((id): id is string => id !== null),
    );
  }
}
