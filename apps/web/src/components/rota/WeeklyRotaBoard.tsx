import type {
  RotaAbsenceIndicator,
  RotaLeaveIndicator,
  RotaShift,
  RotaStaffSummary,
} from '@sheer/domain';
import {
  addDays,
  dayLabel,
  dayMonth,
  formatTime,
  isSameLocalDay,
  toIsoDate,
} from './dateUtils';

interface WeeklyRotaBoardProps {
  weekStart: string;
  staff: RotaStaffSummary[];
  shifts: RotaShift[];
  leave: RotaLeaveIndicator[];
  absences: RotaAbsenceIndicator[];
  onCreateShift: (staffProfileId: string, dayIso: string) => void;
  onEditShift: (shift: RotaShift) => void;
  onMarkAbsence: (staffProfileId: string) => void;
  /** When true, the board is a read-only view (no create/edit/absence controls). */
  readOnly?: boolean;
}

/**
 * Manager-facing weekly rota grid.
 *
 * Layout: rows = stylists at the location, columns = the 7 days starting
 * Monday. Each cell renders the shifts for that stylist on that day,
 * along with leave / absence indicators when applicable. Cells are
 * click-to-create; existing shift chips are click-to-edit.
 */
export function WeeklyRotaBoard({
  weekStart,
  staff,
  shifts,
  leave,
  absences,
  onCreateShift,
  onEditShift,
  onMarkAbsence,
  readOnly = false,
}: WeeklyRotaBoardProps) {
  const start = new Date(`${weekStart}T00:00:00`);
  const days = Array.from({ length: 7 }, (_, idx) => addDays(start, idx));

  if (staff.length === 0) {
    return (
      <div className="rounded-card-lg border border-border bg-surface px-4 py-10 text-center">
        <div className="text-[14px] font-medium text-text-primary">
          No stylists at this location yet
        </div>
        <div className="mt-1 text-[13px] text-text-secondary">
          Invite a stylist from the Team page to start building the rota.
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card-lg border border-border bg-surface">
      <table className="w-full min-w-[920px] border-separate border-spacing-0 text-left text-[13px]">
        <thead>
          <tr className="bg-surface-alt">
            <th className="sticky left-0 z-10 w-44 border-b border-border bg-surface-alt px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
              Stylist
            </th>
            {days.map((day) => (
              <th
                key={day.toISOString()}
                className="border-b border-border px-2 py-2 text-center"
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
                  {dayLabel(day)}
                </div>
                <div className="text-[12px] font-medium text-text-primary">
                  {dayMonth(day)}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {staff.map((member) => (
            <tr key={member.staffProfileId}>
              <th
                scope="row"
                className="sticky left-0 z-10 align-top bg-surface px-3 py-2 text-left"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-semibold text-white"
                    style={{ backgroundColor: member.colorHex ?? '#D97863' }}
                  >
                    {initials(member.displayName)}
                  </span>
                  <div>
                    <div className="text-[13px] font-medium text-text-primary">
                      {member.displayName}
                    </div>
                    {readOnly ? null : (
                      <button
                        type="button"
                        className="text-[11px] text-text-secondary underline-offset-2 hover:underline"
                        onClick={() => onMarkAbsence(member.staffProfileId)}
                      >
                        Mark absence
                      </button>
                    )}
                  </div>
                </div>
              </th>
              {days.map((day) => {
                const dayIso = toIsoDate(day);
                const cellShifts = shifts.filter(
                  (s) =>
                    s.staffProfileId === member.staffProfileId &&
                    isSameLocalDay(s.scheduledStartAt, day),
                );
                const cellLeave = leave.filter(
                  (l) =>
                    l.staffProfileId === member.staffProfileId &&
                    overlapsDay(l.startDate, l.endDate, dayIso),
                );
                const cellAbsences = absences.filter(
                  (a) =>
                    a.staffProfileId === member.staffProfileId &&
                    isSameLocalDay(a.startsAt, day),
                );
                return (
                  <td
                    key={day.toISOString()}
                    className="border-l border-t border-border align-top"
                    style={{ minHeight: 96 }}
                  >
                    {readOnly ? (
                      <div className="block w-full px-2 py-2 text-left">
                        <div className="space-y-1">
                          {cellShifts.length === 0 &&
                          cellLeave.length === 0 &&
                          cellAbsences.length === 0 ? (
                            <span className="text-[11px] text-text-muted">—</span>
                          ) : null}
                          {cellShifts.map((shift) => (
                            <ShiftChip key={shift.id} shift={shift} />
                          ))}
                          {cellLeave.map((l) => (
                            <LeaveChip key={l.id} leave={l} />
                          ))}
                          {cellAbsences.map((a) => (
                            <AbsenceChip key={a.id} absence={a} />
                          ))}
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="block w-full px-2 py-2 text-left transition hover:bg-surface-alt"
                        onClick={() => onCreateShift(member.staffProfileId, dayIso)}
                      >
                        <div className="space-y-1">
                          {cellShifts.length === 0 &&
                          cellLeave.length === 0 &&
                          cellAbsences.length === 0 ? (
                            <span className="text-[11px] text-text-muted">+ Add shift</span>
                          ) : null}
                          {cellShifts.map((shift) => (
                            <ShiftChip
                              key={shift.id}
                              shift={shift}
                              onEdit={(event) => {
                                event.stopPropagation();
                                onEditShift(shift);
                              }}
                            />
                          ))}
                          {cellLeave.map((l) => (
                            <LeaveChip key={l.id} leave={l} />
                          ))}
                          {cellAbsences.map((a) => (
                            <AbsenceChip key={a.id} absence={a} />
                          ))}
                        </div>
                      </button>
                    )}
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

function ShiftChip({ shift, onEdit }: { shift: RotaShift; onEdit?: (event: React.MouseEvent) => void }) {
  const tone = statusTone(shift.status);
  if (!onEdit) {
    return (
      <div className={`rounded-input-lg border px-2 py-1 text-[11px] leading-tight ${tone}`}>
        <div className="font-medium">
          {formatTime(shift.scheduledStartAt)}–{formatTime(shift.scheduledEndAt)}
        </div>
        <div className="text-[10px] uppercase tracking-[0.06em] opacity-80">
          {shift.breaks.length > 0
            ? `${shift.breaks.length} break${shift.breaks.length === 1 ? '' : 's'}`
            : 'No breaks'}
        </div>
      </div>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit(event as unknown as React.MouseEvent);
        }
      }}
      className={`rounded-input-lg border px-2 py-1 text-[11px] leading-tight transition hover:brightness-95 ${tone}`}
    >
      <div className="font-medium">
        {formatTime(shift.scheduledStartAt)}–{formatTime(shift.scheduledEndAt)}
      </div>
      <div className="text-[10px] uppercase tracking-[0.06em] opacity-80">
        {shift.breaks.length > 0
          ? `${shift.breaks.length} break${shift.breaks.length === 1 ? '' : 's'}`
          : 'No breaks'}
      </div>
    </div>
  );
}

function LeaveChip({ leave }: { leave: RotaLeaveIndicator }) {
  return (
    <div className="rounded-input-lg border border-warning-border bg-warning-soft px-2 py-1 text-[11px] text-warning">
      <div className="font-medium">Leave: {leave.status}</div>
    </div>
  );
}

function AbsenceChip({ absence }: { absence: RotaAbsenceIndicator }) {
  return (
    <div className="rounded-input-lg border border-danger-border bg-danger-soft px-2 py-1 text-[11px] text-danger">
      <div className="font-medium">Absence: {absence.absenceType}</div>
    </div>
  );
}

// V2: if draft/published workflow returns, prefer modelling it at rota-week
// creation/publish level rather than as a per-shift V1 modal control.
function statusTone(status: RotaShift['status']): string {
  switch (status) {
    case 'published':
      return 'border-success-border bg-success-soft text-success';
    case 'completed':
      return 'border-border-strong bg-surface-alt text-text-secondary';
    case 'cancelled':
      return 'border-danger-border bg-danger-soft text-danger';
    case 'draft':
    default:
      return 'border-primary/30 bg-primary-soft text-primary-deep';
  }
}

function initials(value: string): string {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '·'
  );
}

function overlapsDay(startDate: string, endDate: string, dayIso: string): boolean {
  return startDate <= dayIso && dayIso <= endDate;
}
