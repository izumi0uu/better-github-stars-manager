import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  PenLine,
} from 'lucide-react';
import { MAX_SEMANTIC_TAG_NAME_BYTES } from '@/bgsm-agent/policy';
import type { ProposalReviewRow } from '@/bgsm-agent/proposal';
import type { WorkbenchProposalSummary } from '@/ui/agent-workbench-state';
import { useI18n, type MessageCatalog } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/shadcn/button';
import { Checkbox } from '@/ui/shadcn/checkbox';

export type AgentRunMode = 'scope' | 'analyze' | 'review' | 'apply' | 'receipt';
type AgentWorkbenchLabels = MessageCatalog['agentPanel']['workbench'];

type ReviewRejectReason = 'wrong_repo' | 'tag_too_broad' | 'already_covered' | 'not_useful';
type ReviewDecisionReason = ReviewRejectReason | 'edited';

type ReviewDecision = Readonly<{
  rejected: boolean;
  reason?: ReviewDecisionReason;
  correctedFrom?: string;
  correctedTag?: string;
}>;

type EditingState = Readonly<{
  rowId: string;
  actionIndex: number;
  value: string;
  error: string | null;
}>;

const REJECT_REASONS: readonly ReviewRejectReason[] = [
  'wrong_repo',
  'tag_too_broad',
  'already_covered',
  'not_useful',
];

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

export function AgentProposalReviewCard({
  proposal,
  selectedProposalRowIds,
  reviewEditable,
  applyInFlight,
  applySelectedTotal,
  selectedRepositoryCount,
  selectedActionCount,
  coveredRepositoryCount,
  rowOffset = 0,
  nextRowOffset = null,
  onToggleRow,
  onSelectAll,
  onClear,
  onApplySelected,
  onInsertCorrection,
  onPageChange,
}: {
  proposal: WorkbenchProposalSummary;
  selectedProposalRowIds: ReadonlySet<string>;
  reviewEditable: boolean;
  applyInFlight: boolean;
  applySelectedTotal: number;
  selectedRepositoryCount?: number;
  selectedActionCount?: number;
  coveredRepositoryCount: number;
  rowOffset?: number;
  nextRowOffset?: number | null;
  onToggleRow: (proposalRowId: string) => void;
  onSelectAll: (selected: boolean) => void;
  onClear: () => void;
  onApplySelected: () => void;
  onInsertCorrection: (prompt: string) => void;
  onPageChange?: (rowOffset: number) => void;
}) {
  const { m } = useI18n();
  const labels = m.agentPanel.workbench;
  const rows = proposal.review.rows;
  const [expandedRows, setExpandedRows] = useState<Readonly<Record<string, boolean>>>({});
  const [decisions, setDecisions] = useState<Readonly<Record<string, ReviewDecision>>>({});
  const [editing, setEditing] = useState<EditingState | null>(null);

  useEffect(() => {
    setExpandedRows({});
    setDecisions({});
    setEditing(null);
  }, [proposal.proposalId]);

  const selectedCount = selectedRepositoryCount ?? selectedProposalRowIds.size;
  const selectedTags = selectedActionCount ?? selectedCount;
  const rejectedRows = rows.filter((row) => decisions[row.proposalRowId]?.rejected);
  const rejectedDetails = rejectedRows.map((row) => {
    const decision = decisions[row.proposalRowId];
    return `${row.repositoryId}: ${decisionReasonText(labels, decision)}`;
  });

  const reasonFor = (row: ProposalReviewRow): string => (
    decisionReasonText(labels, decisions[row.proposalRowId])
  );

  const rejectRow = (row: ProposalReviewRow, reason: ReviewRejectReason) => {
    if (!reviewEditable) return;
    setDecisions((current) => ({
      ...current,
      [row.proposalRowId]: { rejected: true, reason },
    }));
    if (selectedProposalRowIds.has(row.proposalRowId)) onToggleRow(row.proposalRowId);
  };

  const undoReject = (row: ProposalReviewRow) => {
    setDecisions((current) => ({
      ...current,
      [row.proposalRowId]: { rejected: false },
    }));
    setEditing(null);
  };

  const saveEdit = (row: ProposalReviewRow, actionIndex: number) => {
    if (!editing || editing.rowId !== row.proposalRowId || editing.actionIndex !== actionIndex) return;
    const error = validateEditedTag(labels, row, actionIndex, editing.value);
    if (error) {
      setEditing({ ...editing, error });
      return;
    }
    const action = row.proposedActions[actionIndex];
    if (!action) return;
    setDecisions((current) => ({
      ...current,
      [row.proposalRowId]: {
        rejected: true,
        reason: 'edited',
        correctedFrom: action.tag,
        correctedTag: editing.value,
      },
    }));
    if (selectedProposalRowIds.has(row.proposalRowId)) onToggleRow(row.proposalRowId);
    setEditing(null);
  };

  const askRevise = (row: ProposalReviewRow) => {
    const decision = decisions[row.proposalRowId];
    if (!decision?.rejected) return;
    if (decision.reason === 'edited' && decision.correctedFrom && decision.correctedTag) {
      onInsertCorrection(labels.reviewEditCorrectionPrompt(
        row.repositoryId,
        decision.correctedFrom,
        decision.correctedTag,
      ));
      return;
    }
    if (decision.reason && decision.reason !== 'edited') {
      onInsertCorrection(labels.reviewRejectCorrectionPrompt(
        row.repositoryId,
        rejectReasonLabel(labels, decision.reason),
      ));
    }
  };

  return (
    <div
      className="w-full overflow-hidden rounded-[10px] border border-border bg-card"
      data-testid="organize-job-proposal-card"
    >
      <div className="flex items-start gap-2 border-b border-border/70 px-3 pb-2 pt-2.5">
        <div className="mt-0.5 grid size-5 place-items-center text-muted-foreground">
          <PenLine className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold leading-tight text-foreground">
            {labels.reviewSuggestions}
          </div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
            {labels.proposalCounts(proposal.actionableCount, proposal.nonActionableCount, selectedCount)}
            {rejectedRows.length > 0 ? ` · ${labels.reviewRejectedWithReason(String(rejectedRows.length))}` : ''}
          </div>
        </div>
      </div>
      <div className="px-3 pb-3 pt-2.5 text-[12.5px] text-muted-foreground">
        <p className="mb-2 rounded-md bg-muted px-2 py-1.5 font-medium text-foreground" role="status">
          {labels.reviewCoverageComplete(coveredRepositoryCount)}
        </p>
        <p className="mb-2 rounded-md bg-muted/40 px-2 py-1.5 text-[11.5px] leading-4">
          {labels.reviewLocalOnlyNote}
        </p>
        <div className="max-h-72 space-y-0 overflow-y-auto pr-0.5" aria-label={labels.reviewSuggestions}>
          {rows.map((row, index) => (
            <ProposalReviewRow
              key={row.proposalRowId}
              row={row}
              index={index}
              expanded={!!expandedRows[row.proposalRowId]}
              decision={decisions[row.proposalRowId]}
              selected={selectedProposalRowIds.has(row.proposalRowId)}
              editable={reviewEditable}
              editing={editing}
              onToggleExpanded={() => setExpandedRows((current) => ({
                ...current,
                [row.proposalRowId]: !current[row.proposalRowId],
              }))}
              onToggleSelected={() => onToggleRow(row.proposalRowId)}
              onReject={(reason) => rejectRow(row, reason)}
              onUndoReject={() => undoReject(row)}
              onStartEdit={(actionIndex) => {
                const action = row.proposedActions[actionIndex];
                if (!action) return;
                setEditing({
                  rowId: row.proposalRowId,
                  actionIndex,
                  value: action.tag,
                  error: null,
                });
              }}
              onEditChange={(value) => setEditing((current) => (
                current && current.rowId === row.proposalRowId
                  ? { ...current, value, error: null }
                  : current
              ))}
              onSaveEdit={saveEdit}
              onCancelEdit={() => setEditing(null)}
              onAskRevise={() => askRevise(row)}
              reasonFor={reasonFor}
            />
          ))}
        </div>
        {applyInFlight ? (
          <div
            className="mb-2.5 rounded-md border border-border bg-muted/20 px-2.5 py-2"
            data-testid="organize-job-applying-progress"
          >
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
              <span className="size-3.5 animate-spin rounded-full border border-foreground/30 border-t-foreground" aria-hidden="true" />
              {labels.applyingSelectedChanges}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={labels.applyingSelectedChanges}>
              <div className="h-full w-1/2 animate-pulse rounded-full bg-foreground/80 motion-reduce:animate-none" />
            </div>
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">
              {labels.selectedRowsLocked(applySelectedTotal)}
            </p>
          </div>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            className="h-8 px-3 text-xs font-semibold"
            onClick={onApplySelected}
            disabled={selectedCount === 0 || !reviewEditable || applyInFlight}
          >
            {applyInFlight
              ? labels.applying
              : selectedRepositoryCount === undefined
                ? labels.applySelected(selectedCount)
                : labels.applyTagImpact(selectedTags, selectedCount)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => onSelectAll(true)}
            disabled={!reviewEditable || selectedCount === proposal.actionableCount}
          >
            {labels.selectAll}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={onClear}
            disabled={!reviewEditable || selectedCount === 0}
          >
            {labels.clear}
          </Button>
          {rejectedRows.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => onInsertCorrection(labels.reviewReviseRejectedPrompt(rejectedDetails.join('\n')))}
            >
              {labels.reviewReviseRejected(rejectedRows.length)}
            </Button>
          ) : null}
        </div>
        {onPageChange && proposal.actionableCount > rows.length ? (
          <div className="mt-2 flex items-center justify-between border-t border-border/70 pt-2">
            <span className="text-[11.5px] text-muted-foreground">
              {labels.reviewPageRange(
                rowOffset + 1,
                Math.min(proposal.actionableCount, rowOffset + rows.length),
                proposal.actionableCount,
              )}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => onPageChange(Math.max(0, rowOffset - 100))}
                disabled={!reviewEditable || rowOffset === 0}
                title={labels.previousPage}
                aria-label={labels.previousPage}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => nextRowOffset !== null && onPageChange(nextRowOffset)}
                disabled={!reviewEditable || nextRowOffset === null}
                title={labels.nextPage}
                aria-label={labels.nextPage}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProposalReviewRow({
  row,
  index,
  expanded,
  decision,
  selected,
  editable,
  editing,
  onToggleExpanded,
  onToggleSelected,
  onReject,
  onUndoReject,
  onStartEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onAskRevise,
  reasonFor,
}: {
  row: ProposalReviewRow;
  index: number;
  expanded: boolean;
  decision: ReviewDecision | undefined;
  selected: boolean;
  editable: boolean;
  editing: EditingState | null;
  onToggleExpanded: () => void;
  onToggleSelected: () => void;
  onReject: (reason: ReviewRejectReason) => void;
  onUndoReject: () => void;
  onStartEdit: (actionIndex: number) => void;
  onEditChange: (value: string) => void;
  onSaveEdit: (row: ProposalReviewRow, actionIndex: number) => void;
  onCancelEdit: () => void;
  onAskRevise: () => void;
  reasonFor: (row: ProposalReviewRow) => string;
}) {
  const { m } = useI18n();
  const labels = m.agentPanel.workbench;
  const [rejectOpen, setRejectOpen] = useState(false);
  const rejected = !!decision?.rejected;

  return (
    <article
      className={cn('py-2', {
        'border-t border-border/70': index > 0,
        'opacity-85': rejected,
      })}
      data-testid="organize-job-proposal-row"
    >
      <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
        <Checkbox
          className="mt-0.5"
          checked={selected && !rejected}
          onCheckedChange={onToggleSelected}
          aria-label={labels.selectRepository(row.repositoryId)}
          disabled={!editable || rejected}
        />
        <div className="min-w-0">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <a
              className="inline-flex min-w-0 items-center gap-1 text-[12.5px] font-medium text-foreground hover:underline"
              href={`https://github.com/${row.repositoryId}`}
              target="_blank"
              rel="noreferrer"
              title={labels.reviewOpenRepository}
            >
              <span className="truncate">{row.repositoryId}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[11px]"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
            >
              {expanded
                ? <ChevronDown className="size-3.5" data-icon="inline-start" />
                : <ChevronRight className="size-3.5" data-icon="inline-start" />}
              {expanded ? labels.reviewCollapseRow : labels.reviewExpandRow}
            </Button>
          </div>

          {rejected ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full border border-border px-1.5 py-0.5 text-[11px] text-foreground">
                {labels.reviewRejectedWithReason(reasonFor(row))}
              </span>
              {decision?.reason === 'edited' && decision.correctedTag ? (
                <span className="rounded-full border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {labels.reviewNeedsReanalysis}
                </span>
              ) : null}
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onUndoReject} disabled={!editable}>
                {labels.reviewUndoReject}
              </Button>
              <Button variant="outline" size="sm" className="h-6 px-1.5 text-[11px]" onClick={onAskRevise}>
                {labels.reviewAskRevise}
              </Button>
            </div>
          ) : null}

          <ul className="mt-2 space-y-2">
            {row.proposedActions.map((action, actionIndex) => {
              const actionEditing = editing?.rowId === row.proposalRowId && editing.actionIndex === actionIndex;
              return (
                <li
                  key={`${action.kind}:${action.tag}:${actionIndex}`}
                  className="rounded-md border border-border/70 bg-background px-2 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {action.kind === 'add_existing_tag' ? labels.reviewExistingTag : labels.reviewNewTag}
                    </span>
                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                      +{action.tag}
                    </span>
                    {!rejected && editable ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        onClick={() => onStartEdit(actionIndex)}
                      >
                        {labels.reviewEditTag}
                      </Button>
                    ) : null}
                  </div>
                  {actionEditing && editing ? (
                    <div className="mt-2 space-y-1.5">
                      <input
                        value={editing.value}
                        onChange={(event) => onEditChange(event.currentTarget.value)}
                        aria-label={labels.reviewEditTagLabel(row.repositoryId, action.tag)}
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                      {editing.error ? (
                        <p className="text-[11.5px] text-destructive" role="alert">{editing.error}</p>
                      ) : null}
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" className="h-7 px-2 text-xs" onClick={() => onSaveEdit(row, actionIndex)}>
                          {labels.reviewSaveEdit}
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onCancelEdit}>
                          {labels.reviewCancelEdit}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  <p className="mt-1 text-xs leading-5 text-foreground/90">
                    <span className="font-medium">{labels.reviewEvidence}:</span> {action.evidence}
                  </p>
                </li>
              );
            })}
          </ul>

          {!rejected && editable ? (
            <div className="mt-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px] text-muted-foreground"
                onClick={() => setRejectOpen((current) => !current)}
                aria-expanded={rejectOpen}
              >
                <CircleSlash className="size-3.5" data-icon="inline-start" />
                {labels.reviewReject}
              </Button>
              {rejectOpen ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {REJECT_REASONS.map((reason) => (
                    <Button
                      key={reason}
                      variant="outline"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => {
                        setRejectOpen(false);
                        onReject(reason);
                      }}
                    >
                      {rejectReasonLabel(labels, reason)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {expanded ? (
            <div className="mt-2 rounded-md bg-muted/30 px-2 py-1.5 text-[11.5px] leading-4 text-muted-foreground">
              proposalRowId: {row.proposalRowId} · frozenIndex: {row.frozenIndex} · preselected: {String(row.preselected)}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function decisionReasonText(
  labels: AgentWorkbenchLabels,
  decision: ReviewDecision | undefined,
): string {
  if (decision?.reason === 'edited' && decision.correctedTag) {
    return labels.reviewCorrectedTo(decision.correctedTag);
  }
  if (decision?.reason && decision.reason !== 'edited') {
    return rejectReasonLabel(labels, decision.reason);
  }
  return labels.reviewReject;
}

function rejectReasonLabel(
  labels: AgentWorkbenchLabels,
  reason: ReviewRejectReason,
): string {
  if (reason === 'wrong_repo') return labels.reviewRejectWrongRepo;
  if (reason === 'tag_too_broad') return labels.reviewRejectTooBroad;
  if (reason === 'already_covered') return labels.reviewRejectAlreadyCovered;
  return labels.reviewRejectNotUseful;
}

function validateEditedTag(
  labels: AgentWorkbenchLabels,
  row: ProposalReviewRow,
  actionIndex: number,
  value: string,
): string | null {
  if (value.trim().length === 0 || value.trim() !== value) return labels.reviewEditInvalidEmpty;
  if (value !== value.normalize('NFKC')) return labels.reviewEditInvalidNormalized;
  if (new TextEncoder().encode(value).byteLength > MAX_SEMANTIC_TAG_NAME_BYTES) {
    return labels.reviewEditInvalidTooLong;
  }
  const key = value.normalize('NFKC').toLocaleLowerCase('en-US');
  const duplicate = row.proposedActions.some((action, index) => (
    index !== actionIndex && action.tag.normalize('NFKC').toLocaleLowerCase('en-US') === key
  ));
  if (duplicate) return labels.reviewEditInvalidDuplicate;
  return null;
}
