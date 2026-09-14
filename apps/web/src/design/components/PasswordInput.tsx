import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { cn } from '@sheer/utils';

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Whether the password is shown. Omit to let the input track it itself. */
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
}

/**
 * A password input with a show/hide toggle. Styling comes from the caller's
 * `className`, so it drops into any field look; the input only gains right
 * padding so typed characters never run under the button.
 *
 * The toggle is a sibling of the input, so a caller must not wrap this in a
 * `<label>`: a label may contain only one labelable element, its control, and
 * a button is one. Associate the label with `htmlFor` + `id` instead.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, disabled, revealed, onRevealedChange, ...rest }, ref) {
    const [ownRevealed, setOwnRevealed] = useState(false);
    const visible = revealed ?? ownRevealed;

    return (
      <div className="relative">
        <input
          ref={ref}
          type={visible ? 'text' : 'password'}
          // Edge draws its own reveal eye inside password inputs; hide it so
          // there are never two.
          className={cn('block [&::-ms-reveal]:hidden', className, 'pr-11')}
          disabled={disabled}
          // Once revealed it is a text input, and mobile keyboards would start
          // capitalising and autocorrecting the password as it is typed.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          {...rest}
        />
        <button
          type="button"
          onClick={() => {
            setOwnRevealed(!visible);
            onRevealedChange?.(!visible);
          }}
          disabled={disabled}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-controls={rest.id}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-input-lg text-text-muted transition hover:text-text-primary focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <svg
            viewBox="0 0 20 20"
            aria-hidden="true"
            className="h-[18px] w-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M1.75 10S4.75 4.25 10 4.25 18.25 10 18.25 10 15.25 15.75 10 15.75 1.75 10 1.75 10Z" />
            <circle cx="10" cy="10" r="2.5" />
            {visible ? <path d="M3.5 3.5l13 13" /> : null}
          </svg>
        </button>
      </div>
    );
  },
);
