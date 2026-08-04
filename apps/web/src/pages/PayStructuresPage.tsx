import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import type {
  PayrollBusinessDataSource,
  PayrollDataSource,
  PayStructureSummary,
} from '@sheer/domain';
import { PAYROLL_DATA_SOURCE_LABELS, userHasPermission, userHasRole } from '@sheer/domain';
import { AppButton, AppCard, AppText, StatusBadge } from '../design';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { useAuth } from '../auth/AuthProvider';
import {
  ApiRequestError,
  listPayStructures,
  listPayrollDataSources,
  updatePayrollDataSource,
} from '../auth/api';

const COLS = '2.2fr 1.2fr 0.7fr 72px';

/** Canonical display order for the capture matrix (mirrors the enum). */
const DATA_SOURCE_ORDER: PayrollDataSource[] = [
  'service_revenue',
  'retail_sales',
  'tips',
  'refunds',
  'cancellation_fees',
  'product_cost',
];

/**
 * Owner/manager pay-structure list — the rule templates that price staff pay.
 * Viewing needs payroll.view; authoring (New structure) is deliberately
 * owner-only on top of payroll.edit, matching the API.
 */
export function PayStructuresPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const canView = userHasPermission(auth.user, 'payroll.view');
  const canAuthor = userHasRole(auth.user, 'owner') && userHasPermission(auth.user, 'payroll.edit');
  const navigate = useNavigate();

  const [structures, setStructures] = useState<PayStructureSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dataSources, setDataSources] = useState<PayrollBusinessDataSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  // Marking retail as captured flips payroll from "warn about missing retail"
  // to "trust £0", so the enable direction demands an explicit confirm step.
  const [confirmingRetailCapture, setConfirmingRetailCapture] = useState(false);
  const [togglingSource, setTogglingSource] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listPayStructures(accessToken);
      setStructures(res.structures);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to load pay structures');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDataSources = useCallback(async () => {
    if (!accessToken) return;
    setSourcesLoading(true);
    setSourcesError(null);
    try {
      const res = await listPayrollDataSources(accessToken);
      setDataSources(res.dataSources);
    } catch (err) {
      setSourcesError(
        err instanceof ApiRequestError ? err.message : 'Unable to load the data-capture matrix',
      );
    } finally {
      setSourcesLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void loadDataSources();
  }, [loadDataSources]);

  const handleToggleRetailCapture = useCallback(
    async (isCaptured: boolean) => {
      if (!accessToken) return;
      setTogglingSource(true);
      setSourcesError(null);
      try {
        const res = await updatePayrollDataSource(accessToken, 'retail_sales', { isCaptured });
        setDataSources(res.dataSources);
        setConfirmingRetailCapture(false);
      } catch (err) {
        setSourcesError(
          err instanceof ApiRequestError ? err.message : 'Unable to update the data source',
        );
      } finally {
        setTogglingSource(false);
      }
    },
    [accessToken],
  );

  const orderedSources = DATA_SOURCE_ORDER.map((source) =>
    dataSources.find((row) => row.source === source),
  ).filter((row): row is PayrollBusinessDataSource => row !== undefined);

  if (auth.user && !canView) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <Link
        to="/payroll"
        className="text-[12px] font-medium text-primary transition hover:text-primary-deep"
      >
        ← Staff pay
      </Link>

      <header className="mb-6 mt-3 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <AppText as="h1" variant="heading" weight="medium">
            Pay structures
          </AppText>
          <AppText as="p" variant="caption" tone="muted" className="mt-1">
            The rule templates that price staff pay — assign one to each staff member.
          </AppText>
        </div>
        {canAuthor ? (
          <AppButton size="sm" onClick={() => navigate('/payroll/structures/new')}>
            New structure
          </AppButton>
        ) : null}
      </header>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          Loading pay structures…
        </div>
      ) : structures.length === 0 ? (
        <div className="rounded-input-lg border border-dashed border-border-strong bg-surface px-4 py-10 text-center text-[13px] text-text-secondary">
          No pay structures yet. Create one from a template to put staff on payroll.
        </div>
      ) : (
        <>
          <SectionLabel>Structures</SectionLabel>
          <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
            <div
              className="grid items-center bg-surface-alt px-4 py-2.5"
              style={{ gridTemplateColumns: COLS }}
            >
              {['Structure', 'Status', 'Assigned staff', ''].map((heading, idx) => (
                <AppText
                  key={heading || idx}
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

            {structures.map((structure) => (
              <button
                key={structure.id}
                type="button"
                onClick={() => navigate(`/payroll/structures/${structure.id}`)}
                className="grid w-full items-center border-t border-border-divider bg-surface px-4 py-3 text-left transition hover:bg-surface-alt"
                style={{ gridTemplateColumns: COLS }}
              >
                <div className="min-w-0 pr-2">
                  <AppText as="div" weight="medium" className="truncate text-[13px]">
                    {structure.name}
                  </AppText>
                  {structure.description ? (
                    <AppText as="div" variant="micro" className="mt-0.5 truncate text-text-subtle">
                      {structure.description}
                    </AppText>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge
                    label={structure.isActive ? 'Active' : 'Inactive'}
                    tone={structure.isActive ? 'success' : 'neutral'}
                  />
                  {structure.isSystem ? <StatusBadge label="System" tone="neutral" /> : null}
                </div>
                <AppText as="div" weight="medium" className="text-[13px]">
                  {structure.assignedStaffCount}
                </AppText>
                <span className="justify-self-end text-[11px] font-medium text-primary">
                  View →
                </span>
              </button>
            ))}
          </AppCard>
        </>
      )}

      <div className="mt-8">
        <SectionLabel>Data capture</SectionLabel>
        <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
          <div className="border-b border-border-divider bg-surface-alt px-4 py-3">
            <AppText as="p" variant="caption" tone="muted">
              Which transaction sources payroll can trust. A source marked captured is treated as
              complete — missing data counts as zero instead of raising a warning.
            </AppText>
          </div>

          {sourcesError ? (
            <div className="border-b border-border-divider bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {sourcesError}
            </div>
          ) : null}

          {sourcesLoading ? (
            <div className="px-4 py-8 text-center text-[13px] text-text-secondary">
              Loading data sources…
            </div>
          ) : orderedSources.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-text-secondary">
              No data-source records yet — they are created with the payroll settings.
            </div>
          ) : (
            orderedSources.map((row) => {
              const isRetail = row.source === 'retail_sales';
              return (
                <div
                  key={row.source}
                  className="flex flex-col gap-3 border-t border-border-divider px-4 py-3 first:border-t-0 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <AppText as="div" weight="medium" className="text-[13px]">
                        {PAYROLL_DATA_SOURCE_LABELS[row.source]}
                      </AppText>
                      <AppText
                        as="div"
                        variant="caption"
                        tone={row.isCaptured ? 'success' : 'muted'}
                        weight="medium"
                      >
                        {row.isCaptured ? '✓ Captured' : '— Not captured'}
                      </AppText>
                    </div>
                    {row.notes ? (
                      <AppText as="div" variant="micro" tone="muted" className="mt-0.5">
                        {row.notes}
                      </AppText>
                    ) : null}
                  </div>

                  {canAuthor ? (
                    isRetail ? (
                      confirmingRetailCapture && !row.isCaptured ? (
                        <div className="flex flex-col gap-2 rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2.5 lg:max-w-md">
                          <AppText as="p" variant="caption">
                            Only enable this once the team records real retail sales here — enabling
                            it makes payroll treat missing retail as £0 instead of warning.
                          </AppText>
                          <div className="flex items-center gap-2">
                            <AppButton
                              size="sm"
                              onClick={() => void handleToggleRetailCapture(true)}
                              loading={togglingSource}
                            >
                              Mark as captured
                            </AppButton>
                            <AppButton
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmingRetailCapture(false)}
                              disabled={togglingSource}
                            >
                              Cancel
                            </AppButton>
                          </div>
                        </div>
                      ) : row.isCaptured ? (
                        <AppButton
                          size="sm"
                          variant="ghost"
                          onClick={() => void handleToggleRetailCapture(false)}
                          loading={togglingSource}
                        >
                          Mark as not captured
                        </AppButton>
                      ) : (
                        <AppButton
                          size="sm"
                          variant="secondary"
                          onClick={() => setConfirmingRetailCapture(true)}
                        >
                          Mark as captured
                        </AppButton>
                      )
                    ) : (
                      <AppButton
                        size="sm"
                        variant="ghost"
                        disabled
                        title="No capture path in the product yet"
                      >
                        {row.isCaptured ? 'Mark as not captured' : 'Mark as captured'}
                      </AppButton>
                    )
                  ) : null}
                </div>
              );
            })
          )}
        </AppCard>
      </div>
    </div>
  );
}
