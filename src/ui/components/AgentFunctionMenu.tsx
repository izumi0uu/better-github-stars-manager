import { useState, type ComponentType } from 'react';
import {
  BookOpenText,
  Braces,
  Blocks,
  ListChecks,
  Search,
  Tags,
} from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/ui/shadcn/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/shadcn/tooltip';

type FunctionItem = Readonly<{
  key: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  run: () => void;
}>;

export function AgentFunctionMenu({
  disabled,
  showRepositoryFunctions,
  showWriteFunctions = true,
  onSummarizeScope,
  onFindSimilar,
  onOrganizeUntagged,
  onReviewTags,
  onSearchCode,
  onReviewNotes,
}: {
  disabled: boolean;
  showRepositoryFunctions: boolean;
  showWriteFunctions?: boolean;
  onSummarizeScope: () => void;
  onFindSimilar: () => void;
  onOrganizeUntagged: () => void;
  onReviewTags: () => void;
  onSearchCode: () => void;
  onReviewNotes: () => void;
}) {
  const { m } = useI18n();
  const [open, setOpen] = useState(false);
  const execute = (action: () => void) => {
    setOpen(false);
    action();
  };
  const items: FunctionItem[] = [
    {
      key: 'summarize',
      label: m.agentPanel.functionSummarize,
      description: m.agentPanel.functionSummarizeDescription,
      icon: ListChecks,
      run: onSummarizeScope,
    },
    {
      key: 'similar',
      label: m.agentPanel.functionFindSimilar,
      description: m.agentPanel.functionFindSimilarDescription,
      icon: Search,
      run: onFindSimilar,
    },
    ...(showWriteFunctions ? [{
      key: 'organize',
      label: m.agentPanel.functionOrganizeUntagged,
      description: m.agentPanel.functionOrganizeUntaggedDescription,
      icon: Tags,
      run: onOrganizeUntagged,
    }] : []),
    {
      key: 'review-tags',
      label: m.agentPanel.functionReviewTags,
      description: m.agentPanel.functionReviewTagsDescription,
      icon: Blocks,
      run: onReviewTags,
    },
    ...(showRepositoryFunctions ? [
      {
        key: 'search-code',
        label: m.agentPanel.functionSearchCode,
        description: m.agentPanel.functionSearchCodeDescription,
        icon: Braces,
        run: onSearchCode,
      },
      {
        key: 'review-notes',
        label: m.agentPanel.functionReviewNotes,
        description: m.agentPanel.functionReviewNotesDescription,
        icon: BookOpenText,
        run: onReviewNotes,
      },
    ] : []),
  ];

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={150}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={disabled}
                  aria-label={m.agentPanel.functionMenuLabel}
                >
                  <Blocks className="size-4" />
                </Button>
              </PopoverTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent>{m.agentPanel.functionMenuLabel}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={6}
          collisionPadding={8}
          className="w-80 p-1"
          aria-label={m.agentPanel.functionMenuTitle}
          role="group"
        >
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
            {m.agentPanel.functionMenuTitle}
          </div>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => execute(item.run)}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">{item.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
