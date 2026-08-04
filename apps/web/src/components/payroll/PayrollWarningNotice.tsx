import type { PayrollWarning } from '@sheer/domain';
import { isBlockingPayrollWarning } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { AppText } from '../../design';

/**
 * Renders payroll warnings without ever masking them as figures. Two classes,
 * deliberately kept apart (see packages/domain/src/payroll.ts §3):
 *  - `input_missing` BLOCKS calculation → red notice. A statement generated
 *    without an hourly rate would silently pay £0, so we refuse instead.
 *  - `source_unavailable` / `accelerator_unevaluable` / `source_variance`
 *    annotate the figures → amber notice. An unavailable source means "we are
 *    not recording this" and is NEVER rendered as £0.
 */
export function PayrollWarningNotice({
  warnings,
  className,
}: {
  warnings: PayrollWarning[];
  className?: string;
}) {
  if (warnings.length === 0) return null;
  const blocking = warnings.filter((warning) => isBlockingPayrollWarning(warning));
  const advisory = warnings.filter((warning) => !isBlockingPayrollWarning(warning));
  return (
    <div className={cn('space-y-2', className)}>
      {blocking.length > 0 ? <NoticeList tone="danger" warnings={blocking} /> : null}
      {advisory.length > 0 ? <NoticeList tone="warning" warnings={advisory} /> : null}
    </div>
  );
}

const KIND_LABELS: Record<PayrollWarning['kind'], string> = {
  source_unavailable: 'Not captured',
  input_missing: 'Missing input',
  accelerator_unevaluable: 'Could not evaluate',
  source_variance: 'Sources disagree',
};

function NoticeList({
  tone,
  warnings,
}: {
  tone: 'danger' | 'warning';
  warnings: PayrollWarning[];
}) {
  return (
    <ul
      className={cn(
        'space-y-1 rounded-input-lg border px-3 py-2.5',
        tone === 'danger'
          ? 'border-danger-border bg-danger-soft'
          : 'border-warning-border bg-warning-soft',
      )}
    >
      {warnings.map((warning, index) => (
        <li key={`${warning.kind}-${index}`} className="flex items-start gap-2">
          <AppText
            as="span"
            variant="micro"
            weight="medium"
            uppercase
            tone={tone}
            className="mt-0.5 shrink-0"
          >
            {KIND_LABELS[warning.kind]}
          </AppText>
          <AppText as="span" variant="caption" tone={tone}>
            {warningDetail(warning)}
          </AppText>
        </li>
      ))}
    </ul>
  );
}

function warningDetail(warning: PayrollWarning): string {
  if (warning.kind === 'source_unavailable' && warning.stageLabel) {
    return `${warning.message} (${warning.stageLabel})`;
  }
  return warning.message;
}
