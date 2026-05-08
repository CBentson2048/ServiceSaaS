import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

export function ClientBookingShell({
  title,
  step,
  children,
  footer,
}: {
  title: string;
  step: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="min-h-full bg-[#f7f4ff] text-text-primary">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col bg-[#fbf9ff] shadow-hero sm:my-6 sm:min-h-[720px] sm:rounded-[28px]">
        <header className="rounded-b-none bg-[#1C1628] px-4 pb-2 pt-3 text-white sm:rounded-t-[28px]">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="text-[13px] font-medium text-white/85"
            >
              Back
            </button>
            <div className="text-[13px] font-semibold">{title}</div>
            <div className="text-[11px] text-white/55">{step}</div>
          </div>
          <div className="mt-3 h-1 rounded-full bg-white/12">
            <div className="h-1 rounded-full bg-primary" style={{ width: progressWidth(step) }} />
          </div>
        </header>
        <main className="flex-1 px-4 pb-28 pt-5">{children}</main>
        {footer ? (
          <div className="sticky bottom-0 border-t border-border bg-[#fbf9ff]/95 px-4 py-4 backdrop-blur sm:rounded-b-[28px]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function progressWidth(step: string): string {
  const match = /(\d+)/.exec(step);
  const current = match ? Number(match[1]) : 1;
  return `${Math.min(100, Math.max(12, (current / 8) * 100))}%`;
}
