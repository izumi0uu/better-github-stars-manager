import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export type AgentRunMode = 'scope' | 'analyze' | 'review' | 'apply' | 'receipt';

/** Runtime-neutral Cubby run progress; it owns no execution or writable action. */
export function AgentRunStepper({ mode }: { mode: AgentRunMode }) {
  const { m } = useI18n();
  const labels = m.agentPanel.workbench;
  const steps = [
    { key: 'scope', label: labels.runStepScope },
    { key: 'analyze', label: labels.runStepAnalyze },
    { key: 'review', label: labels.runStepReview },
    { key: 'apply', label: labels.runStepApply },
    { key: 'receipt', label: labels.runStepReceipt },
  ] as const;
  const currentIndex = Math.max(0, steps.findIndex((step) => step.key === mode));

  return (
    <ol
      className="flex w-fit max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border border-border bg-background px-2 py-1"
      aria-label={labels.runStepsLabel}
      data-testid="agent-run-stepper"
    >
      {steps.map((step, index) => {
        const current = index === currentIndex;
        const done = index < currentIndex;
        return (
          <li
            key={step.key}
            aria-current={current ? 'step' : undefined}
            data-testid={current ? 'agent-run-step-current' : undefined}
            className={cn(
              'flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide',
              {
                'text-foreground': current,
                'text-muted-foreground': done,
                'text-muted-foreground/60': !current && !done,
              },
            )}
          >
            <span
              className={cn('size-1.5 rounded-full', {
                'bg-foreground': current,
                'bg-muted-foreground/70': done,
                'bg-muted-foreground/30': !current && !done,
              })}
              aria-hidden="true"
            />
            {step.label}
            {index < steps.length - 1 ? <span aria-hidden="true" className="text-muted-foreground/40">/</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
