import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import type {
  DepositRecognition,
  DiscountBasis,
  HourCategory,
  PayStructureAcceleratorInput,
  PayStructureBandInput,
  PayStructurePreviewResponse,
  PayStructureRulesInput,
  PayStructureStageInput,
  PayStructureVersionDetail,
  PayStageType,
  PayrollDataSource,
  PayrollRevenueStream,
  PayrollVatBasis,
  ProductCostMode,
  ThresholdBasis,
  TierSemantics,
} from '@sheer/domain';
import {
  ACCELERATOR_EVALUATION_LABELS,
  HOUR_CATEGORY_LABELS,
  PAY_STAGE_TYPE_LABELS,
  THRESHOLD_BASIS_LABELS,
  TIER_SEMANTICS_DESCRIPTIONS,
  TIER_SEMANTICS_LABELS,
  userHasPermission,
  userHasRole,
} from '@sheer/domain';
import { cn } from '@sheer/utils';
import { AppButton, AppCard, AppText, StatusBadge } from '../../design';
import { formatMoney, signedMoney } from '../kpi/format';
import { todayLocalIso } from './format';
import { acceleratorConditionLabel } from './structureFormat';
import { PayrollWarningNotice } from './PayrollWarningNotice';
import { useAuth } from '../../auth/AuthProvider';
import {
  ApiRequestError,
  createPayStructure,
  createPayStructureVersion,
  previewPayStructure,
} from '../../auth/api';

const CURRENCY = 'GBP';

/**
 * The single most consequential sentence in the wizard — Luke's own worked
 * example of how far marginal and retroactive semantics diverge.
 */
const SEMANTICS_WARNING =
  'On £488.40 base pay and £1,800 revenue, marginal pays £38.01 and retroactive pays £270 — check this carefully.';

const RETAIL_NOTE =
  "Retail isn't captured yet — this stage will show as 'source not captured' on real pay runs.";

const PREVIEW_NOTE =
  'Illustrative preview: all data sources are treated as captured here; live pay runs warn on uncaptured sources.';

const INPUT_CLASSES =
  'w-full rounded-input-lg border border-border-strong bg-surface px-3.5 py-2.5 text-[14px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:bg-surface-alt';

const INPUT_SM_CLASSES =
  'w-full rounded-input border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20';

// -----------------------------------------------------------------------------
// Draft model — UI units (pounds, percents, multiples) as editable strings
// -----------------------------------------------------------------------------

type TemplateId =
  | 'flat_commission'
  | 'tiered_commission'
  | 'base_bonus'
  | 'guarantee_or_commission'
  | 'chair_renter';

interface DraftBand {
  key: number;
  /** In the stage's basis unit: a multiple, pounds, or a percent. */
  from: string;
  rate: string;
  /** '' = no accelerator rate on this band. */
  acceleratorRate: string;
}

interface DraftStage {
  key: number;
  stageType: PayStageType;
  label: string;
  /**
   * Include/exclude toggle (revenue split & chair rent). Disabled stages are
   * omitted from the payload but keep their values so toggling back on
   * restores them.
   */
  enabled: boolean;
  inGreaterOfComparison: boolean;
  requiresDataSource: PayrollDataSource | null;
  // Commission stages
  tierSemantics: TierSemantics;
  thresholdBasis: ThresholdBasis;
  revenueStream: PayrollRevenueStream;
  /** Marginal/retroactive is only offered where it changes the maths. */
  semanticsEditable: boolean;
  bands: DraftBand[];
  accelerator: PayStructureAcceleratorInput | null;
  // Base pay stages
  baseSource: 'hourly_rate_x_payable_hours' | 'fixed_amount';
  // Deduction stages
  deductionSource: 'product_cost' | 'fixed';
  /** £ for fixed base pay / bonus / chair rent / fixed deduction. */
  amountPounds: string;
  // Revenue-split stages
  splitPercent: string;
}

interface DraftHourRule {
  category: HourCategory;
  countsTowardTarget: boolean;
  countsAsPaid: boolean;
}

/**
 * The service revenue target implied by the drafted bands (the engine derives
 * it from the lowest positive band threshold of the service commission stage),
 * stated up front so band thresholds read as what they are.
 */
interface DerivedTargetSummary {
  /** Draft key of the service commission stage the target derives from. */
  sourceStageKey: number | null;
  basis: ThresholdBasis | null;
  /** Lowest positive band threshold in the basis unit (a multiple or pounds). */
  lowestFrom: number | null;
  /** The target in £ cents on the example week, when computable. */
  exampleTargetCents: number | null;
}

/** The signed-off matrix: worked/additional/manual adj → target+paid; paid holiday/training → paid only; the rest → neither. */
const DEFAULT_HOUR_RULES: DraftHourRule[] = [
  { category: 'worked', countsTowardTarget: true, countsAsPaid: true },
  { category: 'additional', countsTowardTarget: true, countsAsPaid: true },
  { category: 'manual_adjustment', countsTowardTarget: true, countsAsPaid: true },
  { category: 'paid_holiday', countsTowardTarget: false, countsAsPaid: true },
  { category: 'training', countsTowardTarget: false, countsAsPaid: true },
  { category: 'sickness', countsTowardTarget: false, countsAsPaid: false },
  { category: 'authorised_absence', countsTowardTarget: false, countsAsPaid: false },
  { category: 'unpaid_leave', countsTowardTarget: false, countsAsPaid: false },
];

const HOUR_RULE_DISPLAY_ORDER: HourCategory[] = DEFAULT_HOUR_RULES.map((rule) => rule.category);

/** Bound key each threshold basis writes (mirrors the API/DB rule). */
const BASIS_BOUND: Record<ThresholdBasis, 'fromMultiple' | 'fromAmountCents' | 'fromPercent'> = {
  multiple_of_base_pay: 'fromMultiple',
  absolute: 'fromAmountCents',
  per_client: 'fromAmountCents',
  percent_of_service_target: 'fromPercent',
  percent_of_service_revenue: 'fromPercent',
};

const BASIS_FROM_HEADING: Record<ThresholdBasis, string> = {
  multiple_of_base_pay: 'From (× base pay)',
  absolute: 'From (£)',
  per_client: 'From (£ per client)',
  percent_of_service_target: 'From (% of service revenue target)',
  percent_of_service_revenue: 'From (% of service revenue)',
};

let draftKeySeq = 1;
function nextKey(): number {
  draftKeySeq += 1;
  return draftKeySeq;
}

function blankStage(stageType: PayStageType): DraftStage {
  return {
    key: nextKey(),
    stageType,
    label: '',
    enabled: true,
    inGreaterOfComparison: false,
    requiresDataSource: null,
    tierSemantics: 'marginal',
    thresholdBasis: 'absolute',
    revenueStream: 'service',
    semanticsEditable: false,
    bands: [],
    accelerator: null,
    baseSource: 'hourly_rate_x_payable_hours',
    deductionSource: 'fixed',
    amountPounds: '',
    splitPercent: '',
  };
}

// -----------------------------------------------------------------------------
// Templates — Step 1 seeds
// -----------------------------------------------------------------------------

interface TemplateDefinition {
  id: TemplateId;
  name: string;
  description: string;
  stages: () => DraftStage[];
}

const TEMPLATES: TemplateDefinition[] = [
  {
    id: 'flat_commission',
    name: 'Flat commission %',
    description: 'A single commission rate on all service revenue, from the first pound.',
    stages: () => [
      {
        ...blankStage('commission'),
        label: 'Service commission',
        tierSemantics: 'marginal',
        thresholdBasis: 'absolute',
        revenueStream: 'service',
        requiresDataSource: 'service_revenue',
        semanticsEditable: false,
        bands: [{ key: nextKey(), from: '0', rate: '40', acceleratorRate: '' }],
      },
    ],
  },
  {
    id: 'tiered_commission',
    name: 'Tiered commission',
    description:
      'Hourly base plus marginal service commission at 3× / 3.5× of base pay with the all-three accelerator, and retail commission.',
    stages: () => [
      { ...blankStage('base_pay'), label: 'Hourly base pay' },
      {
        ...blankStage('commission'),
        label: 'Service commission',
        tierSemantics: 'marginal',
        thresholdBasis: 'multiple_of_base_pay',
        revenueStream: 'service',
        requiresDataSource: 'service_revenue',
        semanticsEditable: true,
        bands: [
          { key: nextKey(), from: '0', rate: '0', acceleratorRate: '' },
          { key: nextKey(), from: '3', rate: '10', acceleratorRate: '' },
          { key: nextKey(), from: '3.5', rate: '15', acceleratorRate: '30' },
        ],
        accelerator: {
          name: 'All-three accelerator',
          evaluationMode: 'all',
          conditions: [
            {
              metric: 'rebooking_rate_percent',
              comparator: 'gte',
              basis: 'percent',
              thresholdValue: 50,
            },
            { metric: 'retail_revenue', comparator: 'gte', basis: 'target_met' },
            { metric: 'average_bill', comparator: 'gte', basis: 'staff_benchmark' },
          ],
        },
      },
      {
        ...blankStage('commission'),
        label: 'Retail commission',
        tierSemantics: 'marginal',
        thresholdBasis: 'percent_of_service_target',
        revenueStream: 'retail',
        requiresDataSource: 'retail_sales',
        semanticsEditable: true,
        bands: [
          { key: nextKey(), from: '0', rate: '0', acceleratorRate: '' },
          { key: nextKey(), from: '10', rate: '10', acceleratorRate: '' },
        ],
      },
    ],
  },
  {
    id: 'base_bonus',
    name: 'Base + bonus',
    description: 'Hourly base pay plus a fixed bonus each calculation period.',
    stages: () => [
      { ...blankStage('base_pay'), label: 'Hourly base pay' },
      { ...blankStage('bonus'), label: 'Bonus', amountPounds: '100' },
    ],
  },
  {
    id: 'guarantee_or_commission',
    name: 'Guarantee or commission',
    description: 'Pays hourly base pay or commission on service revenue — whichever is higher.',
    stages: () => [
      { ...blankStage('base_pay'), label: 'Guaranteed base pay', inGreaterOfComparison: true },
      {
        ...blankStage('commission'),
        label: 'Service commission',
        inGreaterOfComparison: true,
        tierSemantics: 'retroactive',
        thresholdBasis: 'absolute',
        revenueStream: 'service',
        requiresDataSource: 'service_revenue',
        semanticsEditable: false,
        bands: [{ key: nextKey(), from: '0', rate: '40', acceleratorRate: '' }],
      },
      { ...blankStage('greater_of'), label: 'Whichever is higher' },
    ],
  },
  {
    id: 'chair_renter',
    name: 'Chair renter',
    description: 'A revenue split to the stylist with chair rent deducted each period.',
    stages: () => [
      { ...blankStage('revenue_split'), label: 'Revenue split', splitPercent: '50' },
      { ...blankStage('chair_rent'), label: 'Chair rent', amountPounds: '200' },
    ],
  },
];

/**
 * Ensure the toggleable stages (revenue split, chair rent) always exist in the
 * draft so their Include toggle can be shown — OFF when the template or source
 * version doesn't carry the stage. Disabled stages never reach the payload, so
 * templates without them still produce exactly the payload they did before.
 */
function withToggleableStages(stages: DraftStage[]): DraftStage[] {
  const result = [...stages];
  if (!result.some((stage) => stage.stageType === 'revenue_split')) {
    result.push({ ...blankStage('revenue_split'), label: 'Revenue split', enabled: false });
  }
  if (!result.some((stage) => stage.stageType === 'chair_rent')) {
    result.push({ ...blankStage('chair_rent'), label: 'Chair rent', enabled: false });
  }
  return result;
}

// -----------------------------------------------------------------------------
// Version detail → draft (New version prefill)
// -----------------------------------------------------------------------------

function numToInput(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function centsToPoundsInput(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : String(cents / 100);
}

function stagesFromVersion(version: PayStructureVersionDetail): DraftStage[] {
  return [...version.stages]
    .sort((a, b) => a.sequenceNo - b.sequenceNo)
    .map((stage) => {
      const draft = blankStage(stage.stageType);
      draft.label = stage.label ?? '';
      draft.inGreaterOfComparison = stage.inGreaterOfComparison;
      draft.requiresDataSource = stage.requiresDataSource;
      if (stage.stageType === 'commission') {
        draft.tierSemantics = stage.tierSemantics ?? 'marginal';
        draft.thresholdBasis = stage.thresholdBasis ?? 'absolute';
        draft.revenueStream = stage.revenueStream ?? 'service';
        // Semantics only change the maths once there is more than one band.
        draft.semanticsEditable = stage.bands.length > 1;
        draft.bands = [...stage.bands]
          .sort((a, b) => a.sequenceNo - b.sequenceNo)
          .map((band) => ({
            key: nextKey(),
            from:
              BASIS_BOUND[draft.thresholdBasis] === 'fromMultiple'
                ? numToInput(band.fromMultiple)
                : BASIS_BOUND[draft.thresholdBasis] === 'fromAmountCents'
                  ? centsToPoundsInput(band.fromAmountCents)
                  : numToInput(band.fromPercent),
            rate: numToInput(band.ratePercent),
            acceleratorRate: numToInput(band.acceleratorRatePercent),
          }));
        if (stage.accelerator) {
          draft.accelerator = {
            name: stage.accelerator.name,
            evaluationMode: stage.accelerator.evaluationMode,
            requiredConditionCount: stage.accelerator.requiredConditionCount ?? undefined,
            requiredScore: stage.accelerator.requiredScore ?? undefined,
            // sequenceNo must NOT round-trip: the API whitelist rejects it.
            conditions: stage.accelerator.conditions.map((condition) => ({
              metric: condition.metric,
              comparator: condition.comparator,
              basis: condition.basis,
              thresholdValue: condition.thresholdValue ?? undefined,
              weight: condition.weight ?? undefined,
            })),
          };
        }
      } else if (stage.stageType === 'base_pay') {
        const source = stage.config['source'];
        if (source === 'fixed_amount') {
          draft.baseSource = 'fixed_amount';
          draft.amountPounds = centsToPoundsInput(
            typeof stage.config['amount_cents'] === 'number'
              ? (stage.config['amount_cents'] as number)
              : null,
          );
        }
      } else if (stage.stageType === 'revenue_split') {
        draft.splitPercent =
          typeof stage.config['split_percent'] === 'number'
            ? String(stage.config['split_percent'])
            : '';
      } else if (stage.stageType === 'chair_rent' || stage.stageType === 'bonus') {
        draft.amountPounds = centsToPoundsInput(
          typeof stage.config['amount_cents'] === 'number'
            ? (stage.config['amount_cents'] as number)
            : null,
        );
      } else if (stage.stageType === 'deduction') {
        draft.deductionSource =
          stage.config['source'] === 'product_cost' ? 'product_cost' : 'fixed';
        draft.amountPounds = centsToPoundsInput(
          typeof stage.config['amount_cents'] === 'number'
            ? (stage.config['amount_cents'] as number)
            : null,
        );
      }
      return draft;
    });
}

function hourRulesFromVersion(version: PayStructureVersionDetail): DraftHourRule[] {
  const byCategory = new Map(version.hourRules.map((rule) => [rule.category, rule]));
  return HOUR_RULE_DISPLAY_ORDER.map((category) => {
    const rule = byCategory.get(category);
    const fallback = DEFAULT_HOUR_RULES.find((entry) => entry.category === category)!;
    return {
      category,
      countsTowardTarget: rule?.countsTowardTarget ?? fallback.countsTowardTarget,
      countsAsPaid: rule?.countsAsPaid ?? fallback.countsAsPaid,
    };
  });
}

// -----------------------------------------------------------------------------
// Draft → PayStructureRulesInput (pounds → integer cents at the boundary)
// -----------------------------------------------------------------------------

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function poundsToCents(value: string): number | null {
  const parsed = parseNumber(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

interface BuildRulesArgs {
  stages: DraftStage[];
  hourRules: DraftHourRule[];
  effectiveFrom: string;
  discountBasis?: DiscountBasis;
  vatBasis?: PayrollVatBasis;
  depositRecognition?: DepositRecognition;
  productCostMode?: ProductCostMode;
}

function buildRules(args: BuildRulesArgs): { rules?: PayStructureRulesInput; error?: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.effectiveFrom)) {
    return { error: 'Pick an effective-from date.' };
  }
  // With more than one bonus, each needs its own name — the payslip lists one
  // line per bonus and the names are what tell them apart.
  const enabledBonuses = args.stages.filter(
    (stage) => stage.enabled && stage.stageType === 'bonus',
  );
  if (enabledBonuses.length > 1 && enabledBonuses.some((stage) => stage.label.trim() === '')) {
    return {
      error:
        'Give each bonus its own name — with more than one bonus, the names tell them apart on the payslip.',
    };
  }
  const stages: PayStructureStageInput[] = [];
  for (const [index, stage] of args.stages.entries()) {
    // Toggled-off stages are kept in the draft (so their values survive) but
    // never reach the payload.
    if (!stage.enabled) continue;
    const where = `Stage ${index + 1} (${stage.label || PAY_STAGE_TYPE_LABELS[stage.stageType]})`;
    const base: PayStructureStageInput = {
      stageType: stage.stageType,
      label: stage.label.trim() || undefined,
      inGreaterOfComparison: stage.inGreaterOfComparison || undefined,
      requiresDataSource: stage.requiresDataSource ?? undefined,
    };
    switch (stage.stageType) {
      case 'base_pay': {
        if (stage.baseSource === 'fixed_amount') {
          const amountCents = poundsToCents(stage.amountPounds);
          if (amountCents === null || amountCents <= 0) {
            return { error: `${where}: enter a fixed amount in £ greater than zero.` };
          }
          base.config = { source: 'fixed_amount', amount_cents: amountCents };
        } else {
          base.config = { source: 'hourly_rate_x_payable_hours' };
        }
        break;
      }
      case 'commission': {
        if (stage.bands.length === 0) {
          return { error: `${where}: add at least one band.` };
        }
        const boundKey = BASIS_BOUND[stage.thresholdBasis];
        const bands: PayStructureBandInput[] = [];
        for (const [bandIndex, band] of stage.bands.entries()) {
          const fromValue = parseNumber(band.from);
          if (fromValue === null || fromValue < 0) {
            return { error: `${where}, band ${bandIndex + 1}: enter a valid "from" threshold.` };
          }
          const rate = parseNumber(band.rate);
          if (rate === null || rate < 0 || rate > 100) {
            return { error: `${where}, band ${bandIndex + 1}: the rate must be 0–100%.` };
          }
          const acceleratorRate =
            band.acceleratorRate.trim() === '' ? null : parseNumber(band.acceleratorRate);
          if (band.acceleratorRate.trim() !== '' && acceleratorRate === null) {
            return {
              error: `${where}, band ${bandIndex + 1}: the accelerator rate is not a number.`,
            };
          }
          const built: PayStructureBandInput = { ratePercent: rate };
          if (boundKey === 'fromAmountCents') {
            built.fromAmountCents = Math.round(fromValue * 100);
          } else if (boundKey === 'fromMultiple') {
            built.fromMultiple = fromValue;
          } else {
            built.fromPercent = fromValue;
          }
          if (acceleratorRate !== null) built.acceleratorRatePercent = acceleratorRate;
          bands.push(built);
        }
        base.tierSemantics = stage.tierSemantics;
        base.thresholdBasis = stage.thresholdBasis;
        base.revenueStream = stage.revenueStream;
        base.bands = bands;
        if (stage.accelerator) base.accelerator = stage.accelerator;
        break;
      }
      case 'revenue_split': {
        const split = parseNumber(stage.splitPercent);
        if (split === null || split <= 0 || split > 100) {
          return { error: `${where}: the split must be 1–100%.` };
        }
        base.config = { split_percent: split };
        break;
      }
      case 'chair_rent': {
        const amountCents = poundsToCents(stage.amountPounds);
        if (amountCents === null || amountCents <= 0) {
          return { error: `${where}: enter the rent in £ greater than zero.` };
        }
        base.config = { amount_cents: amountCents, cadence: 'per_period' };
        break;
      }
      case 'bonus': {
        const amountCents = poundsToCents(stage.amountPounds);
        if (amountCents === null || amountCents <= 0) {
          return { error: `${where}: enter the bonus in £ greater than zero.` };
        }
        base.config = { source: 'fixed', amount_cents: amountCents };
        break;
      }
      case 'deduction': {
        if (stage.deductionSource === 'product_cost') {
          base.config = { source: 'product_cost' };
        } else {
          const amountCents = poundsToCents(stage.amountPounds);
          if (amountCents === null || amountCents <= 0) {
            return { error: `${where}: enter the deduction in £ greater than zero.` };
          }
          base.config = { source: 'fixed', amount_cents: amountCents };
        }
        break;
      }
      case 'greater_of':
        break;
      default:
        return { error: `${where}: this stage type cannot be authored here.` };
    }
    stages.push(base);
  }

  const rules: PayStructureRulesInput = {
    effectiveFrom: args.effectiveFrom,
    stages,
    hourRules: args.hourRules.map((rule) => ({
      category: rule.category,
      countsTowardTarget: rule.countsTowardTarget,
      countsAsPaid: rule.countsAsPaid,
    })),
  };
  if (args.discountBasis) rules.discountBasis = args.discountBasis;
  if (args.vatBasis) rules.vatBasis = args.vatBasis;
  if (args.depositRecognition) rules.depositRecognition = args.depositRecognition;
  if (args.productCostMode) rules.productCostMode = args.productCostMode;
  return { rules };
}

// -----------------------------------------------------------------------------
// Wizard
// -----------------------------------------------------------------------------

type WizardStep = 'template' | 'parameters' | 'hours' | 'review';

export interface PayStructureWizardProps {
  mode: 'create' | 'version';
  /** Version mode: the structure a new version is being authored for. */
  structureId?: string;
  structureName?: string;
  /** Version mode: N+1 — the version number being created. */
  nextVersionNo?: number;
  /** Version mode: the version the draft is prefilled from (usually current). */
  sourceVersion?: PayStructureVersionDetail;
  /** Version mode: return to the detail page without saving. */
  onCancel?: () => void;
  /** Version mode: called after the new version is created. */
  onDone?: () => void;
}

/**
 * Owner-only 4-step authoring wizard: Template → Parameters → Hour rules →
 * Review & preview. Money is entered in POUNDS and converted to integer cents
 * only when a payload is built. The preview runs the drafted rules through the
 * REAL engine server-side — nothing here re-implements pay maths.
 */
export function PayStructureWizard({
  mode,
  structureId,
  structureName,
  nextVersionNo,
  sourceVersion,
  onCancel,
  onDone,
}: PayStructureWizardProps) {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const navigate = useNavigate();
  const isOwnerEditor =
    userHasRole(auth.user, 'owner') && userHasPermission(auth.user, 'payroll.edit');

  const steps: WizardStep[] =
    mode === 'create'
      ? ['template', 'parameters', 'hours', 'review']
      : ['parameters', 'hours', 'review'];
  const [step, setStep] = useState<WizardStep>(steps[0]);

  const [template, setTemplate] = useState<TemplateId | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayLocalIso());
  const [stages, setStages] = useState<DraftStage[]>(() =>
    mode === 'version' && sourceVersion ? withToggleableStages(stagesFromVersion(sourceVersion)) : [],
  );
  const [vatBasis, setVatBasis] = useState<PayrollVatBasis>(
    mode === 'version' && sourceVersion ? sourceVersion.vatBasis : 'exclusive',
  );
  const [hourRules, setHourRules] = useState<DraftHourRule[]>(() =>
    mode === 'version' && sourceVersion
      ? hourRulesFromVersion(sourceVersion)
      : DEFAULT_HOUR_RULES.map((rule) => ({ ...rule })),
  );
  // Lives at wizard level (not inside the step) so the matrix stays open when
  // the user navigates back and forth between steps.
  const [hoursExpanded, setHoursExpanded] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);

  // Step 4 — illustrative sample inputs (pounds / hours)
  const [sampleHourlyRate, setSampleHourlyRate] = useState('12.21');
  const [sampleHours, setSampleHours] = useState('40');
  const [sampleServiceRevenue, setSampleServiceRevenue] = useState('1800');
  const [sampleRetailRevenue, setSampleRetailRevenue] = useState('0');
  const [preview, setPreview] = useState<PayStructurePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const built = useMemo(
    () =>
      buildRules({
        stages,
        hourRules,
        effectiveFrom,
        discountBasis: sourceVersion?.discountBasis,
        // In create mode the server default is 'exclusive', so only send an
        // explicit choice — the default payload stays byte-identical.
        vatBasis: mode === 'create' && vatBasis === 'exclusive' ? undefined : vatBasis,
        depositRecognition: sourceVersion?.depositRecognition,
        productCostMode: sourceVersion?.productCostMode,
      }),
    [stages, hourRules, effectiveFrom, sourceVersion, mode, vatBasis],
  );
  const rulesKey = useMemo(() => (built.rules ? JSON.stringify(built.rules) : null), [built.rules]);

  /**
   * Mirrors the engine's target derivation — the lowest positive band
   * threshold of the service commission stage — so the parameters step can
   * state the target up front, illustrated with the example-week inputs.
   */
  const derivedTarget = useMemo<DerivedTargetSummary>(() => {
    const empty: DerivedTargetSummary = {
      sourceStageKey: null,
      basis: null,
      lowestFrom: null,
      exampleTargetCents: null,
    };
    const serviceStage = stages.find(
      (stage) =>
        stage.enabled &&
        stage.stageType === 'commission' &&
        (stage.revenueStream === 'service' || stage.revenueStream === 'service_and_retail'),
    );
    if (!serviceStage) return empty;
    const positiveFroms = serviceStage.bands
      .map((band) => parseNumber(band.from))
      .filter((value): value is number => value !== null && value > 0);
    const lowestFrom = positiveFroms.length > 0 ? Math.min(...positiveFroms) : null;
    let exampleTargetCents: number | null = null;
    if (lowestFrom !== null) {
      if (serviceStage.thresholdBasis === 'multiple_of_base_pay') {
        const baseStage = stages.find(
          (stage) => stage.enabled && stage.stageType === 'base_pay',
        );
        let exampleBasePayCents: number | null = null;
        if (baseStage?.baseSource === 'fixed_amount') {
          exampleBasePayCents = poundsToCents(baseStage.amountPounds);
        } else if (baseStage) {
          const rateCents = poundsToCents(sampleHourlyRate);
          const hours = parseNumber(sampleHours);
          exampleBasePayCents =
            rateCents !== null && rateCents >= 0 && hours !== null && hours >= 0
              ? Math.round(rateCents * hours)
              : null;
        }
        exampleTargetCents =
          exampleBasePayCents !== null ? Math.round(lowestFrom * exampleBasePayCents) : null;
      } else if (serviceStage.thresholdBasis === 'absolute') {
        exampleTargetCents = Math.round(lowestFrom * 100);
      }
    }
    return {
      sourceStageKey: serviceStage.key,
      basis: serviceStage.thresholdBasis,
      lowestFrom,
      exampleTargetCents,
    };
  }, [stages, sampleHourlyRate, sampleHours]);

  // Debounced preview: on entering Review and whenever sample inputs change.
  useEffect(() => {
    if (step !== 'review' || !accessToken) return;
    if (!built.rules || !rulesKey) {
      setPreview(null);
      setPreviewError(built.error ?? 'The drafted rules are incomplete.');
      return;
    }
    const hourlyRateCents = poundsToCents(sampleHourlyRate);
    const workedHours = parseNumber(sampleHours);
    const serviceRevenueCents = poundsToCents(sampleServiceRevenue);
    const retailRevenueCents = poundsToCents(sampleRetailRevenue);
    if (
      hourlyRateCents === null ||
      hourlyRateCents < 0 ||
      workedHours === null ||
      workedHours < 0 ||
      serviceRevenueCents === null ||
      serviceRevenueCents < 0 ||
      retailRevenueCents === null ||
      retailRevenueCents < 0
    ) {
      setPreview(null);
      setPreviewError('Enter valid example figures to preview.');
      return;
    }
    const rules = built.rules;
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      previewPayStructure(accessToken, {
        rules,
        sample: { hourlyRateCents, workedHours, serviceRevenueCents, retailRevenueCents },
      })
        .then((response) => {
          if (!cancelled) setPreview(response);
        })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(
            err instanceof ApiRequestError ? err.message : 'Unable to preview these rules',
          );
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      setPreviewLoading(false);
    };
  }, [
    step,
    accessToken,
    rulesKey,
    built.rules,
    built.error,
    sampleHourlyRate,
    sampleHours,
    sampleServiceRevenue,
    sampleRetailRevenue,
  ]);

  const selectTemplate = useCallback(
    (id: TemplateId) => {
      setTemplate((current) => {
        if (current === id) return current;
        const definition = TEMPLATES.find((entry) => entry.id === id)!;
        setStages(withToggleableStages(definition.stages()));
        return id;
      });
      setStepError(null);
    },
    [setStages],
  );

  const addBonus = useCallback(() => {
    setStages((current) => {
      const bonus = { ...blankStage('bonus') };
      // Keep new bonuses ahead of the toggled-off placeholder stages so the
      // stages someone is actually editing stay grouped together.
      const insertAt = current.findIndex(
        (stage) => !stage.enabled && TOGGLEABLE_STAGE_TYPES.includes(stage.stageType),
      );
      if (insertAt === -1) return [...current, bonus];
      return [...current.slice(0, insertAt), bonus, ...current.slice(insertAt)];
    });
  }, []);

  const removeStage = useCallback((key: number) => {
    setStages((current) => current.filter((stage) => stage.key !== key));
  }, []);

  const goNext = useCallback(() => {
    setStepError(null);
    if (step === 'template' && !template) {
      setStepError('Pick a template to start from.');
      return;
    }
    if (step === 'parameters') {
      if (mode === 'create' && name.trim() === '') {
        setStepError('Give the pay plan a name.');
        return;
      }
      if (built.error) {
        setStepError(built.error);
        return;
      }
    }
    const index = steps.indexOf(step);
    if (index < steps.length - 1) setStep(steps[index + 1]);
  }, [step, steps, template, mode, name, built.error]);

  const goBack = useCallback(() => {
    setStepError(null);
    const index = steps.indexOf(step);
    if (index > 0) setStep(steps[index - 1]);
  }, [step, steps]);

  const handleSubmit = useCallback(async () => {
    if (!accessToken || !built.rules) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (mode === 'create') {
        const response = await createPayStructure(accessToken, {
          ...built.rules,
          name: name.trim(),
          description: description.trim() || undefined,
        });
        navigate(`/payroll/structures/${response.structure.id}`);
      } else if (structureId) {
        await createPayStructureVersion(accessToken, structureId, built.rules);
        onDone?.();
      }
    } catch (err) {
      // 409s carry the close-date explanation; 400s the validation message.
      setSubmitError(err instanceof ApiRequestError ? err.message : 'Unable to save the pay plan');
    } finally {
      setSubmitting(false);
    }
  }, [accessToken, built.rules, mode, name, description, navigate, structureId, onDone]);

  // Owner-only self-guard (routes also gate on payroll.view for the section).
  if (auth.user && !isOwnerEditor) {
    return <Navigate to="/payroll/structures" replace />;
  }

  const stepIndex = steps.indexOf(step);
  const updateStage = (key: number, patch: Partial<DraftStage>) => {
    setStages((current) =>
      current.map((stage) => (stage.key === key ? { ...stage, ...patch } : stage)),
    );
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 lg:px-8">
      {mode === 'create' ? (
        <Link
          to="/payroll/structures"
          className="text-[12px] font-medium text-primary transition hover:text-primary-deep"
        >
          ← Pay plans
        </Link>
      ) : (
        <button
          type="button"
          onClick={onCancel}
          className="text-[12px] font-medium text-primary transition hover:text-primary-deep"
        >
          ← Back to {structureName ?? 'the pay plan'}
        </button>
      )}

      <header className="mb-6 mt-3">
        <AppText as="h1" variant="heading" weight="medium">
          {mode === 'create' ? 'New pay plan' : `New version — ${structureName ?? ''}`}
        </AppText>
        <AppText as="p" variant="caption" tone="muted" className="mt-1">
          {mode === 'create'
            ? 'Start from a template, tune the parameters, then check the preview before saving.'
            : 'Tune the parameters, then check the preview before saving the new version.'}
        </AppText>
      </header>

      {/* Step indicator */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {steps.map((entry, index) => (
          <div key={entry} className="flex items-center gap-2">
            {index > 0 ? <span className="text-[11px] text-text-subtle">→</span> : null}
            <span
              className={cn(
                'rounded-pill border px-3 py-1 text-[12px] font-medium',
                entry === step
                  ? 'border-primary bg-primary-soft text-text-primary'
                  : index < stepIndex
                    ? 'border-border-strong bg-surface-alt text-text-secondary'
                    : 'border-border text-text-subtle',
              )}
            >
              {index + 1}. {STEP_LABELS[entry]}
            </span>
          </div>
        ))}
      </div>

      {stepError ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {stepError}
        </div>
      ) : null}

      {step === 'template' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {TEMPLATES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => selectTemplate(entry.id)}
              className="text-left"
            >
              <AppCard
                padding="md"
                elevation="none"
                className={cn(
                  'h-full border-[1.5px] transition',
                  template === entry.id
                    ? 'border-primary bg-primary-soft'
                    : 'hover:border-border-strong',
                )}
              >
                <AppText as="div" weight="medium" className="text-[14px]">
                  {entry.name}
                </AppText>
                <AppText as="p" variant="caption" tone="muted" className="mt-1">
                  {entry.description}
                </AppText>
              </AppCard>
            </button>
          ))}
        </div>
      ) : null}

      {step === 'parameters' ? (
        <div className="space-y-4">
          {mode === 'version' ? (
            <div className="rounded-input-lg border border-warning-border bg-warning-soft px-4 py-3">
              <AppText as="div" variant="caption" tone="warning">
                You are creating version {nextVersionNo ?? '—'}; the current version closes on the
                new effective date.
              </AppText>
            </div>
          ) : null}

          {mode === 'create' ? (
            <AppCard padding="md" elevation="none" className="border-[1.5px]">
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldShell label="Name">
                  <input
                    className={INPUT_CLASSES}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Stylist standard"
                    maxLength={120}
                  />
                </FieldShell>
                <FieldShell label="Description" optional>
                  <input
                    className={INPUT_CLASSES}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Shown on the pay plan list"
                    maxLength={500}
                  />
                </FieldShell>
              </div>
            </AppCard>
          ) : null}

          <AppCard padding="md" elevation="none" className="border-[1.5px]">
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldShell
                label="Effective from"
                hint={
                  mode === 'version'
                    ? 'The current version closes on this date; the new rules price work from this date.'
                    : 'The first date these rules price work. To cover a pay period that has already started, set this on or before that period’s start date — rules are resolved at period start.'
                }
              >
                <input
                  type="date"
                  className={cn(INPUT_CLASSES, 'max-w-xs')}
                  value={effectiveFrom}
                  onChange={(event) => setEffectiveFrom(event.target.value)}
                />
              </FieldShell>
              <FieldShell
                label="Commission is calculated on"
                hint="One setting for the whole plan — every revenue figure, target and split uses the same prices."
              >
                <div className="flex flex-wrap gap-2 pt-1">
                  {(
                    [
                      ['inclusive', 'Prices including VAT'],
                      ['exclusive', 'Prices excluding VAT'],
                    ] as [PayrollVatBasis, string][]
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setVatBasis(value)}
                      className={cn(
                        'rounded-pill border px-3 py-1.5 text-[13px] font-medium transition',
                        vatBasis === value
                          ? 'border-primary bg-primary-soft text-text-primary'
                          : 'border-border-strong text-text-secondary hover:bg-surface-alt',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </FieldShell>
            </div>
          </AppCard>

          {stages.map((stage, index) => (
            <StageParametersCard
              key={stage.key}
              stage={stage}
              index={index}
              derivedTarget={derivedTarget}
              onChange={(patch) => updateStage(stage.key, patch)}
              onRemove={stage.stageType === 'bonus' ? () => removeStage(stage.key) : undefined}
            />
          ))}

          <AppButton size="sm" variant="ghost" onClick={addBonus}>
            + Add bonus
          </AppButton>
        </div>
      ) : null}

      {step === 'hours' ? (
        <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
          <div className="border-b border-border-divider bg-surface-alt px-4 py-3">
            <AppText
              as="div"
              variant="caption"
              weight="medium"
              uppercase
              className="text-text-subtle"
            >
              Hour rules
            </AppText>
            <AppText as="p" variant="caption" className="mt-1">
              Standard salon defaults are applied — most salons don't need to change these.
            </AppText>
            <AppText as="p" variant="micro" tone="muted" className="mt-1">
              For each category of time: does it count toward the service revenue target, and is it
              paid? All eight must be decided — absence is not a default.
            </AppText>
          </div>
          <button
            type="button"
            onClick={() => setHoursExpanded((value) => !value)}
            className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-surface-alt"
            aria-expanded={hoursExpanded}
          >
            <AppText as="span" variant="caption" weight="medium">
              {hoursExpanded ? 'Hide time & hours settings' : 'Show time & hours settings'}
            </AppText>
            <span className="text-[11px] font-medium text-primary" aria-hidden>
              {hoursExpanded ? '▴' : '▾'}
            </span>
          </button>
          {hoursExpanded ? (
            <>
              <div
                className="grid items-center border-t border-border-divider bg-surface-alt px-4 py-2.5"
                style={{ gridTemplateColumns: HOUR_COLS }}
              >
                {['Category', 'Counts toward target', 'Paid'].map((heading) => (
                  <AppText
                    key={heading}
                    as="div"
                    variant="micro"
                    weight="medium"
                    uppercase
                    className="text-text-subtle"
                  >
                    {heading}
                  </AppText>
                ))}
              </div>
              {hourRules.map((rule) => (
                <div
                  key={rule.category}
                  className="grid items-center border-t border-border-divider px-4 py-2.5"
                  style={{ gridTemplateColumns: HOUR_COLS }}
                >
                  <AppText as="div" className="text-[13px]">
                    {HOUR_CATEGORY_LABELS[rule.category]}
                  </AppText>
                  <div>
                    <input
                      type="checkbox"
                      checked={rule.countsTowardTarget}
                      onChange={(event) =>
                        setHourRules((current) =>
                          current.map((entry) =>
                            entry.category === rule.category
                              ? { ...entry, countsTowardTarget: event.target.checked }
                              : entry,
                          ),
                        )
                      }
                      className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
                      aria-label={`${HOUR_CATEGORY_LABELS[rule.category]} counts toward target`}
                    />
                  </div>
                  <div>
                    <input
                      type="checkbox"
                      checked={rule.countsAsPaid}
                      onChange={(event) =>
                        setHourRules((current) =>
                          current.map((entry) =>
                            entry.category === rule.category
                              ? { ...entry, countsAsPaid: event.target.checked }
                              : entry,
                          ),
                        )
                      }
                      className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
                      aria-label={`${HOUR_CATEGORY_LABELS[rule.category]} is paid`}
                    />
                  </div>
                </div>
              ))}
            </>
          ) : null}
        </AppCard>
      ) : null}

      {step === 'review' ? (
        <div className="space-y-4">
          <AppCard padding="md" elevation="none" className="border-[1.5px]">
            <AppText
              as="div"
              variant="caption"
              weight="medium"
              uppercase
              className="text-text-subtle"
            >
              Try it with an example week
            </AppText>
            <AppText as="p" variant="caption" tone="muted" className="mt-1">
              These are what-if figures to see the plan in action — they are not targets and are
              not saved with the plan.
            </AppText>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <FieldShell label="Example hourly rate (£)">
                <input
                  className={INPUT_CLASSES}
                  inputMode="decimal"
                  value={sampleHourlyRate}
                  onChange={(event) => setSampleHourlyRate(event.target.value)}
                />
              </FieldShell>
              <FieldShell label="Example hours">
                <input
                  className={INPUT_CLASSES}
                  inputMode="decimal"
                  value={sampleHours}
                  onChange={(event) => setSampleHours(event.target.value)}
                />
              </FieldShell>
              <FieldShell label="Example service revenue (£)">
                <input
                  className={INPUT_CLASSES}
                  inputMode="decimal"
                  value={sampleServiceRevenue}
                  onChange={(event) => setSampleServiceRevenue(event.target.value)}
                />
              </FieldShell>
              <FieldShell label="Example retail revenue (£)">
                <input
                  className={INPUT_CLASSES}
                  inputMode="decimal"
                  value={sampleRetailRevenue}
                  onChange={(event) => setSampleRetailRevenue(event.target.value)}
                />
              </FieldShell>
            </div>
            <AppText as="p" variant="micro" tone="muted" className="mt-3">
              {PREVIEW_NOTE}
            </AppText>
          </AppCard>

          {previewError ? (
            <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {previewError}
            </div>
          ) : null}

          {previewLoading && !preview ? (
            <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-8 text-center text-[13px] text-text-secondary">
              Running the engine over the drafted rules…
            </div>
          ) : null}

          {preview ? <PreviewResult preview={preview} refreshing={previewLoading} /> : null}

          {submitError ? (
            <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {submitError}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Footer navigation */}
      <div className="mt-6 flex items-center justify-between gap-3">
        <div>
          {stepIndex > 0 ? (
            <AppButton size="sm" variant="secondary" onClick={goBack} disabled={submitting}>
              Back
            </AppButton>
          ) : mode === 'version' ? (
            <AppButton size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </AppButton>
          ) : null}
        </div>
        {step === 'review' ? (
          <AppButton
            size="sm"
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!built.rules}
          >
            {mode === 'create' ? 'Create pay plan' : `Create version ${nextVersionNo ?? ''}`}
          </AppButton>
        ) : (
          <AppButton size="sm" onClick={goNext}>
            Next
          </AppButton>
        )}
      </div>
    </div>
  );
}

const STEP_LABELS: Record<WizardStep, string> = {
  template: 'Template',
  parameters: 'Parameters',
  hours: 'Hour rules',
  review: 'Review & preview',
};

const HOUR_COLS = '1.6fr 1fr 0.6fr';
const BAND_COLS = 'minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) 32px';

// -----------------------------------------------------------------------------
// Step 2 — per-stage parameter cards
// -----------------------------------------------------------------------------

/** Stage types with an explicit Include/Exclude toggle in the wizard. */
const TOGGLEABLE_STAGE_TYPES: PayStageType[] = ['revenue_split', 'chair_rent'];

const STAGE_TOGGLE_LABELS: Partial<Record<PayStageType, string>> = {
  revenue_split: 'Include revenue split',
  chair_rent: 'Include chair rent',
};

const STAGE_TOGGLE_OFF_HINTS: Partial<Record<PayStageType, string>> = {
  revenue_split: 'Not part of this plan — turn on to pay the stylist a share of their takings.',
  chair_rent: 'Not part of this plan — turn on to charge rent each period.',
};

function StageParametersCard({
  stage,
  index,
  derivedTarget,
  onChange,
  onRemove,
}: {
  stage: DraftStage;
  index: number;
  derivedTarget: DerivedTargetSummary;
  onChange: (patch: Partial<DraftStage>) => void;
  /** Present only for removable stages (bonuses). */
  onRemove?: () => void;
}) {
  const toggleable = TOGGLEABLE_STAGE_TYPES.includes(stage.stageType);
  return (
    <AppCard
      padding="md"
      elevation="none"
      className={cn('border-[1.5px]', !stage.enabled && 'bg-surface-alt')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AppText
          as="div"
          weight="medium"
          className={cn('text-[14px]', !stage.enabled && 'text-text-muted')}
        >
          {index + 1}. {stage.label || PAY_STAGE_TYPE_LABELS[stage.stageType]}
        </AppText>
        <StatusBadge label={PAY_STAGE_TYPE_LABELS[stage.stageType]} tone="neutral" />
        {stage.inGreaterOfComparison ? (
          <StatusBadge label="In greater-of comparison" tone="neutral" />
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          {toggleable ? (
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={stage.enabled}
                onChange={(event) => onChange({ enabled: event.target.checked })}
                className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
              />
              <AppText as="span" variant="caption" weight="medium">
                {STAGE_TOGGLE_LABELS[stage.stageType]}
              </AppText>
            </label>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              className="text-[12px] font-medium text-text-subtle transition hover:text-danger"
            >
              Remove
            </button>
          ) : null}
        </div>
      </div>

      {!stage.enabled ? (
        <AppText as="p" variant="caption" tone="muted" className="mt-2">
          {STAGE_TOGGLE_OFF_HINTS[stage.stageType] ?? 'Not part of this plan.'}
        </AppText>
      ) : null}

      {stage.enabled && stage.requiresDataSource === 'retail_sales' ? (
        <div className="mt-3 rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2.5">
          <AppText as="div" variant="caption" tone="warning">
            {RETAIL_NOTE}
          </AppText>
        </div>
      ) : null}

      {stage.stageType === 'base_pay' ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <FieldShell label="Base pay source">
            <select
              className={INPUT_CLASSES}
              value={stage.baseSource}
              onChange={(event) =>
                onChange({ baseSource: event.target.value as DraftStage['baseSource'] })
              }
            >
              <option value="hourly_rate_x_payable_hours">Hourly rate × payable hours</option>
              <option value="fixed_amount">Fixed amount per period</option>
            </select>
          </FieldShell>
          {stage.baseSource === 'fixed_amount' ? (
            <FieldShell label="Fixed amount (£)">
              <input
                className={INPUT_CLASSES}
                inputMode="decimal"
                value={stage.amountPounds}
                onChange={(event) => onChange({ amountPounds: event.target.value })}
              />
            </FieldShell>
          ) : (
            <AppText as="p" variant="micro" tone="muted" className="self-end pb-1">
              The hourly rate comes from each staff member's profile; payable hours follow the hour
              rules step.
            </AppText>
          )}
        </div>
      ) : null}

      {stage.stageType === 'commission' ? (
        <CommissionStageFields stage={stage} derivedTarget={derivedTarget} onChange={onChange} />
      ) : null}

      {stage.enabled && stage.stageType === 'revenue_split' ? (
        <div className="mt-3 max-w-xs">
          <FieldShell label="Split to the stylist (%)">
            <input
              className={INPUT_CLASSES}
              inputMode="decimal"
              value={stage.splitPercent}
              onChange={(event) => onChange({ splitPercent: event.target.value })}
            />
          </FieldShell>
        </div>
      ) : null}

      {stage.enabled && stage.stageType === 'chair_rent' ? (
        <div className="mt-3 max-w-xs">
          <FieldShell label="Rent (£)" hint="Charged once per calculation period.">
            <input
              className={INPUT_CLASSES}
              inputMode="decimal"
              value={stage.amountPounds}
              onChange={(event) => onChange({ amountPounds: event.target.value })}
            />
          </FieldShell>
        </div>
      ) : null}

      {stage.stageType === 'bonus' ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <FieldShell
            label="Bonus name"
            hint="Shown as its own line on the payslip — e.g. Christmas bonus."
          >
            <input
              className={INPUT_CLASSES}
              value={stage.label}
              onChange={(event) => onChange({ label: event.target.value })}
              placeholder="e.g. Christmas bonus"
              maxLength={120}
            />
          </FieldShell>
          <FieldShell label="Bonus (£)" hint="A fixed amount added each calculation period.">
            <input
              className={INPUT_CLASSES}
              inputMode="decimal"
              value={stage.amountPounds}
              onChange={(event) => onChange({ amountPounds: event.target.value })}
            />
          </FieldShell>
        </div>
      ) : null}

      {stage.stageType === 'deduction' ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <FieldShell label="Deduction source">
            <select
              className={INPUT_CLASSES}
              value={stage.deductionSource}
              onChange={(event) =>
                onChange({ deductionSource: event.target.value as DraftStage['deductionSource'] })
              }
            >
              <option value="fixed">Fixed amount</option>
              <option value="product_cost">Product & colour cost</option>
            </select>
          </FieldShell>
          {stage.deductionSource === 'fixed' ? (
            <FieldShell label="Amount (£)">
              <input
                className={INPUT_CLASSES}
                inputMode="decimal"
                value={stage.amountPounds}
                onChange={(event) => onChange({ amountPounds: event.target.value })}
              />
            </FieldShell>
          ) : null}
        </div>
      ) : null}

      {stage.stageType === 'greater_of' ? (
        <AppText as="p" variant="caption" tone="muted" className="mt-3">
          Pays whichever of the stages marked "In greater-of comparison" comes out higher. It has no
          parameters of its own.
        </AppText>
      ) : null}
    </AppCard>
  );
}

function CommissionStageFields({
  stage,
  derivedTarget,
  onChange,
}: {
  stage: DraftStage;
  derivedTarget: DerivedTargetSummary;
  onChange: (patch: Partial<DraftStage>) => void;
}) {
  const fromHeading = BASIS_FROM_HEADING[stage.thresholdBasis];
  const updateBand = (key: number, patch: Partial<DraftBand>) => {
    onChange({
      bands: stage.bands.map((band) => (band.key === key ? { ...band, ...patch } : band)),
    });
  };
  const showAcceleratorColumn = stage.accelerator !== null;

  // The target, stated up front — Luke's review showed the bands are read as
  // targets, so say what the target actually is before any band editing.
  let targetLine: string | null = null;
  if (stage.key === derivedTarget.sourceStageKey) {
    if (derivedTarget.lowestFrom === null) {
      targetLine = 'No service revenue target — commission starts from the first pound.';
    } else if (derivedTarget.basis === 'multiple_of_base_pay') {
      targetLine = `Service revenue target: ${derivedTarget.lowestFrom}× base pay${
        derivedTarget.exampleTargetCents !== null
          ? ` = ${formatMoney(derivedTarget.exampleTargetCents, CURRENCY)} on the example week`
          : ''
      }.`;
    } else if (derivedTarget.basis === 'absolute') {
      targetLine = `Service revenue target: ${
        derivedTarget.exampleTargetCents !== null
          ? formatMoney(derivedTarget.exampleTargetCents, CURRENCY)
          : `£${derivedTarget.lowestFrom}`
      } per period.`;
    }
  } else if (
    stage.revenueStream === 'retail' &&
    stage.thresholdBasis === 'percent_of_service_target'
  ) {
    targetLine = `Retail bands are a % of the service revenue target${
      derivedTarget.exampleTargetCents !== null
        ? ` (${formatMoney(derivedTarget.exampleTargetCents, CURRENCY)} on the example week)`
        : ''
    }.`;
  }

  return (
    <div className="mt-3 space-y-4">
      {targetLine ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2.5">
          <AppText as="div" variant="caption" weight="medium">
            {targetLine}
          </AppText>
        </div>
      ) : null}
      <AppText as="p" variant="caption">
        Commission is paid on revenue above the thresholds below.
      </AppText>
      <AppText as="p" variant="micro" tone="muted">
        Band thresholds are {THRESHOLD_BASIS_LABELS[stage.thresholdBasis].toLowerCase()}.
      </AppText>

      {/* Marginal vs retroactive — the most consequential setting in the engine */}
      {stage.semanticsEditable ? (
        <div>
          <AppText as="div" variant="micro" weight="medium" uppercase className="text-text-subtle">
            Tier semantics
          </AppText>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {(['marginal', 'retroactive'] as TierSemantics[]).map((semantics) => (
              <button
                key={semantics}
                type="button"
                onClick={() => onChange({ tierSemantics: semantics })}
                className={cn(
                  'rounded-pill border px-3 py-1.5 text-[13px] font-medium transition',
                  stage.tierSemantics === semantics
                    ? 'border-primary bg-primary-soft text-text-primary'
                    : 'border-border-strong text-text-secondary hover:bg-surface-alt',
                )}
              >
                {TIER_SEMANTICS_LABELS[semantics]}
              </button>
            ))}
          </div>
          <AppText as="p" variant="caption" tone="muted" className="mt-2">
            {TIER_SEMANTICS_DESCRIPTIONS[stage.tierSemantics]}
          </AppText>
          <AppText as="p" variant="caption" tone="warning" className="mt-1">
            {SEMANTICS_WARNING}
          </AppText>
        </div>
      ) : (
        <AppText as="p" variant="micro" tone="muted">
          {TIER_SEMANTICS_LABELS[stage.tierSemantics]} —{' '}
          {TIER_SEMANTICS_DESCRIPTIONS[stage.tierSemantics]}
        </AppText>
      )}

      {/* Band rows */}
      <div>
        <div
          className="grid items-center gap-2 px-1 pb-1.5"
          style={{
            gridTemplateColumns: showAcceleratorColumn
              ? BAND_COLS
              : 'minmax(0,1.2fr) minmax(0,1fr) 32px',
          }}
        >
          <AppText as="div" variant="micro" weight="medium" uppercase className="text-text-subtle">
            {fromHeading}
          </AppText>
          <AppText as="div" variant="micro" weight="medium" uppercase className="text-text-subtle">
            Rate (%)
          </AppText>
          {showAcceleratorColumn ? (
            <AppText
              as="div"
              variant="micro"
              weight="medium"
              uppercase
              className="text-text-subtle"
            >
              Accel. rate (%)
            </AppText>
          ) : null}
          <span />
        </div>
        <div className="space-y-1.5">
          {stage.bands.map((band) => (
            <div
              key={band.key}
              className="grid items-center gap-2 px-1"
              style={{
                gridTemplateColumns: showAcceleratorColumn
                  ? BAND_COLS
                  : 'minmax(0,1.2fr) minmax(0,1fr) 32px',
              }}
            >
              <input
                className={INPUT_SM_CLASSES}
                inputMode="decimal"
                value={band.from}
                onChange={(event) => updateBand(band.key, { from: event.target.value })}
              />
              <input
                className={INPUT_SM_CLASSES}
                inputMode="decimal"
                value={band.rate}
                onChange={(event) => updateBand(band.key, { rate: event.target.value })}
              />
              {showAcceleratorColumn ? (
                <input
                  className={INPUT_SM_CLASSES}
                  inputMode="decimal"
                  placeholder="—"
                  value={band.acceleratorRate}
                  onChange={(event) =>
                    updateBand(band.key, { acceleratorRate: event.target.value })
                  }
                />
              ) : null}
              <button
                type="button"
                onClick={() =>
                  onChange({ bands: stage.bands.filter((entry) => entry.key !== band.key) })
                }
                disabled={stage.bands.length <= 1}
                className="justify-self-center text-[15px] leading-none text-text-subtle transition hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Remove band"
                title={
                  stage.bands.length <= 1
                    ? 'A commission stage needs at least one band'
                    : 'Remove band'
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <AppButton
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() =>
            onChange({
              bands: [...stage.bands, { key: nextKey(), from: '', rate: '', acceleratorRate: '' }],
            })
          }
        >
          + Add band
        </AppButton>
      </div>

      {/* Accelerator — carried as data; conditions are part of the template */}
      {stage.accelerator ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2.5">
          <AppText as="div" variant="micro" weight="medium" uppercase className="text-text-subtle">
            Accelerator — {ACCELERATOR_EVALUATION_LABELS[stage.accelerator.evaluationMode]}
          </AppText>
          <ul className="mt-1.5 space-y-1">
            {stage.accelerator.conditions.map((condition, conditionIndex) => (
              <li key={`${condition.metric}-${conditionIndex}`}>
                <AppText as="span" variant="caption">
                  {acceleratorConditionLabel(condition, CURRENCY)}
                </AppText>
              </li>
            ))}
          </ul>
          <AppText as="p" variant="micro" tone="muted" className="mt-1.5">
            When achieved, bands with an accelerator rate pay that rate instead of their normal
            rate.
          </AppText>
        </div>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Step 4 — preview rendering (figures come straight from the engine)
// -----------------------------------------------------------------------------

function PreviewResult({
  preview,
  refreshing,
}: {
  preview: PayStructurePreviewResponse;
  refreshing: boolean;
}) {
  return (
    <AppCard
      padding="md"
      elevation="none"
      className={cn('border-[1.5px]', refreshing && 'opacity-60')}
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <PreviewStat label="Base pay" value={formatMoney(preview.basePayCents, CURRENCY)} />
        <PreviewStat label="Commission" value={formatMoney(preview.commissionCents, CURRENCY)} />
        {preview.revenueSplitCents !== 0 ? (
          <PreviewStat
            label="Revenue split"
            value={formatMoney(preview.revenueSplitCents, CURRENCY)}
          />
        ) : null}
        {preview.bonusCents !== 0 ? (
          <PreviewStat label="Bonus" value={formatMoney(preview.bonusCents, CURRENCY)} />
        ) : null}
        {preview.chairRentCents !== 0 ? (
          <PreviewStat label="Chair rent" value={formatMoney(preview.chairRentCents, CURRENCY)} />
        ) : null}
        {preview.deductionsCents !== 0 ? (
          <PreviewStat label="Deductions" value={formatMoney(preview.deductionsCents, CURRENCY)} />
        ) : null}
      </div>

      {/* Target + derivation */}
      <div className="mt-4 rounded-input-lg border border-border px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <AppText as="div" weight="medium" className="text-[14px]">
            {preview.target.targetCents !== null
              ? formatMoney(preview.target.targetCents, CURRENCY)
              : 'No target'}
          </AppText>
          {preview.target.basis ? (
            <AppText as="div" variant="micro" tone="muted">
              {THRESHOLD_BASIS_LABELS[preview.target.basis]}
            </AppText>
          ) : null}
        </div>
        <AppText as="div" variant="caption" tone="muted" className="mt-1">
          {preview.target.derivation}
        </AppText>
      </div>

      {/* Per-band slices */}
      {preview.bands.length > 0 ? (
        <div className="mt-4">
          <AppText as="div" variant="micro" weight="medium" uppercase className="text-text-subtle">
            Commission bands
          </AppText>
          <div className="mt-1.5 space-y-1.5">
            {preview.bands.map((band) => (
              <div key={band.bandId} className="rounded-input-lg border border-border px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <AppText as="div" weight="medium" className="text-[13px]">
                    From {band.fromLabel}
                  </AppText>
                  <AppText as="div" weight="medium" className="text-[13px]">
                    {formatMoney(band.amountCents, CURRENCY)}
                  </AppText>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <AppText as="span" variant="micro" tone="muted">
                    {formatMoney(band.sliceFromCents, CURRENCY)} –{' '}
                    {band.sliceToCents !== null
                      ? formatMoney(band.sliceToCents, CURRENCY)
                      : 'no upper limit'}{' '}
                    at {band.ratePercentApplied}%
                  </AppText>
                  {band.acceleratorRateApplied ? (
                    <StatusBadge label="Accelerator rate" tone="success" />
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Accelerator per-condition outcomes */}
      {preview.accelerator ? (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-2">
            <AppText
              as="div"
              variant="micro"
              weight="medium"
              uppercase
              className="text-text-subtle"
            >
              Accelerator
            </AppText>
            {preview.accelerator.achieved === true ? (
              <StatusBadge label="Achieved" tone="success" />
            ) : preview.accelerator.achieved === false ? (
              <StatusBadge label="Not achieved" tone="neutral" />
            ) : (
              <StatusBadge label="Could not evaluate" tone="warning" />
            )}
          </div>
          {preview.accelerator.achieved === null ? (
            <AppText as="p" variant="micro" tone="warning" className="mt-1">
              Counted as not achieved — the lower band rate applies, which is the safe direction.
            </AppText>
          ) : null}
          <div className="mt-1.5 space-y-1.5">
            {preview.accelerator.conditions.map((condition, index) => (
              <div
                key={`${condition.metric}-${index}`}
                className="flex items-start justify-between gap-3 rounded-input-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <AppText as="div" className="text-[13px]">
                    {acceleratorConditionLabel(condition, CURRENCY)}
                  </AppText>
                  {condition.unevaluableReason ? (
                    <AppText as="div" variant="micro" tone="warning" className="mt-0.5">
                      {condition.unevaluableReason}
                    </AppText>
                  ) : null}
                </div>
                {condition.passed === true ? (
                  <StatusBadge label="Passed" tone="success" />
                ) : condition.passed === false ? (
                  <StatusBadge label="Not met" tone="neutral" />
                ) : (
                  <StatusBadge label="Could not evaluate" tone="warning" />
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Greater-of — both sides survive */}
      {preview.greaterOf ? (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-2">
            <AppText
              as="div"
              variant="micro"
              weight="medium"
              uppercase
              className="text-text-subtle"
            >
              Whichever is higher
            </AppText>
            {preview.greaterOf.applied ? (
              <StatusBadge label="Applied" tone="success" />
            ) : (
              <StatusBadge label="Not applied" tone="neutral" />
            )}
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <GreaterOfSide
              label="Base pay"
              amountCents={preview.greaterOf.basePayCents}
              winner={preview.greaterOf.winner === 'base_pay'}
            />
            <GreaterOfSide
              label="Commission"
              amountCents={preview.greaterOf.commissionCents}
              winner={preview.greaterOf.winner === 'commission'}
            />
            {preview.greaterOf.revenueSplitCents !== null ? (
              <GreaterOfSide
                label="Revenue split"
                amountCents={preview.greaterOf.revenueSplitCents}
                winner={preview.greaterOf.winner === 'revenue_split'}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {preview.warnings.length > 0 ? (
        <PayrollWarningNotice warnings={preview.warnings} className="mt-4" />
      ) : null}

      {/* NET total */}
      <div className="mt-4 flex items-center justify-between rounded-input-lg border border-border bg-surface-alt px-3 py-2.5">
        <AppText as="div" weight="medium" className="text-[13px]">
          Net payable
        </AppText>
        <AppText
          as="div"
          variant="title"
          weight="medium"
          tone={preview.netPayableCents > 0 ? 'success' : 'primary'}
        >
          {signedMoney(preview.netPayableCents, CURRENCY)}
        </AppText>
      </div>
    </AppCard>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <AppText as="div" variant="micro" tone="muted" className="truncate">
        {label}
      </AppText>
      <AppText as="div" weight="medium" className="mt-0.5 text-[14px]">
        {value}
      </AppText>
    </div>
  );
}

function GreaterOfSide({
  label,
  amountCents,
  winner,
}: {
  label: string;
  amountCents: number;
  winner: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-input-lg border px-3 py-2',
        winner ? 'border-success bg-success-soft' : 'border-border',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <AppText as="div" variant="micro" tone="muted">
          {label}
        </AppText>
        {winner ? <StatusBadge label="Paid" tone="success" /> : null}
      </div>
      <AppText as="div" weight="medium" className="mt-0.5 text-[14px]">
        {formatMoney(amountCents, CURRENCY)}
      </AppText>
    </div>
  );
}

function FieldShell({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
          {label}
        </span>
        {optional ? (
          <span className="text-[11px] font-medium text-text-muted">Optional</span>
        ) : null}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-[12px] text-text-secondary">{hint}</span> : null}
    </label>
  );
}
