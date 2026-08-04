import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type {
  PayStructureDetailResponse,
  PayStructureStageDetail,
  PayStructureVersionDetail,
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
import { AppButton, AppCard, AppText, StatusBadge } from '../design';
import { formatMoney } from '../components/kpi/format';
import {
  acceleratorConditionLabel,
  bandFromLabel,
  versionWindowLabel,
} from '../components/payroll/structureFormat';
import { PayStructureWizard } from '../components/payroll/PayStructureWizard';
import { useAuth } from '../auth/AuthProvider';
import { ApiRequestError, getPayStructure } from '../auth/api';

const CURRENCY = 'GBP';
const BAND_COLS = '1.4fr 0.8fr 1fr';
const HOUR_COLS = '1.6fr 1fr 0.6fr';

/**
 * One pay structure: header, then every version newest-first. The current
 * version is expanded; older ones collapse. A version that has priced pay runs
 * is frozen by the DB — the amber badge says so up front, and rate changes go
 * through "New version" (close the current version, insert N+1) instead.
 */
export function PayStructureDetailPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const params = useParams<{ structureId: string }>();
  const structureId = params.structureId;

  const canView = userHasPermission(auth.user, 'payroll.view');
  const canAuthor = userHasRole(auth.user, 'owner') && userHasPermission(auth.user, 'payroll.edit');

  const [detail, setDetail] = useState<PayStructureDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingVersion, setCreatingVersion] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken || !structureId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await getPayStructure(accessToken, structureId));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to load this pay structure');
    } finally {
      setLoading(false);
    }
  }, [accessToken, structureId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (auth.user && !canView) {
    return <Navigate to="/dashboard" replace />;
  }

  const versions = detail ? [...detail.versions].sort((a, b) => b.versionNo - a.versionNo) : [];
  const currentVersion = detail
    ? (versions.find((version) => version.id === detail.currentVersionId) ?? versions[0] ?? null)
    : null;
  const nextVersionNo = versions.length > 0 ? versions[0].versionNo + 1 : 1;

  if (creatingVersion && detail && currentVersion && structureId) {
    return (
      <PayStructureWizard
        mode="version"
        structureId={structureId}
        structureName={detail.structure.name}
        nextVersionNo={nextVersionNo}
        sourceVersion={currentVersion}
        onCancel={() => setCreatingVersion(false)}
        onDone={() => {
          setCreatingVersion(false);
          void load();
        }}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 lg:px-8">
      <Link
        to="/payroll/structures"
        className="text-[12px] font-medium text-primary transition hover:text-primary-deep"
      >
        ← Pay structures
      </Link>

      {loading && !detail ? (
        <div className="mt-4 rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          Loading pay structure…
        </div>
      ) : error && !detail ? (
        <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : detail ? (
        <>
          <header className="mb-6 mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <AppText as="h1" variant="heading" weight="medium">
                  {detail.structure.name}
                </AppText>
                <StatusBadge
                  label={detail.structure.isActive ? 'Active' : 'Inactive'}
                  tone={detail.structure.isActive ? 'success' : 'neutral'}
                />
                {detail.structure.isSystem ? <StatusBadge label="System" tone="neutral" /> : null}
              </div>
              {detail.structure.description ? (
                <AppText as="p" variant="caption" tone="muted" className="mt-1">
                  {detail.structure.description}
                </AppText>
              ) : null}
              <AppText as="p" variant="micro" tone="muted" className="mt-1">
                {detail.structure.assignedStaffCount}{' '}
                {detail.structure.assignedStaffCount === 1 ? 'staff member' : 'staff members'}{' '}
                assigned
              </AppText>
            </div>
            {canAuthor && currentVersion ? (
              <AppButton size="sm" onClick={() => setCreatingVersion(true)}>
                New version
              </AppButton>
            ) : null}
          </header>

          <div className="space-y-4">
            {versions.map((version) => (
              <VersionCard
                key={version.id}
                version={version}
                isCurrent={version.id === detail.currentVersionId}
              />
            ))}
            {versions.length === 0 ? (
              <div className="rounded-input-lg border border-dashed border-border-strong bg-surface px-4 py-10 text-center text-[13px] text-text-secondary">
                This structure has no versions yet.
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function VersionCard({
  version,
  isCurrent,
}: {
  version: PayStructureVersionDetail;
  isCurrent: boolean;
}) {
  const [expanded, setExpanded] = useState(isCurrent);
  return (
    <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full flex-wrap items-center justify-between gap-2 bg-surface-alt px-4 py-3 text-left transition hover:bg-surface"
      >
        <div className="flex flex-wrap items-center gap-2">
          <AppText as="div" weight="medium" className="text-[14px]">
            Version {version.versionNo}
          </AppText>
          {isCurrent ? <StatusBadge label="Current" tone="success" /> : null}
          {version.isUsed ? (
            <StatusBadge label="Priced pay runs — rules locked" tone="warning" />
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <AppText as="div" variant="micro" tone="muted">
            {versionWindowLabel(version.effectiveFrom, version.effectiveTo)}
          </AppText>
          <span className="text-[11px] font-medium text-primary">{expanded ? 'Hide' : 'Show'}</span>
        </div>
      </button>

      {expanded ? (
        <div className="space-y-4 border-t border-border-divider px-4 py-4">
          {version.isUsed ? (
            <div className="rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2.5">
              <AppText as="div" variant="caption" tone="warning">
                Pay runs have been priced with these rules, so they are frozen. To change rates,
                create a new version — the change takes effect from its start date.
              </AppText>
            </div>
          ) : null}

          {[...version.stages]
            .sort((a, b) => a.sequenceNo - b.sequenceNo)
            .map((stage) => (
              <StageDetail key={stage.id} stage={stage} />
            ))}

          <div>
            <AppText
              as="div"
              variant="micro"
              weight="medium"
              uppercase
              className="text-text-subtle"
            >
              Hour rules
            </AppText>
            <div className="mt-1.5 overflow-hidden rounded-input-lg border border-border">
              <div
                className="grid items-center bg-surface-alt px-3 py-2"
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
              {version.hourRules.map((rule) => (
                <div
                  key={rule.category}
                  className="grid items-center border-t border-border-divider px-3 py-2"
                  style={{ gridTemplateColumns: HOUR_COLS }}
                >
                  <AppText as="div" className="text-[13px]">
                    {HOUR_CATEGORY_LABELS[rule.category]}
                  </AppText>
                  <CountedFlag counted={rule.countsTowardTarget} />
                  <CountedFlag counted={rule.countsAsPaid} />
                </div>
              ))}
            </div>
          </div>

          {version.notes ? (
            <AppText as="p" variant="micro" tone="muted">
              {version.notes}
            </AppText>
          ) : null}
        </div>
      ) : null}
    </AppCard>
  );
}

function StageDetail({ stage }: { stage: PayStructureStageDetail }) {
  return (
    <div className="rounded-input-lg border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <AppText as="div" weight="medium" className="text-[13px]">
          {stage.sequenceNo}. {stage.label ?? PAY_STAGE_TYPE_LABELS[stage.stageType]}
        </AppText>
        <StatusBadge label={PAY_STAGE_TYPE_LABELS[stage.stageType]} tone="neutral" />
        {stage.inGreaterOfComparison ? (
          <StatusBadge label="In greater-of comparison" tone="neutral" />
        ) : null}
      </div>

      {stage.stageType === 'commission' ? (
        <div className="mt-2 space-y-2.5">
          <AppText as="p" variant="micro" tone="muted">
            {stage.tierSemantics ? (
              <>
                {TIER_SEMANTICS_LABELS[stage.tierSemantics]} —{' '}
                {TIER_SEMANTICS_DESCRIPTIONS[stage.tierSemantics]}{' '}
              </>
            ) : null}
            {stage.thresholdBasis
              ? `Thresholds: ${THRESHOLD_BASIS_LABELS[stage.thresholdBasis].toLowerCase()}.`
              : null}
          </AppText>

          <div className="overflow-hidden rounded-input-lg border border-border">
            <div
              className="grid items-center bg-surface-alt px-3 py-2"
              style={{ gridTemplateColumns: BAND_COLS }}
            >
              {['From', 'Rate', 'Accelerator rate'].map((heading) => (
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
            {[...stage.bands]
              .sort((a, b) => a.sequenceNo - b.sequenceNo)
              .map((band) => (
                <div
                  key={band.id}
                  className="grid items-center border-t border-border-divider px-3 py-2"
                  style={{ gridTemplateColumns: BAND_COLS }}
                >
                  <AppText as="div" className="text-[13px]">
                    {bandFromLabel(stage.thresholdBasis, band, CURRENCY)}
                  </AppText>
                  <AppText as="div" weight="medium" className="text-[13px]">
                    {band.ratePercent}%
                  </AppText>
                  <AppText as="div" className="text-[13px]">
                    {band.acceleratorRatePercent !== null ? (
                      `${band.acceleratorRatePercent}%`
                    ) : (
                      <AppText as="span" tone="muted">
                        —
                      </AppText>
                    )}
                  </AppText>
                </div>
              ))}
          </div>

          {stage.accelerator ? (
            <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2.5">
              <AppText
                as="div"
                variant="micro"
                weight="medium"
                uppercase
                className="text-text-subtle"
              >
                Accelerator — {ACCELERATOR_EVALUATION_LABELS[stage.accelerator.evaluationMode]}
                {stage.accelerator.evaluationMode === 'at_least_n' &&
                stage.accelerator.requiredConditionCount != null
                  ? ` (${stage.accelerator.requiredConditionCount} required)`
                  : ''}
              </AppText>
              <ul className="mt-1.5 space-y-1">
                {[...stage.accelerator.conditions]
                  .sort((a, b) => a.sequenceNo - b.sequenceNo)
                  .map((condition) => (
                    <li key={condition.sequenceNo}>
                      <AppText as="span" variant="caption">
                        {acceleratorConditionLabel(condition, CURRENCY)}
                      </AppText>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <AppText as="p" variant="micro" tone="muted" className="mt-1.5">
          {nonCommissionStageSummary(stage)}
        </AppText>
      )}
    </div>
  );
}

/** Plain-English summary of a non-commission stage's config. */
function nonCommissionStageSummary(stage: PayStructureStageDetail): string {
  const amountCents =
    typeof stage.config['amount_cents'] === 'number'
      ? (stage.config['amount_cents'] as number)
      : null;
  switch (stage.stageType) {
    case 'base_pay':
      return stage.config['source'] === 'fixed_amount'
        ? `Fixed ${amountCents !== null ? formatMoney(amountCents, CURRENCY) : '—'} per calculation period.`
        : "Hourly rate × payable hours — the rate comes from the staff member's profile.";
    case 'revenue_split': {
      const split = stage.config['split_percent'];
      return `${typeof split === 'number' ? split : '—'}% of revenue to the stylist.`;
    }
    case 'chair_rent':
      return `${amountCents !== null ? formatMoney(amountCents, CURRENCY) : '—'} per calculation period.`;
    case 'bonus':
      return `Fixed ${amountCents !== null ? formatMoney(amountCents, CURRENCY) : '—'} per calculation period.`;
    case 'deduction':
      return stage.config['source'] === 'product_cost'
        ? 'Deducts product & colour cost.'
        : `Fixed deduction of ${amountCents !== null ? formatMoney(amountCents, CURRENCY) : '—'} per period.`;
    case 'greater_of':
      return 'Pays whichever of the stages marked "In greater-of comparison" comes out higher.';
    default:
      return '';
  }
}

function CountedFlag({ counted }: { counted: boolean }) {
  return counted ? (
    <AppText as="div" weight="medium" tone="success" className="text-[13px]">
      ✓
    </AppText>
  ) : (
    <AppText as="div" tone="muted" className="text-[13px]">
      —
    </AppText>
  );
}
