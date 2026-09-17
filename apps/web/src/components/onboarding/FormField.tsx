import {
  forwardRef,
  useId,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { cn } from '@sheer/utils';
import { PasswordInput } from '../../design/components/PasswordInput';

interface BaseFieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  trailing?: ReactNode;
  optional?: boolean;
}

const SHARED_INPUT_CLASSES =
  'w-full rounded-input-lg border border-border-strong bg-surface px-3.5 py-2.5 text-[14px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:bg-surface-alt';

interface TextFieldProps extends BaseFieldProps, InputHTMLAttributes<HTMLInputElement> {
  onValueChange?: (value: string) => void;
  /** type="password" only: false drops the show/hide button (e.g. a confirm field). */
  revealable?: boolean;
  /** type="password" only: see PasswordInput. */
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  props,
  ref,
) {
  const {
    label,
    hint,
    error,
    trailing,
    optional,
    onValueChange,
    onChange,
    className,
    id,
    type,
    revealable = true,
    revealed,
    onRevealedChange,
    ...rest
  } = props;
  const generatedId = useId();
  const inputId = id ?? rest.name ?? generatedId;
  const inputProps = {
    ref,
    id: inputId,
    className: cn(
      SHARED_INPUT_CLASSES,
      error && 'border-danger focus:border-danger focus:ring-danger/20',
      className,
    ),
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      onValueChange?.(event.target.value);
      onChange?.(event);
    },
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error || hint ? messageIdFor(inputId) : undefined,
    ...rest,
  };
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional} htmlFor={inputId}>
      {type === 'password' && revealable ? (
        <PasswordInput
          {...inputProps}
          revealed={revealed}
          onRevealedChange={onRevealedChange}
        />
      ) : (
        <div className="relative">
          <input type={type} {...inputProps} />
          {trailing ? (
            <div className="absolute inset-y-0 right-3 flex items-center text-[12px] text-text-secondary">
              {trailing}
            </div>
          ) : null}
        </div>
      )}
    </FieldShell>
  );
});

interface SelectFieldOption {
  value: string;
  label: string;
}

interface SelectFieldProps extends BaseFieldProps, SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectFieldOption[];
  onValueChange?: (value: string) => void;
  placeholder?: string;
}

export function SelectField(props: SelectFieldProps) {
  const {
    label,
    hint,
    error,
    optional,
    options,
    onValueChange,
    onChange,
    placeholder,
    id,
    className,
    ...rest
  } = props;
  const generatedId = useId();
  const inputId = id ?? rest.name ?? generatedId;
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional} htmlFor={inputId}>
      <select
        id={inputId}
        className={cn(
          SHARED_INPUT_CLASSES,
          'pr-9 appearance-none',
          error && 'border-danger focus:border-danger focus:ring-danger/20',
          className,
        )}
        onChange={(event) => {
          onValueChange?.(event.target.value);
          onChange?.(event);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageIdFor(inputId) : undefined}
        {...rest}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

function messageIdFor(controlId: string): string {
  return `${controlId}-message`;
}

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  htmlFor: string;
  children: ReactNode;
}

// The <label> holds only the label text, tied to the control by htmlFor. It
// used to wrap the whole field, which folded the hint, the error and the
// "Optional" tag into the control's accessible name, and a label may not
// contain a second labelable element such as the password show/hide button.
// The hint and error reach assistive tech through aria-describedby instead.
function FieldShell({ label, hint, error, optional, htmlFor, children }: FieldShellProps) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label
          htmlFor={htmlFor}
          className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary"
        >
          {label}
        </label>
        {optional ? (
          <span className="text-[11px] font-medium text-text-muted">Optional</span>
        ) : null}
      </div>
      {children}
      {error ? (
        <span id={messageIdFor(htmlFor)} className="mt-1.5 block text-[12px] text-danger">
          {error}
        </span>
      ) : hint ? (
        <span id={messageIdFor(htmlFor)} className="mt-1.5 block text-[12px] text-text-secondary">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
