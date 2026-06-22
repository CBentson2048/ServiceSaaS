import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  RotaAbsenceIndicator,
  RotaShift,
  WeeklyRotaResponse,
} from '@sheer/domain';
import { ApiRequestError, getWeeklyRota } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import { AppButton } from '../design';
import { LeaveRequestsPanel } from '../components/rota/LeaveRequestsPanel';
import { MarkAbsenceModal } from '../components/rota/MarkAbsenceModal';
import { ShiftEditorModal } from '../components/rota/ShiftEditorModal';
import { WeeklyRotaBoard } from '../components/rota/WeeklyRotaBoard';
import {
  addDays,
  dateInputValue,
  snapToMonday,
  toIsoDate,
} from '../components/rota/dateUtils';

interface ShiftEditorState {
  open: boolean;
  shift?: RotaShift;
  staffProfileId?: string;
  date?: string;
}

interface AbsenceModalState {
  open: boolean;
  staffProfileId?: string;
}

/**
 * Rota management page for owners and managers. Managers are scoped to their
 * single assigned location; owners get a location switcher and full access to
 * every location in their business (the backend already authorises owners for
 * all rota operations).
 */
export function RotaPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accessToken = auth.session?.accessToken ?? '';

  const [weekStart, setWeekStart] = useState(() => {
    const param = searchParams.get('weekStart');
    if (param) {
      const date = new Date(`${param}T00:00:00`);
      if (!Number.isNaN(date.getTime())) {
        return toIsoDate(snapToMonday(date));
      }
    }
    return toIsoDate(snapToMonday(new Date()));
  });
  const [data, setData] = useState<WeeklyRotaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [shiftEditor, setShiftEditor] = useState<ShiftEditorState>({ open: false });
  const [absenceModal, setAbsenceModal] = useState<AbsenceModalState>({ open: false });

  const role = auth.user?.primaryRole;
  const locations = useMemo(() => auth.user?.locations ?? [], [auth.user?.locations]);
  const managerLocationId =
    role === 'manager' ? auth.user?.allowedLocationIds[0] ?? null : null;

  // Owners pick a location from the shared sidebar scope. The weekly rota board
  // is single-location, so "All" resolves to the first location. Managers are
  // scoped to their single assigned location regardless of the picker.
  const { resolvedLocationId } = useLocationScope();

  // The location whose rota we load: owner's selected one, or the manager's assigned one.
  const requestLocationId = role === 'owner' ? resolvedLocationId || null : managerLocationId;
  const targetLocationId = requestLocationId ?? data?.locationId ?? null;

  const reload = useCallback(async (options: { background?: boolean } = {}) => {
    if (!accessToken) return;
    // Owners must have a location selected before the rota can load.
    if (role === 'owner' && !requestLocationId) {
      setData(null);
      setLoading(false);
      return;
    }
    if (!options.background) setLoading(true);
    setError(null);
    try {
      const result = await getWeeklyRota(accessToken, {
        locationId: requestLocationId ?? undefined,
        weekStart,
      });
      setData(result);
    } catch (err) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load rota');
    } finally {
      if (!options.background) setLoading(false);
    }
  }, [accessToken, role, requestLocationId, weekStart]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const locationName = useMemo(() => {
    if (!data) return '';
    const match = auth.user?.locations.find((loc) => loc.id === data.locationId);
    return match?.name ?? 'Your location';
  }, [auth.user?.locations, data]);

  if (auth.status === 'authenticated' && role !== 'owner' && role !== 'manager') {
    return <Navigate to="/unauthorized" replace />;
  }

  if (role === 'owner' && locations.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 text-center text-[13px] text-text-secondary">
        No locations found for your business yet. Create a location before managing the rota.
      </div>
    );
  }

  if (role === 'manager' && !managerLocationId) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 text-center text-[13px] text-text-secondary">
        Your account is not assigned to a location yet. Ask your business owner to assign
        you to one before managing the rota.
      </div>
    );
  }

  function shiftWeek(deltaDays: number) {
    const next = addDays(new Date(`${weekStart}T00:00:00`), deltaDays);
    setWeekStart(toIsoDate(next));
  }

  function handleWeekStartChange(value: string) {
    if (!value) return;
    const monday = snapToMonday(new Date(`${value}T00:00:00`));
    setWeekStart(toIsoDate(monday));
  }

  function handleShiftSaved(shift: RotaShift) {
    setData((current) => {
      if (!current) return current;
      const idx = current.shifts.findIndex((s) => s.id === shift.id);
      const shifts = idx === -1 ? [...current.shifts, shift] : current.shifts.map((s) => (s.id === shift.id ? shift : s));
      return { ...current, shifts };
    });
    setShiftEditor((current) =>
      current.shift?.id === shift.id ? { ...current, shift } : current,
    );
    setActionMessage('Shift saved.');
    void reload({ background: true });
  }

  function handleShiftDeleted(shiftId: string) {
    setData((current) => {
      if (!current) return current;
      return { ...current, shifts: current.shifts.filter((s) => s.id !== shiftId) };
    });
    setShiftEditor((current) =>
      current.shift?.id === shiftId ? { open: false } : current,
    );
    setActionMessage('Shift deleted.');
    void reload({ background: true });
  }

  function handleAbsenceMarked(absence: RotaAbsenceIndicator) {
    setData((current) => {
      if (!current) return current;
      return { ...current, absences: [absence, ...current.absences] };
    });
    setActionMessage('Absence recorded.');
    void reload({ background: true });
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-8">
      <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Rota</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Manage shifts, breaks, leave, and absences for {locationName}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AppButton
            variant="secondary"
            size="sm"
            onClick={() => shiftWeek(-7)}
            disabled={loading}
          >
            ← Prev week
          </AppButton>
          <input
            type="date"
            value={weekStart}
            onChange={(event) => handleWeekStartChange(event.target.value)}
            className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <AppButton
            variant="secondary"
            size="sm"
            onClick={() => setWeekStart(toIsoDate(snapToMonday(new Date())))}
            disabled={loading}
          >
            This week
          </AppButton>
          <AppButton variant="secondary" size="sm" onClick={() => shiftWeek(7)} disabled={loading}>
            Next week →
          </AppButton>
          <AppButton
            variant="primary"
            size="sm"
            onClick={() => navigate('/rota/new-week')}
            disabled={loading}
          >
            Create New Week
          </AppButton>
          <AppButton
            variant="secondary"
            size="sm"
            onClick={() =>
              setShiftEditor({
                open: true,
                date: dateInputValue(new Date(`${weekStart}T00:00:00`)),
              })
            }
            disabled={!data || (data.staff.length === 0)}
          >
            New shift
          </AppButton>
          <AppButton
            variant="secondary"
            size="sm"
            onClick={() => setAbsenceModal({ open: true })}
            disabled={!data || data.staff.length === 0}
          >
            Mark absence
          </AppButton>
        </div>
      </header>

      {actionMessage ? (
        <div className="mb-3 rounded-input-lg border border-success-border bg-success-soft px-4 py-2 text-[13px] text-success">
          {actionMessage}
        </div>
      ) : null}

      {error ? (
        <div className="mb-3 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-2 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {loading || !data ? (
        <div className="rounded-card-lg border border-border bg-surface px-4 py-10 text-center text-[13px] text-text-secondary">
          Loading rota…
        </div>
      ) : (
        <>
          <WeeklyRotaBoard
            weekStart={data.weekStart}
            staff={data.staff}
            shifts={data.shifts}
            leave={data.leave}
            absences={data.absences}
            onCreateShift={(staffProfileId, dayIso) =>
              setShiftEditor({ open: true, staffProfileId, date: dayIso })
            }
            onEditShift={(shift) => setShiftEditor({ open: true, shift })}
            onMarkAbsence={(staffProfileId) =>
              setAbsenceModal({ open: true, staffProfileId })
            }
          />

          <div className="mt-6">
            {targetLocationId ? (
              <LeaveRequestsPanel
                accessToken={accessToken}
                locationId={targetLocationId}
              />
            ) : null}
          </div>
        </>
      )}

      {data && targetLocationId ? (
        <ShiftEditorModal
          open={shiftEditor.open}
          accessToken={accessToken}
          locationId={targetLocationId}
          staff={data.staff}
          shift={shiftEditor.shift}
          initialStaffProfileId={shiftEditor.staffProfileId}
          initialDate={shiftEditor.date}
          onClose={() => setShiftEditor({ open: false })}
          onSaved={handleShiftSaved}
          onDeleted={handleShiftDeleted}
        />
      ) : null}

      {data && targetLocationId ? (
        <MarkAbsenceModal
          open={absenceModal.open}
          accessToken={accessToken}
          locationId={targetLocationId}
          staff={data.staff}
          initialStaffProfileId={absenceModal.staffProfileId}
          onClose={() => setAbsenceModal({ open: false })}
          onMarked={handleAbsenceMarked}
        />
      ) : null}
    </div>
  );
}
