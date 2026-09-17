import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiRequestError, createNewWeek, getWeeklyRota, previewNewWeek } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import { AppButton, AppCard, AppText, StatusBadge } from '../design';
import { ShiftEditorModal } from '../components/rota/ShiftEditorModal';
import {
  addDays,
  dayLabel,
  dayMonth,
  formatTime,
  isSameLocalDay,
  snapToMonday,
  toIsoDate,
} from '../components/rota/dateUtils';
import type {
  PreviewNewWeekResponse,
  RotaCreationMode,
  RotaShift,
  RotaStaffSummary,
  WeeklyRotaResponse,
} from '@sheer/domain';

const CREATION_MODE_LABEL: Record<RotaCreationMode, string> = {
  blank: 'Blank week',
  clone_last_week: 'Clone last week',
  generate_from_defaults: 'Generate from defaults',
};

interface ShiftEditorState {
  open: boolean;
  shift?: RotaShift;
  staffProfileId?: string;
  date?: string;
}

export function NewWeekRotaPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const accessToken = auth.session?.accessToken ?? '';

  const [weekStart, setWeekStart] = useState(() => toIsoDate(snapToMonday(addDays(new Date(), 7))));
  const [creationMode, setCreationMode] = useState<RotaCreationMode>('clone_last_week');
  const [workspacePlan, setWorkspacePlan] = useState<PreviewNewWeekResponse | null>(null);
  const [targetWeek, setTargetWeek] = useState<WeeklyRotaResponse | null>(null);
  const [draftShifts, setDraftShifts] = useState<RotaShift[]>([]);
  const [loading, setLoading] = useState(false);
  const [rotaLoading, setRotaLoading] = useState(true);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [shiftEditor, setShiftEditor] = useState<ShiftEditorState>({ open: false });

  const role = auth.user?.primaryRole;

  // The week is built for the location in the shared sidebar scope — owners
  // across the business, managers across the locations they're assigned to. The
  // in-page picker below writes back to the same scope so the two never drift.
  const { locations, resolvedLocationId, setSelectedLocationId } = useLocationScope();

  const effectiveLocationId = resolvedLocationId || null;
  const locationName =
    locations.find((loc) => loc.id === effectiveLocationId)?.name ?? 'Current location';

  // Switching salons must never carry the previous location's draft into the
  // new one. Both loaders re-run off `effectiveLocationId`, but drop the stale
  // workspace immediately rather than rendering it until they land.
  const previousLocationId = useRef(effectiveLocationId);
  useEffect(() => {
    if (previousLocationId.current === effectiveLocationId) return;
    previousLocationId.current = effectiveLocationId;
    setWorkspacePlan(null);
    setDraftShifts([]);
    setActionMessage(null);
  }, [effectiveLocationId]);

  const weekDates = useMemo(() => {
    const start = new Date(`${weekStart}T00:00:00`);
    return Array.from({ length: 7 }, (_, idx) => addDays(start, idx));
  }, [weekStart]);

  const weekLabel = useMemo(() => {
    const start = weekDates[0];
    const end = weekDates[6];
    if (!start || !end) return weekStart;
    return `${start.getDate()} ${start.toLocaleDateString(undefined, { month: 'short' })} - ${end.getDate()} ${end.toLocaleDateString(undefined, { month: 'short' })} ${end.getFullYear()}`;
  }, [weekDates, weekStart]);

  const loadTargetWeek = useCallback(async () => {
    if (!accessToken || !effectiveLocationId) return;
    setRotaLoading(true);
    try {
      const result = await getWeeklyRota(accessToken, {
        locationId: effectiveLocationId,
        weekStart,
      });
      setTargetWeek(result);
    } catch (err) {
      setTargetWeek(null);
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load the target week');
    } finally {
      setRotaLoading(false);
    }
  }, [accessToken, effectiveLocationId, weekStart]);

  useEffect(() => {
    void loadTargetWeek();
  }, [loadTargetWeek]);

  const initialiseWorkspace = useCallback(async () => {
    if (!accessToken || !effectiveLocationId || rotaLoading) return;
    setWorkspaceLoading(true);
    setError(null);
    setActionMessage(null);
    try {
      if (creationMode === 'blank') {
        const warnings = buildTargetWeekWarnings(targetWeek?.shifts.length ?? 0);
        setWorkspacePlan({
          weekStart,
          creationMode,
          staffCount: targetWeek?.staff.length ?? 0,
          shiftsToCreate: 0,
          breaksToCreate: 0,
          warnings,
          draftShifts: [],
        });
        setDraftShifts([]);
        return;
      }

      if (creationMode === 'generate_from_defaults') {
        const generated = buildDefaultDraftShifts(targetWeek?.staff ?? [], weekDates, effectiveLocationId);
        setWorkspacePlan({
          weekStart,
          creationMode,
          staffCount: targetWeek?.staff.length ?? 0,
          shiftsToCreate: generated.length,
          breaksToCreate: generated.reduce((total, shift) => total + shift.breaks.length, 0),
          warnings: [
            ...buildTargetWeekWarnings(targetWeek?.shifts.length ?? 0),
            'Generate from defaults is using the basic Mon-Fri 9-5 scaffold.',
          ],
          draftShifts: generated,
        });
        setDraftShifts(generated);
        return;
      }

      const res = await previewNewWeek(accessToken, {
        weekStart,
        creationMode,
        locationId: effectiveLocationId,
      });
      setWorkspacePlan(res);
      setDraftShifts(res.draftShifts ?? []);
    } catch (err) {
      setWorkspacePlan(null);
      setDraftShifts([]);
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not prepare new week workspace');
    } finally {
      setWorkspaceLoading(false);
    }
  }, [
    accessToken,
    creationMode,
    effectiveLocationId,
    rotaLoading,
    targetWeek?.shifts.length,
    targetWeek?.staff,
    weekDates,
    weekStart,
  ]);

  useEffect(() => {
    void initialiseWorkspace();
  }, [initialiseWorkspace]);

  if (auth.status === 'authenticated' && role !== 'owner' && role !== 'manager') {
    return <Navigate to="/unauthorized" replace />;
  }

  if (locations.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 text-center text-[13px] text-text-secondary">
        {role === 'owner'
          ? 'No locations found for your business yet. Create a location before building a rota week.'
          : 'Your account is not assigned to a location yet.'}
      </div>
    );
  }

  function handleWeekStartChange(value: string) {
    if (!value) return;
    const monday = snapToMonday(new Date(`${value}T00:00:00`));
    setWeekStart(toIsoDate(monday));
    setWorkspacePlan(null);
    setDraftShifts([]);
    setActionMessage(null);
  }

  function selectNextWeek() {
    setWeekStart(toIsoDate(snapToMonday(addDays(new Date(), 7))));
    setWorkspacePlan(null);
    setDraftShifts([]);
    setActionMessage(null);
  }

  async function handleConfirm() {
    if (!accessToken || workspaceLoading) return;
    setLoading(true);
    setError(null);
    try {
      await createNewWeek(accessToken, {
        weekStart,
        creationMode,
        locationId: effectiveLocationId ?? undefined,
        shifts: draftShifts.map(toNewWeekDraftShift),
      });
      navigate(`/rota?weekStart=${weekStart}`);
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not create new week');
    } finally {
      setLoading(false);
    }
  }

  function handleShiftSaved(shift: RotaShift) {
    setDraftShifts((current) => upsertShift(current, shift));
    setWorkspacePlan((current) => recalculatePlan(current, upsertShift(draftShifts, shift)));
    setActionMessage('Draft shift saved.');
  }

  function handleShiftDeleted(shiftId: string) {
    const nextDraft = draftShifts.filter((shift) => shift.id !== shiftId);
    setDraftShifts(nextDraft);
    setWorkspacePlan((current) => recalculatePlan(current, nextDraft));
    setActionMessage('Draft shift deleted.');
  }

  function handleCreationModeChange(mode: RotaCreationMode) {
    setCreationMode(mode);
    setWorkspacePlan(null);
    setDraftShifts([]);
    setActionMessage(null);
  }

  const workspaceShifts = draftShifts;
  const draftBreakCount = draftShifts.reduce((total, shift) => total + shift.breaks.length, 0);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 lg:px-8">
      <header className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <AppText as="h1" variant="display" weight="medium">
            Create New Week Rota
          </AppText>
          <AppText as="p" variant="body" tone="secondary" className="mt-1">
            Set up a new rota week for {locationName}. Edit the timetable here, then create it
            when the schedule is ready.
          </AppText>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AppButton variant="secondary" size="sm" onClick={() => navigate('/rota')} disabled={loading}>
            Cancel
          </AppButton>
          <AppButton
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            loading={loading}
            disabled={workspaceLoading}
          >
            Create Week
          </AppButton>
        </div>
      </header>

      {actionMessage ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-2 text-[13px] text-success">
          {actionMessage}
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-2 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      <AppCard padding="sm" elevation="none" className="mb-4 rounded-card-lg border-border-strong">
        <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-end">
          <label>
            <AppText as="span" variant="micro" tone="secondary" uppercase>
              Week
            </AppText>
          <input
            type="date"
            value={weekStart}
            onChange={(event) => handleWeekStartChange(event.target.value)}
              className="mt-1 h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          </label>
          <label>
            <AppText as="span" variant="micro" tone="secondary" uppercase>
              Location / Team
            </AppText>
          <select
            value={effectiveLocationId ?? ''}
            onChange={(event) => setSelectedLocationId(event.target.value)}
            disabled={locations.length < 2}
              className="mt-1 h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-70"
          >
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
          </label>
          <label>
            <AppText as="span" variant="micro" tone="secondary" uppercase>
              Creation Mode
            </AppText>
          <select
            value={creationMode}
            onChange={(event) => {
              handleCreationModeChange(event.target.value as RotaCreationMode);
            }}
              className="mt-1 h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="blank">Blank Week</option>
              <option value="clone_last_week">Clone last week</option>
            <option value="generate_from_defaults">Generate from defaults</option>
          </select>
          </label>
          <div className="flex gap-2 lg:justify-end">
            <AppButton variant="ghost" size="sm" onClick={selectNextWeek}>
              Next week
            </AppButton>
          </div>
        </div>
      </AppCard>

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_300px]">
        <aside className="space-y-4">
          <AppCard padding="md" elevation="none" className="rounded-card-lg">
            <AppText as="h2" variant="body" weight="medium">
              Creation Options
            </AppText>
            <div className="mt-3 space-y-2">
              {(['blank', 'clone_last_week', 'generate_from_defaults'] as RotaCreationMode[]).map(
                (mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      handleCreationModeChange(mode);
                    }}
                    className={`w-full rounded-input-lg border px-3 py-2 text-left transition ${
                      creationMode === mode
                        ? 'border-primary bg-primary-soft'
                        : 'border-border bg-surface hover:bg-surface-alt'
                    }`}
                  >
                    <AppText as="div" variant="caption" weight="medium">
                      {CREATION_MODE_LABEL[mode]}
                    </AppText>
                    <AppText as="div" variant="micro" tone="secondary" className="mt-0.5">
                      {creationModeHint(mode)}
                    </AppText>
                  </button>
                ),
              )}
            </div>
          </AppCard>

          <AppCard padding="md" elevation="none" className="rounded-card-lg">
            <AppText as="h2" variant="body" weight="medium">
              Workflow
            </AppText>
            <ol className="mt-3 space-y-3 text-[12px] text-text-secondary">
              <li className="flex gap-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-alt text-[11px] text-text-primary">
                  1
                </span>
                Choose the week, location, and creation mode.
              </li>
              <li className="flex gap-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-alt text-[11px] text-text-primary">
                  2
                </span>
                Edit the timetable directly in this workspace.
              </li>
              <li className="flex gap-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface-alt text-[11px] text-text-primary">
                  3
                </span>
                Create the week to persist the current timetable.
              </li>
            </ol>
          </AppCard>
        </aside>

        <section className="overflow-hidden rounded-card-lg border border-border bg-surface shadow-card">
          <div className="flex flex-col gap-2 border-b border-border bg-surface-alt px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <AppText as="h2" variant="body" weight="medium">
                Week Workspace
              </AppText>
              <AppText as="div" variant="caption" tone="secondary" className="mt-0.5">
                {weekLabel} · {CREATION_MODE_LABEL[creationMode]}
              </AppText>
            </div>
            <StatusBadge
              label={workspaceLoading ? 'Loading schedule' : 'Editable workspace'}
              tone={workspaceLoading ? 'neutral' : 'success'}
            />
          </div>
          {rotaLoading || workspaceLoading ? (
            <EmptyWorkspace message="Loading the creation workspace..." />
          ) : targetWeek?.staff.length ? (
            <WeekPreviewGrid
              staff={targetWeek.staff}
              shifts={workspaceShifts}
              weekDates={weekDates}
              onCreateShift={(staffProfileId, dayIso) =>
                setShiftEditor({ open: true, staffProfileId, date: dayIso })
              }
              onEditShift={(shift) => setShiftEditor({ open: true, shift })}
            />
          ) : (
            <EmptyWorkspace message="No staff are assigned to this location yet. Add staff before creating a weekly rota." />
          )}
        </section>

        <aside className="space-y-3">
          <AppCard padding="md" elevation="none" className="rounded-card-lg">
            <AppText as="h2" variant="body" weight="medium">
              Creation Summary
            </AppText>
            <AppText as="div" variant="caption" tone="secondary" className="mt-1">
              {weekLabel}
            </AppText>
            <dl className="mt-3 space-y-2 text-[13px]">
              <div className="flex items-center justify-between">
                <dt className="text-text-secondary">Staff affected</dt>
                <dd className="font-semibold text-text-primary">{workspacePlan?.staffCount ?? targetWeek?.staff.length ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-text-secondary">Draft shifts</dt>
                <dd className="font-semibold text-text-primary">{draftShifts.length}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-text-secondary">Draft breaks</dt>
                <dd className="font-semibold text-text-primary">{draftBreakCount}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-text-secondary">Existing target shifts</dt>
                <dd className="font-semibold text-text-primary">{targetWeek?.shifts.length ?? '—'}</dd>
              </div>
            </dl>
          </AppCard>

          <AppCard padding="md" elevation="none" className="rounded-card-lg">
            <div className="mb-2 flex items-center justify-between">
              <AppText as="h2" variant="body" weight="medium">
                Warnings
              </AppText>
              <StatusBadge
                label={`${workspacePlan?.warnings.length ?? 0}`}
                tone={workspacePlan?.warnings.length ? 'warning' : 'neutral'}
              />
            </div>
            <ul className="space-y-2 text-[12px] text-text-secondary">
              {workspacePlan?.warnings.length ? (
                workspacePlan.warnings.slice(0, 4).map((warning) => (
                  <li
                    key={warning}
                    className="rounded-input-lg border border-warning-border bg-warning-soft px-2 py-1 text-warning"
                  >
                    {warning}
                  </li>
                ))
              ) : (
                <li>No warnings for this workspace.</li>
              )}
            </ul>
          </AppCard>

          <AppCard padding="md" elevation="none" className="rounded-card-lg">
            <AppText as="h2" variant="body" weight="medium">
              Next Step
            </AppText>
            <AppText as="p" variant="caption" tone="secondary" className="mt-2">
              Creating the week writes the current timetable and then opens the live rota for
              review.
            </AppText>
          </AppCard>
        </aside>
      </div>

      {targetWeek && effectiveLocationId ? (
        <ShiftEditorModal
          open={shiftEditor.open}
          accessToken={accessToken}
          locationId={effectiveLocationId}
          staff={targetWeek.staff}
          shift={shiftEditor.shift}
          initialStaffProfileId={shiftEditor.staffProfileId}
          initialDate={shiftEditor.date}
          onClose={() => setShiftEditor({ open: false })}
          onSaved={handleShiftSaved}
          onDeleted={handleShiftDeleted}
          draftMode={Boolean(draftShifts)}
        />
      ) : null}
    </div>
  );
}

function creationModeHint(mode: RotaCreationMode): string {
  switch (mode) {
    case 'blank':
      return 'Start with staff rows only and add shifts manually.';
    case 'generate_from_defaults':
      return 'Use the basic Mon-Fri default schedule as an editable starting point.';
    case 'clone_last_week':
    default:
      return 'Load last week into this workspace without saving it yet.';
  }
}

function EmptyWorkspace({ message }: { message: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <AppText as="div" variant="body" weight="medium">
        No generated rows to show
      </AppText>
      <AppText as="p" variant="caption" tone="secondary" className="mx-auto mt-1 max-w-md">
        {message}
      </AppText>
    </div>
  );
}

function WeekPreviewGrid({
  staff,
  shifts,
  weekDates,
  onCreateShift,
  onEditShift,
}: {
  staff: RotaStaffSummary[];
  shifts: RotaShift[];
  weekDates: Date[];
  onCreateShift: (staffProfileId: string, dayIso: string) => void;
  onEditShift: (shift: RotaShift) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] border-separate border-spacing-0 text-left text-[13px]">
        <thead>
          <tr className="bg-surface">
            <th className="sticky left-0 z-10 w-52 border-b border-border bg-surface px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Staff
            </th>
            {weekDates.map((day) => (
              <th key={day.toISOString()} className="border-b border-border px-2 py-2 text-center">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  {dayLabel(day)}
                </div>
                <div className="text-[12px] font-medium text-text-primary">{dayMonth(day)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {staff.map((member) => (
            <tr key={member.staffProfileId}>
              <th className="sticky left-0 z-10 border-b border-border bg-surface px-3 py-2 text-left align-top">
                <div className="flex items-center gap-2">
                  <span
                    className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold text-white"
                    style={{ backgroundColor: member.colorHex ?? '#A67CF5' }}
                  >
                    {initials(member.displayName)}
                  </span>
                  <div>
                    <div className="text-[13px] font-medium text-text-primary">{member.displayName}</div>
                    <div className="text-[11px] text-text-secondary">
                      {member.isBookable ? 'Bookable' : 'Not bookable'}
                    </div>
                  </div>
                </div>
              </th>
              {weekDates.map((day) => {
                const cellShifts = shifts.filter(
                  (shift) =>
                    shift.staffProfileId === member.staffProfileId &&
                    isSameLocalDay(shift.scheduledStartAt, day),
                );

                return (
                  <td key={day.toISOString()} className="border-b border-l border-border align-top">
                    <button
                      type="button"
                      className="block h-full min-h-16 w-full px-2 py-2 text-left transition hover:bg-surface-alt"
                      onClick={() => onCreateShift(member.staffProfileId, toIsoDate(day))}
                    >
                      {cellShifts.length ? (
                        <div className="space-y-1">
                          {cellShifts.map((shift) => (
                            <div
                              key={shift.id}
                              role="button"
                              tabIndex={0}
                              className="rounded-input-lg border border-border bg-surface-alt px-2 py-1 text-[11px] text-text-secondary transition hover:brightness-95"
                              onClick={(event) => {
                                event.stopPropagation();
                                onEditShift(shift);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onEditShift(shift);
                                }
                              }}
                            >
                              <div className="font-medium text-text-primary">
                                {formatTime(shift.scheduledStartAt)}-{formatTime(shift.scheduledEndAt)}
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.06em] opacity-80">
                                {shift.breaks.length > 0
                                  ? `${shift.breaks.length} break${shift.breaks.length === 1 ? '' : 's'}`
                                  : 'No breaks'}
                              </div>
                          </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[11px] text-text-muted">+ Add shift</span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function upsertShift(current: RotaShift[], shift: RotaShift): RotaShift[] {
  const existingIndex = current.findIndex((item) => item.id === shift.id);
  if (existingIndex === -1) return [...current, shift];
  return current.map((item) => (item.id === shift.id ? shift : item));
}

function recalculatePlan(
  current: PreviewNewWeekResponse | null,
  shifts: RotaShift[],
): PreviewNewWeekResponse | null {
  if (!current) return current;
  return {
    ...current,
    shiftsToCreate: shifts.length,
    breaksToCreate: shifts.reduce((total, shift) => total + shift.breaks.length, 0),
    draftShifts: shifts,
  };
}

function buildTargetWeekWarnings(existingShiftCount: number): string[] {
  return existingShiftCount > 0
    ? ['This week already has shifts. Creating a new week will be blocked until those shifts are removed.']
    : [];
}

function buildDefaultDraftShifts(
  staff: RotaStaffSummary[],
  weekDates: Date[],
  locationId: string,
): RotaShift[] {
  return staff
    .filter((member) => member.isBookable)
    .flatMap((member) =>
      weekDates.slice(0, 5).map((day) => {
        const shiftId = `draft:${crypto.randomUUID()}`;
        const start = new Date(day);
        start.setHours(9, 0, 0, 0);
        const end = new Date(day);
        end.setHours(17, 0, 0, 0);
        const breakStart = new Date(day);
        breakStart.setHours(12, 0, 0, 0);
        const breakEnd = new Date(breakStart.getTime() + member.defaultBreakMinutes * 60_000);
        return {
          id: shiftId,
          businessId: '',
          locationId,
          staffProfileId: member.staffProfileId,
          status: 'published',
          scheduledStartAt: start.toISOString(),
          scheduledEndAt: end.toISOString(),
          notes: undefined,
          breaks:
            member.defaultBreakMinutes > 0
              ? [
                  {
                    id: `draft-break:${crypto.randomUUID()}`,
                    shiftId,
                    startedAt: breakStart.toISOString(),
                    endedAt: breakEnd.toISOString(),
                    isPaid: member.defaultBreakIsPaid,
                    notes: member.defaultBreakNotes,
                  },
                ]
              : [],
        } satisfies RotaShift;
      }),
    );
}

function toNewWeekDraftShift(shift: RotaShift) {
  return {
    staffProfileId: shift.staffProfileId,
    scheduledStartAt: shift.scheduledStartAt,
    scheduledEndAt: shift.scheduledEndAt,
    notes: shift.notes,
    breaks: shift.breaks.map((breakItem) => ({
      startedAt: breakItem.startedAt,
      endedAt: breakItem.endedAt,
      isPaid: breakItem.isPaid,
      notes: breakItem.notes,
    })),
  };
}

function initials(value: string): string {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '·'
  );
}
