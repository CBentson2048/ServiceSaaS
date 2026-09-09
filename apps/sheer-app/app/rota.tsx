import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { RotaLeaveRequest, RotaShift, StylistMyWeekResponse } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton, EmptyState, Screen } from '../src/design';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { AppTabBar } from '../src/navigation/AppTabBar';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';
import { BG, BORDER, BRAND, BRAND_LIGHT, CARD } from '../src/design/colors';
import { ScreenHeader } from '../src/navigation/ScreenHeader';

export default function RotaScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const [weekStart, setWeekStart] = useState(() => toIsoDate(snapToMonday(new Date())));
  const [selectedDate, setSelectedDate] = useState<Date>(() => startOfDay(new Date()));
  const [week, setWeek] = useState<StylistMyWeekResponse | null>(null);
  const [leaveRequests, setLeaveRequests] = useState<RotaLeaveRequest[]>([]);
  const [holidayNoticeDays, setHolidayNoticeDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingRequestId, setCancellingRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [leaveModalOpen, setLeaveModalOpen] = useState(false);
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

  function openLeaveModal() {
    setError(null);
    setMessage(null);
    setLeaveModalOpen(true);
  }

  const pendingLeaveCount = leaveRequests.filter((request) => request.status === 'pending').length;

  return (
    <ProtectedScreen allowedRoles={['manager', 'stylist']}>
      <Screen header={<ScreenHeader title="Rota" back={false} />}>
        {/* ── Primary action. The screen's title lives in ScreenHeader; a
             "My week" heading here as well was the double header. ── */}
        <View style={styles.header}>
          <View style={styles.flex} />
          <Pressable
            accessibilityRole="button"
            onPress={openLeaveModal}
            style={({ pressed }) => [styles.requestBtn, pressed && styles.pressed]}
          >
            <Text style={styles.requestBtnIcon}>＋</Text>
            <Text style={styles.requestBtnText}>Request leave</Text>
            {pendingLeaveCount > 0 ? (
              <View style={styles.requestBtnBadge}>
                <Text style={styles.requestBtnBadgeText}>{pendingLeaveCount}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>

        {/* ── Professional calendar week strip ── */}
        <WeekStrip
          weekDays={weekDays}
          selectedDate={selectedDate}
          onSelectDay={setSelectedDate}
          onShiftWeek={shiftWeek}
        />

        {error && !leaveModalOpen ? (
          <View style={styles.alertCard}>
            <Text style={styles.error}>{error}</Text>
          </View>
        ) : null}
        {message && !leaveModalOpen ? (
          <View style={styles.successCard}>
            <Text style={styles.success}>{message}</Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.panel}>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={palette.brand[300]} />
              <View style={styles.flex}>
                <Text style={styles.cardTitle}>Preparing your rota</Text>
                <Text style={styles.muted}>Loading your week...</Text>
              </View>
            </View>
          </View>
        ) : (
          <>
            <View style={styles.metricGrid}>
              <MetricTile label="Shifts" value={String(week?.shifts.length ?? 0)} />
              <MetricTile label="Leave days" value={String(countLeaveDays(week?.leave ?? [], weekDays))} />
              <MetricTile
                label="Absences"
                value={String(week?.absences.length ?? 0)}
                tone={(week?.absences.length ?? 0) > 0 ? 'warning' : 'default'}
              />
            </View>

            <SectionTitle title="Weekly rota" subtitle="Published shift details by day." />
            <View style={styles.days}>
              {weekDays.map((day) => (
                <DayCard
                  key={day.toISOString()}
                  day={day}
                  selected={isSameCalendarDay(day, selectedDate)}
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
      </Screen>

      <LeaveModal
        visible={leaveModalOpen}
        onClose={() => setLeaveModalOpen(false)}
        holidayNoticeDays={holidayNoticeDays}
        leaveRequests={leaveRequests}
        message={message}
        error={error}
        submitting={submitting}
        cancellingRequestId={cancellingRequestId}
        leaveStart={leaveStart}
        leaveEnd={leaveEnd}
        leaveReason={leaveReason}
        onChangeStart={setLeaveStart}
        onChangeEnd={setLeaveEnd}
        onChangeReason={setLeaveReason}
        onSubmit={() => void submitLeaveRequest()}
        onCancelRequest={(id) => void cancelLeaveRequest(id)}
      />

      <AppTabBar />
    </ProtectedScreen>
  );
}

// ── Calendar week strip ───────────────────────────────────────────────────────

function WeekStrip({
  weekDays,
  selectedDate,
  onSelectDay,
  onShiftWeek,
}: {
  weekDays: Date[];
  selectedDate: Date;
  onSelectDay: (day: Date) => void;
  onShiftWeek: (days: number) => void;
}) {
  const today = startOfDay(new Date());
  const monthAnchor = weekDays[3] ?? weekDays[0];

  return (
    <View style={styles.calendar}>
      <View style={styles.calendarHeader}>
        <Text style={styles.calendarMonth}>{monthAnchor ? monthYearLabel(monthAnchor) : ''}</Text>
        <View style={styles.calendarNav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous week"
            onPress={() => onShiftWeek(-7)}
            style={({ pressed }) => [styles.calendarNavButton, pressed && styles.pressed]}
          >
            <Text style={styles.calendarNavText}>‹</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next week"
            onPress={() => onShiftWeek(7)}
            style={({ pressed }) => [styles.calendarNavButton, pressed && styles.pressed]}
          >
            <Text style={styles.calendarNavText}>›</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.calendarWeek}>
        {weekDays.map((day) => {
          const isToday = isSameCalendarDay(day, today);
          const isSelected = isSameCalendarDay(day, selectedDate);
          return (
            <Pressable
              key={day.toISOString()}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              onPress={() => onSelectDay(day)}
              style={[
                styles.dayCell,
                isSelected && styles.dayCellSelected,
                !isSelected && isToday && styles.dayCellToday,
              ]}
            >
              <Text style={[styles.dayWeekday, isSelected && styles.dayTextSelected]}>{weekdayShort(day)}</Text>
              <Text style={[styles.dayNumber, isSelected && styles.dayTextSelected]}>{day.getDate()}</Text>
              <View
                style={[
                  styles.todayDot,
                  isToday ? styles.todayDotVisible : styles.todayDotHidden,
                  isSelected && styles.todayDotSelected,
                ]}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ── Leave request modal ───────────────────────────────────────────────────────

function LeaveModal({
  visible,
  onClose,
  holidayNoticeDays,
  leaveRequests,
  message,
  error,
  submitting,
  cancellingRequestId,
  leaveStart,
  leaveEnd,
  leaveReason,
  onChangeStart,
  onChangeEnd,
  onChangeReason,
  onSubmit,
  onCancelRequest,
}: {
  visible: boolean;
  onClose: () => void;
  holidayNoticeDays: number;
  leaveRequests: RotaLeaveRequest[];
  message: string | null;
  error: string | null;
  submitting: boolean;
  cancellingRequestId: string | null;
  leaveStart: string;
  leaveEnd: string;
  leaveReason: string;
  onChangeStart: (value: string) => void;
  onChangeEnd: (value: string) => void;
  onChangeReason: (value: string) => void;
  onSubmit: () => void;
  onCancelRequest: (id: string) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.modalScrim} onPress={onClose}>
        {/* Swallow taps on the sheet so they don't close the modal. */}
        <Pressable style={styles.modalSheet} onPress={() => undefined}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <View style={styles.flex}>
              <Text style={styles.modalTitle}>Request leave</Text>
              <Text style={styles.muted}>Requests inside {holidayNoticeDays} days may need manager override.</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={({ pressed }) => [styles.modalClose, pressed && styles.pressed]}
            >
              <Text style={styles.modalCloseText}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.modalScroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {message ? (
              <View style={styles.successCard}>
                <Text style={styles.success}>{message}</Text>
              </View>
            ) : null}
            {error ? (
              <View style={styles.alertCard}>
                <Text style={styles.error}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Start date</Text>
              <TextInput
                placeholder="YYYY-MM-DD"
                placeholderTextColor="rgba(255,255,255,0.45)"
                value={leaveStart}
                onChangeText={onChangeStart}
                style={styles.input}
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>End date</Text>
              <TextInput
                placeholder="YYYY-MM-DD"
                placeholderTextColor="rgba(255,255,255,0.45)"
                value={leaveEnd}
                onChangeText={onChangeEnd}
                style={styles.input}
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Reason (optional)</Text>
              <TextInput
                placeholder="e.g. family holiday"
                placeholderTextColor="rgba(255,255,255,0.45)"
                value={leaveReason}
                onChangeText={onChangeReason}
                style={[styles.input, styles.noteInput]}
                multiline
              />
            </View>
            <AppButton
              label={submitting ? 'Submitting...' : 'Submit leave request'}
              onPress={onSubmit}
              disabled={submitting}
            />

            <SectionTitle title="Your requests" subtitle="Track manager approval status." />
            {leaveRequests.length === 0 ? (
              <EmptyState title="No leave requests" body="Submitted requests will appear here." />
            ) : (
              <View style={styles.days}>
                {leaveRequests.map((request) => (
                  <LeaveRequestCard
                    key={request.id}
                    request={request}
                    cancelling={cancellingRequestId === request.id}
                    onCancel={() => onCancelRequest(request.id)}
                  />
                ))}
              </View>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DayCard({
  day,
  selected,
  shifts,
  leave,
  absences,
}: {
  day: Date;
  selected: boolean;
  shifts: RotaShift[];
  leave: StylistMyWeekResponse['leave'];
  absences: StylistMyWeekResponse['absences'];
}) {
  const dayIso = toIsoDate(day);
  const dayShifts = shifts.filter((shift) => isSameLocalDay(shift.scheduledStartAt, day));
  const dayLeave = leave.filter((item) => item.startDate <= dayIso && dayIso <= item.endDate);
  const dayAbsences = absences.filter((item) => isSameLocalDay(item.startsAt, day));

  return (
    <View style={[styles.dayCard, selected && styles.dayCardSelected]}>
      <View style={styles.dayHeader}>
        <View style={styles.flex}>
          <Text style={styles.dayTitle}>{day.toLocaleDateString(undefined, { weekday: 'long' })}</Text>
          <Text style={styles.muted}>{day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</Text>
        </View>
        <View style={styles.countPill}>
          <Text style={styles.countPillText}>
            {dayShifts.length ? `${dayShifts.length} shift${dayShifts.length === 1 ? '' : 's'}` : 'Open'}
          </Text>
        </View>
      </View>
      {dayShifts.map((shift) => (
        <View key={shift.id} style={styles.shiftBlock}>
          <View style={styles.detailRow}>
            <Detail label="Start" value={formatTime(shift.scheduledStartAt)} />
            <Detail label="Finish" value={formatTime(shift.scheduledEndAt)} />
            <Detail label="Breaks" value={shift.breaks.length ? String(shift.breaks.length) : 'None'} />
          </View>
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
    </View>
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
    <View style={styles.dayCard}>
      <View style={styles.dayHeader}>
        <View style={styles.flex}>
          <Text style={styles.dayTitle}>{formatDateRange(request.startDate, request.endDate)}</Text>
          <Text style={styles.muted}>{request.reason || 'No note provided'}</Text>
        </View>
        <StatusPill status={request.status} />
      </View>
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
    </View>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.sectionTitleText}>{title}</Text>
      {subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}
    </View>
  );
}

function MetricTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <View style={[styles.metricTile, tone === 'warning' && styles.metricTileWarning]}>
      <Text style={[styles.metricValue, tone === 'warning' && styles.metricValueWarning]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailBox}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
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

function startOfDay(date: Date): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setHours(0, 0, 0, 0);
  return next;
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

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function weekdayShort(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase();
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function monthYearLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatDateRange(start: string, end: string): string {
  return start === end ? start : `${start} to ${end}`;
}

function countLeaveDays(leave: StylistMyWeekResponse['leave'], weekDays: Date[]): number {
  return weekDays.filter((day) => {
    const dayIso = toIsoDate(day);
    return leave.some((item) => item.startDate <= dayIso && dayIso <= item.endDate);
  }).length;
}


const styles = StyleSheet.create({
  flex: {
    flex: 1,
    gap: spacing.xs,
  },

  // ── Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  eyebrow: {
    color: BRAND_LIGHT,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  requestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: BRAND,
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  requestBtnIcon: { color: palette.white, fontSize: 15, fontWeight: '400', marginTop: -1 },
  requestBtnText: { color: palette.white, fontSize: 13, fontWeight: '800' },
  requestBtnBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: radius.full,
    backgroundColor: palette.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  requestBtnBadgeText: { color: BRAND, fontSize: 10, fontWeight: '900' },

  // ── Calendar week strip
  calendar: {
    gap: spacing.md,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  calendarMonth: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  calendarNav: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  calendarNavButton: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  calendarNavText: {
    color: palette.white,
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 20,
  },
  calendarWeek: {
    flexDirection: 'row',
    gap: 4,
  },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    borderRadius: radius.input,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  dayCellSelected: {
    backgroundColor: BRAND,
    borderColor: BRAND,
  },
  dayCellToday: {
    borderColor: 'rgba(196,160,245,0.5)',
  },
  dayWeekday: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  dayNumber: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '800',
  },
  dayTextSelected: {
    color: palette.white,
  },
  todayDot: {
    width: 4,
    height: 4,
    borderRadius: radius.full,
  },
  todayDotVisible: {
    backgroundColor: BRAND_LIGHT,
  },
  todayDotHidden: {
    backgroundColor: 'transparent',
  },
  todayDotSelected: {
    backgroundColor: palette.white,
  },

  // ── Banners
  alertCard: {
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.34)',
    backgroundColor: 'rgba(248,113,113,0.09)',
  },
  successCard: {
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.34)',
    backgroundColor: 'rgba(74,222,128,0.09)',
  },

  // ── Loading
  panel: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
  },
  cardTitle: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '800',
  },

  // ── Metrics
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  metricTile: {
    minWidth: '31%',
    flexGrow: 1,
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
  },
  metricTileWarning: {
    borderColor: 'rgba(245,158,11,0.38)',
    backgroundColor: 'rgba(245,158,11,0.11)',
  },
  metricValue: {
    color: BRAND_LIGHT,
    fontSize: 26,
    fontWeight: '800',
  },
  metricValueWarning: {
    color: palette.warning[300],
  },
  metricLabel: {
    color: 'rgba(255,255,255,0.64)',
    fontSize: 12,
    fontWeight: '700',
  },

  // ── Sections / days
  sectionTitle: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  sectionTitleText: {
    color: palette.white,
    fontSize: 20,
    fontWeight: '800',
  },
  muted: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 13,
  },
  days: {
    gap: spacing.base,
  },
  dayCard: {
    gap: spacing.base,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
  },
  dayCardSelected: {
    borderColor: 'rgba(196,160,245,0.5)',
    backgroundColor: 'rgba(166,124,245,0.08)',
  },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  dayTitle: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '800',
  },
  countPill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(196,160,245,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.32)',
  },
  countPillText: {
    color: palette.white,
    fontSize: 12,
    fontWeight: '800',
  },
  shiftBlock: {
    gap: spacing.sm,
  },
  detailRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  detailBox: {
    flex: 1,
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.inputLg,
    backgroundColor: 'rgba(24,20,31,0.58)',
  },
  detailLabel: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  detailValue: {
    color: palette.white,
    fontSize: 12,
    fontWeight: '700',
  },
  breakText: {
    color: palette.brand[300],
    fontSize: 12,
    fontWeight: '700',
  },
  warningText: {
    color: palette.warning[300],
    fontWeight: '700',
  },
  error: {
    color: palette.danger[300],
    fontWeight: '700',
  },
  success: {
    color: palette.success[300],
    fontWeight: '700',
  },

  // ── Modal
  modalScrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  modalSheet: {
    maxHeight: '88%',
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderTopLeftRadius: radius.cardLg,
    borderTopRightRadius: radius.cardLg,
    backgroundColor: BG,
    borderTopWidth: 1,
    borderColor: BORDER,
  },
  modalHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.22)',
    marginBottom: spacing.md,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  modalTitle: {
    color: palette.white,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  modalClose: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  modalCloseText: { color: palette.white, fontSize: 14, fontWeight: '800' },
  modalScroll: {
    gap: spacing.sm,
    paddingBottom: spacing['4xl'],
  },

  // ── Form fields
  field: {
    gap: spacing.xs,
  },
  fieldLabel: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  input: {
    minHeight: 48,
    borderRadius: radius.inputLg,
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

  // ── Misc
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.5,
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
  statusPill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  statusText: {
    color: palette.white,
    fontSize: 11,
    fontWeight: '800',
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
