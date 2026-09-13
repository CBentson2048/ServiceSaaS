import { useEffect, useState, type ReactNode } from 'react';
import {
  WEEK_PRESETS,
  reportCustomRangeIssues,
  type ReportDefinition,
  type ReportFilter,
  type ReportFilterIssue,
  type ReportFilterIssueCode,
  type ReportOptions,
  type ReportPreset,
  type ResolvedReportLocation,
} from '@sheer/domain';
import { AppButton, AppText, Pill } from '../design';
import { ReportMultiSelect, type ReportMultiSelectOption } from './ReportMultiSelect';
import { sharedLocalRange } from './reportScopeLine';
import type { ReportFilterWriteMode } from './useReportFilter';

export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom',
};

const RELATIVE_PRESETS: ReportPreset[] = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'];

const RANGE_MESSAGES: Partial<Record<ReportFilterIssueCode, string>> = {
  custom_dates_required: 'Choose a start and an end date.',
  invalid_date: 'Enter dates as real calendar dates.',
  date_before_min: 'Reports go back to 1 January 2000.',
  date_after_max: 'Reports go up to 31 December 2099.',
  range_inverted: 'The start date must be on or before the end date.',
  range_too_long: 'Choose a range of 366 days or fewer.',
};

export const WEEK_START_UNCONFIGURED_MESSAGE =
  'This business has no week start configured, so weekly ranges are unavailable.';

function rangeMessage(issues: readonly ReportFilterIssue[]): string | null {
  for (const issue of issues) {
    const message = RANGE_MESSAGES[issue.code];
    if (message) return message;
  }
  return null;
}

export interface ReportControlBarProps {
  definition: ReportDefinition;
  filter: ReportFilter;
  /** Blocking problems in the URL filter (from the lenient decoder). */
  issues: readonly ReportFilterIssue[];
  /** `null` while the options load or after they failed. */
  options: ReportOptions | null;
  /** Ranges from the last result: prefill the custom form when every location shares one. */
  resolvedLocations?: readonly ResolvedReportLocation[] | null;
  disabled?: boolean;
  onChange(next: ReportFilter, mode: ReportFilterWriteMode): void;
  /**
   * Staff control slot. Rendered only when the report supports a staff control
   * (none does until R2 defines staff scope).
   */
  staffControl?: ReactNode;
  /** Report actions slot — Ticket G adds export and email here. */
  actions?: ReactNode;
}

/**
 * The Universal Report Control Bar. It never computes a date boundary: presets
 * are sent as presets and custom ranges as local YYYY-MM-DD strings, and the
 * server resolves each location's own window. It shows only the controls the
 * report supports.
 */
export function ReportControlBar(props: ReportControlBarProps) {
  const { definition, filter, issues, options, resolvedLocations, disabled = false, onChange, staffControl, actions } = props;
  const isCustom = filter.preset === 'custom';
  const [customOpen, setCustomOpen] = useState(isCustom);
  const [draftFrom, setDraftFrom] = useState(filter.from ?? '');
  const [draftTo, setDraftTo] = useState(filter.to ?? '');

  // Follow the URL (Back/Forward, a pasted link): the draft mirrors it.
  useEffect(() => {
    setCustomOpen(filter.preset === 'custom');
    setDraftFrom(filter.from ?? '');
    setDraftTo(filter.to ?? '');
  }, [filter.preset, filter.from, filter.to]);

  const weekStartMissing = options !== null && options.weekStartDay === null;
  const draftIssues = reportCustomRangeIssues(draftFrom || undefined, draftTo || undefined);
  const draftMessage = rangeMessage(draftIssues);
  const urlRangeMessage = isCustom ? rangeMessage(issues) : null;

  const choosePreset = (preset: ReportPreset) => {
    onChange({ preset, locationIds: filter.locationIds, staffProfileIds: filter.staffProfileIds, view: filter.view }, 'push');
  };

  const openCustom = () => {
    if (!isCustom) {
      const shared = sharedLocalRange(resolvedLocations);
      setDraftFrom(shared?.from ?? '');
      setDraftTo(shared?.to ?? '');
    }
    setCustomOpen(true);
  };

  const applyCustom = () => {
    if (draftIssues.length > 0) return;
    onChange({ ...filter, preset: 'custom', from: draftFrom, to: draftTo }, 'push');
  };

  const locationOptions: ReportMultiSelectOption[] = options
    ? [
        ...options.locations.filter((l) => l.isActive),
        ...options.locations.filter((l) => !l.isActive),
      ].map((location) => ({
        id: location.id,
        label: location.name,
        group: location.isActive ? 'Open' : 'Closed',
        disabled: !location.timezoneValid,
        note: location.timezoneValid ? undefined : 'Time zone needs fixing',
      }))
    : [];
  const singleLocation =
    options !== null && options.locations.length === 1 && filter.locationIds.every((id) => id === options.locations[0].id)
      ? options.locations[0]
      : null;

  return (
    <div className="flex flex-col gap-3" aria-label="Report controls" role="group">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Date range">
        {RELATIVE_PRESETS.map((preset) => {
          const unavailable = weekStartMissing && WEEK_PRESETS.includes(preset);
          return (
            <Pill
              key={preset}
              label={REPORT_PRESET_LABELS[preset]}
              tone="ink"
              active={filter.preset === preset}
              disabled={disabled || unavailable}
              title={unavailable ? WEEK_START_UNCONFIGURED_MESSAGE : undefined}
              onClick={() => choosePreset(preset)}
            />
          );
        })}
        <Pill
          label={REPORT_PRESET_LABELS.custom}
          tone="ink"
          active={isCustom || customOpen}
          disabled={disabled}
          onClick={openCustom}
        />
      </div>

      {weekStartMissing ? (
        <AppText as="p" variant="caption" tone="warning">
          {WEEK_START_UNCONFIGURED_MESSAGE}
        </AppText>
      ) : null}

      {customOpen ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            From
            <input
              type="date"
              aria-label="From"
              value={draftFrom}
              disabled={disabled}
              onChange={(event) => setDraftFrom(event.target.value)}
              className="rounded-input-lg border border-border bg-surface px-2 py-1 text-[13px] text-text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
            To
            <input
              type="date"
              aria-label="To"
              value={draftTo}
              disabled={disabled}
              onChange={(event) => setDraftTo(event.target.value)}
              className="rounded-input-lg border border-border bg-surface px-2 py-1 text-[13px] text-text-primary"
            />
          </label>
          <AppButton size="sm" onClick={applyCustom} disabled={disabled || draftIssues.length > 0}>
            Apply
          </AppButton>
          {!isCustom ? (
            <AppButton size="sm" variant="ghost" onClick={() => setCustomOpen(false)} disabled={disabled}>
              Cancel
            </AppButton>
          ) : null}
          {draftMessage || urlRangeMessage ? (
            <AppText as="p" variant="caption" tone="warning" className="w-full">
              {draftMessage ?? urlRangeMessage}
            </AppText>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {singleLocation ? (
          <AppText as="span" variant="caption" tone="secondary">
            Location: <span className="font-medium text-text-primary">{singleLocation.name}</span>
            {singleLocation.isActive ? null : <span> · Closed</span>}
            {singleLocation.timezoneValid ? null : <span className="text-warning"> · Time zone needs fixing</span>}
          </AppText>
        ) : (
          <ReportMultiSelect
            label="Locations"
            allLabel="All locations"
            pluralNoun="locations"
            options={locationOptions}
            value={filter.locationIds}
            disabled={disabled || options === null}
            onCommit={(next) => onChange({ ...filter, locationIds: next }, 'push')}
          />
        )}

        {definition.controls.staff && staffControl ? <div>{staffControl}</div> : null}

        {definition.controls.detail ? (
          <div className="flex items-center gap-2" role="tablist" aria-label="View">
            <Pill
              label="Summary"
              tone="ink"
              active={filter.view === 'summary'}
              disabled={disabled}
              onClick={() => onChange({ ...filter, view: 'summary' }, 'push')}
            />
            <Pill
              label="Detail"
              tone="ink"
              active={filter.view === 'detail'}
              disabled={disabled}
              onClick={() => onChange({ ...filter, view: 'detail' }, 'push')}
            />
          </div>
        ) : null}

        {actions ? (
          <div role="group" aria-label="Report actions" className="ml-auto flex items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
