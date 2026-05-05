import { cn } from '@sheer/utils';

export interface StepperStep {
  key: string;
  label: string;
}

export interface StepperProps {
  steps: StepperStep[];
  activeIndex: number;
  completedThrough: number;
}

export function Stepper({ steps, activeIndex, completedThrough }: StepperProps) {
  return (
    <ol className="flex items-center gap-2 sm:gap-3" aria-label="Onboarding progress">
      {steps.map((step, index) => {
        const isActive = index === activeIndex;
        const isComplete = index <= completedThrough && index < activeIndex;
        return (
          <li key={step.key} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold transition-colors',
                isComplete
                  ? 'border-primary bg-primary text-text-on-primary'
                  : isActive
                    ? 'border-primary bg-primary-soft text-primary-deep'
                    : 'border-border-strong bg-surface text-text-secondary',
              )}
              aria-current={isActive ? 'step' : undefined}
            >
              {isComplete ? '✓' : index + 1}
            </span>
            <span
              className={cn(
                'hidden truncate text-[12px] font-medium sm:block',
                isActive ? 'text-text-primary' : 'text-text-secondary',
              )}
            >
              {step.label}
            </span>
            {index < steps.length - 1 ? (
              <span
                className={cn(
                  'mx-1 h-px flex-1 transition-colors',
                  index < activeIndex ? 'bg-primary' : 'bg-border',
                )}
                aria-hidden
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
