import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { RotaLeaveRequest, RotaShift, StylistMyWeekResponse } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';

export default function RotaScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const [weekStart, setWeekStart] = useState(() => toIsoDate(snapToMonday(new Date())));
  const [week, setWeek] = useState<StylistMyWeekResponse | null>(null);
  const [leaveRequests, setLeaveRequests] = useState<RotaLeaveRequest[]>([]);
  const [holidayNoticeDays, setHolidayNoticeDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingRequestId, setCancellingRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [leaveReason, setLeaveReason] = useState('');

  const weekDays = useMemo(() => {
    const start = new Date(`${weekStart}T00:00:00`);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [weekStart]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [weekResult, leaveResult] = await Promise.all([
        api.getMyWeek(accessToken, weekStart),
        api.getMyLeaveRequests(accessToken),
      ]);
      setWeek(weekResult);
      setLeaveRequests(leaveResult.leaveRequests);
      setHolidayNoticeDays(leaveResult.holidayNoticeDays);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load rota');
    } finally {
      setLoading(false);
    }
  }, [accessToken, weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitLeaveRequest() {
    if (!accessToken) return;
    if (!isIsoDate(leaveStart) || !isIsoDate(leaveEnd)) {
      setError('Use YYYY-MM-DD for leave dates.');
      return;
    }
    if (leaveEnd < leaveStart) {
      setError('End date must be on or after start date.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.createMyLeaveRequest(accessToken, {
        startDate: leaveStart,
        endDate: leaveEnd,
        reason: leaveReason.trim() || undefined,
      });
      setLeaveRequests((current) => [result.leaveRequest, ...current]);
      setLeaveStart('');
      setLeaveEnd('');
      setLeaveReason('');
      setMessage('Leave request submitted for manager review.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit leave request');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelLeaveRequest(requestId: string) {
    if (!accessToken || cancellingRequestId) return;
    setCancellingRequestId(requestId);
    setError(null);
    setMessage(null);
    try {
      const result = await api.cancelMyLeaveRequest(accessToken, requestId);
      setLeaveRequests((current) =>
        current.map((request) =>
          request.id === result.leaveRequest.id ? result.leaveRequest : request,
        ),
      );
      setMessage('Pending leave request cancelled.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel leave request');
    } finally {
      setCancellingRequestId(null);
    }
  }

  function shiftWeek(days: number) {
    setWeekStart(toIsoDate(addDays(new Date(`${weekStart}T00:00:00`), days)));
  }

  return (
    <ProtectedScreen allowedRoles={['stylist']}>
      <Screen>
        <SectionHeader
          title="My Week"
          subtitle="Your own shifts, breaks, leave, and absence markers."
        />

        <View style={styles.weekNav}>
          <AppButton label="Previous" variant="secondary" onPress={() => shiftWeek(-7)} />
          <Text style={styles.weekLabel}>{formatWeekLabel(weekDays)}</Text>
          <AppButton label="Next" variant="secondary" onPress={() => shiftWeek(7)} />
        </View>

        {message ? <Text style={styles.success}>{message}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {loading ? (
          <Card>
            <ActivityIndicator color={palette.brand[300]} />
            <Text style={styles.muted}>Loading your week...</Text>
          </Card>
        ) : (
          <>
            <View style={styles.days}>
              {weekDays.map((day) => (
                <DayCard
                  key={day.toISOString()}
                  day={day}
                  shifts={week?.shifts ?? []}
                  leave={week?.leave ?? []}
                  absences={week?.absences ?? []}
                />
              ))}
            </View>

            {(week?.shifts.length ?? 0) === 0 ? (
              <EmptyState
                title="No shifts this week"
                body="Your manager has not published shifts for this week yet."
              />
            ) : null}
          </>
        )}

        <Card>
          <SectionHeader
            title="Request leave"
            subtitle={`Requests inside ${holidayNoticeDays} days may need manager override.`}
          />
          <TextInput
            placeholder="Start date (YYYY-MM-DD)"
            placeholderTextColor="rgba(255,255,255,0.45)"
            value={leaveStart}
            onChangeText={setLeaveStart}
            style={styles.input}
            autoCapitalize="none"
          />
          <TextInput
            placeholder="End date (YYYY-MM-DD)"
            placeholderTextColor="rgba(255,255,255,0.45)"
            value={leaveEnd}
            onChangeText={setLeaveEnd}
            style={styles.input}
            autoCapitalize="none"
          />
          <TextInput
            placeholder="Optional note"
            placeholderTextColor="rgba(255,255,255,0.45)"
            value={leaveReason}
            onChangeText={setLeaveReason}
            style={[styles.input, styles.noteInput]}
            multiline
          />
          <AppButton
            label={submitting ? 'Submitting...' : 'Submit leave request'}
            onPress={() => void submitLeaveRequest()}
            disabled={submitting}
          />
        </Card>

        <SectionHeader title="Leave requests" subtitle="Track manager approval status." />
        {leaveRequests.length === 0 ? (
          <EmptyState title="No leave requests" body="Submitted requests will appear here." />
        ) : (
          leaveRequests.map((request) => (
            <LeaveRequestCard
              key={request.id}
              request={request}
              cancelling={cancellingRequestId === request.id}
              onCancel={() => void cancelLeaveRequest(request.id)}
            />
          ))
        )}
      </Screen>
    </ProtectedScreen>
  );
}

function DayCard({
  day,
  shifts,
  leave,
  absences,
}: {
  day: Date;
  shifts: RotaShift[];
  leave: StylistMyWeekResponse['leave'];
  absences: StylistMyWeekResponse['absences'];
}) {
  const dayIso = toIsoDate(day);
  const dayShifts = shifts.filter((shift) => isSameLocalDay(shift.scheduledStartAt, day));
  const dayLeave = leave.filter((item) => item.startDate <= dayIso && dayIso <= item.endDate);
  const dayAbsences = absences.filter((item) => isSameLocalDay(item.startsAt, day));

  return (
    <Card>
      <View style={styles.dayHeader}>
        <Text style={styles.dayTitle}>{day.toLocaleDateString(undefined, { weekday: 'long' })}</Text>
        <Text style={styles.muted}>{day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</Text>
      </View>
      {dayShifts.map((shift) => (
        <View key={shift.id} style={styles.shiftBlock}>
          <Text style={styles.shiftTime}>
            {formatTime(shift.scheduledStartAt)} - {formatTime(shift.scheduledEndAt)}
          </Text>
          <Text style={styles.muted}>
            {shift.breaks.length
              ? `${shift.breaks.length} break${shift.breaks.length === 1 ? '' : 's'}`
              : 'No breaks'}
          </Text>
          {shift.breaks.map((breakItem) => (
            <Text key={breakItem.id} style={styles.breakText}>
              Break {formatTime(breakItem.startedAt)} - {formatTime(breakItem.endedAt)}
              {breakItem.isPaid ? ' paid' : ' unpaid'}
            </Text>
          ))}
        </View>
      ))}
      {dayLeave.map((item) => (
        <Text key={item.id} style={styles.warningText}>Approved leave</Text>
      ))}
      {dayAbsences.map((item) => (
        <Text key={item.id} style={styles.error}>Absence: {item.absenceType}</Text>
      ))}
      {dayShifts.length === 0 && dayLeave.length === 0 && dayAbsences.length === 0 ? (
        <Text style={styles.muted}>No rota entry.</Text>
      ) : null}
    </Card>
  );
}

function LeaveRequestCard({
  request,
  cancelling,
  onCancel,
}: {
  request: RotaLeaveRequest;
  cancelling: boolean;
  onCancel: () => void;
}) {
  return (
    <Card>
      <View style={styles.dayHeader}>
        <Text style={styles.dayTitle}>{request.startDate} to {request.endDate}</Text>
        <StatusPill status={request.status} />
      </View>
      {request.reason ? <Text style={styles.muted}>{request.reason}</Text> : null}
      {request.insideNoticeWindow ? (
        <Text style={styles.warningText}>Inside notice window</Text>
      ) : null}
      {request.status === 'pending' ? (
        <Pressable
          accessibilityRole="button"
          onPress={onCancel}
          disabled={cancelling}
          style={({ pressed }) => [
            styles.cancelButton,
            pressed && styles.pressed,
            cancelling && styles.disabled,
          ]}
        >
          <Text style={styles.cancelButtonText}>{cancelling ? 'Cancelling...' : 'Cancel request'}</Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

function StatusPill({ status }: { status: RotaLeaveRequest['status'] }) {
  return (
    <View style={[styles.statusPill, statusStyle(status)]}>
      <Text style={styles.statusText}>{status.toUpperCase()}</Text>
    </View>
  );
}

function statusStyle(status: RotaLeaveRequest['status']) {
  switch (status) {
    case 'approved':
      return styles.statusApproved;
    case 'rejected':
    case 'cancelled':
      return styles.statusRejected;
    case 'pending':
    default:
      return styles.statusPending;
  }
}

function snapToMonday(date: Date): Date {
  const day = date.getDay();
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((day + 6) % 7));
  return monday;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isSameLocalDay(iso: string, day: Date): boolean {
  const date = new Date(iso);
  return (
    date.getFullYear() === day.getFullYear() &&
    date.getMonth() === day.getMonth() &&
    date.getDate() === day.getDate()
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatWeekLabel(days: Date[]): string {
  const start = days[0];
  const end = days[6];
  if (!start || !end) return '';
  return `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} - ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

const styles = StyleSheet.create({
  weekNav: {
    gap: spacing.sm,
  },
  weekLabel: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  days: {
    gap: spacing.base,
  },
  dayHeader: {
    gap: spacing.xs,
  },
  dayTitle: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '700',
  },
  muted: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 13,
  },
  shiftBlock: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.card,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  shiftTime: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '700',
  },
  breakText: {
    color: palette.brand[300],
    fontSize: 12,
  },
  input: {
    minHeight: 48,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    paddingHorizontal: spacing.base,
    color: palette.white,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  noteInput: {
    minHeight: 88,
    paddingTop: spacing.sm,
  },
  success: {
    color: palette.success[300],
    fontWeight: '700',
  },
  error: {
    color: palette.danger[300],
    fontWeight: '700',
  },
  warningText: {
    color: palette.warning[300],
    fontWeight: '700',
  },
  cancelButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.42)',
  },
  cancelButtonText: {
    color: palette.danger[300],
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.5,
  },
  statusPill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  statusText: {
    color: palette.white,
    fontSize: 11,
    fontWeight: '700',
  },
  statusApproved: {
    backgroundColor: 'rgba(74,222,128,0.24)',
  },
  statusRejected: {
    backgroundColor: 'rgba(248,113,113,0.24)',
  },
  statusPending: {
    backgroundColor: 'rgba(251,191,36,0.24)',
  },
});
