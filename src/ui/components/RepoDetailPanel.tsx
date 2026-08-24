import { useEffect } from "react";
import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  X,
  Archive,
  Star as StarIcon,
} from "lucide-react";
import type { Star, Tag } from "@/types";
import { RepositoryNotesEditorSection } from "./RepositoryNotesEditorSection";
import { RepositoryTagEditorSection } from "./RepositoryTagEditorSection";
import { RepositoryDetailSection } from "./RepositoryEditorShared";
import { Badge } from "@/ui/shadcn/badge";
import { Button } from "@/ui/shadcn/button";
import { Separator } from "@/ui/shadcn/separator";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { CopyableRepositoryLink } from '@/ui/components/CopyableRepositoryLink';
import {
  getLockedAnchorProps,
  getLockedRegionProps,
  shouldIgnorePanelShortcut,
} from "@/ui/interaction-lock";

/** single-repo detail drawer (tag/note/suggest deep-edit lives here so rows stay compact); flex aside, no portal. */
export function RepoDetailPanel({
  star,
  tag,
  selectedTags,
  onToggleTag,
  onDataChanged,
  onMeaningfulAction,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  interactionLocked = false,
}: {
  star: Star;
  tag: Tag | undefined;
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  onDataChanged?: () => void;
  onMeaningfulAction?: () => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  interactionLocked?: boolean;
}) {
  const { m } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnorePanelShortcut(interactionLocked, e.target)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "[" && hasPrev) onPrev();
      else if (e.key === "]" && hasNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, hasPrev, hasNext, interactionLocked]);

  const selectedSet = new Set(selectedTags);

  return (
    <div
      className={cn(
        "gsm-scrollbar-stable flex h-full w-[340px] flex-col overflow-auto border-l border-border bg-card max-[640px]:w-full",
        {
          "opacity-55": interactionLocked,
        },
      )}
      {...getLockedRegionProps(interactionLocked)}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onPrev}
          disabled={!hasPrev || interactionLocked}
          title={m.repoDetail.previousTitle}
          className={cn({ "opacity-30": !hasPrev })}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNext}
          disabled={!hasNext || interactionLocked}
          title={m.repoDetail.nextTitle}
          className={cn({ "opacity-30": !hasNext })}
        >
          <ChevronRight className="size-4" />
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          disabled={interactionLocked}
          title={m.repoDetail.closeTitle}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-3">
        <div>
          <CopyableRepositoryLink
            resource={{ kind: 'repository', fullName: star.full_name, remoteUrl: star.html_url }}
            disabled={interactionLocked}
            linkClassName={cn(
              "min-w-0 break-all text-[13px] font-semibold text-primary underline underline-offset-2 hover:underline",
              { "pointer-events-none opacity-70": interactionLocked },
            )}
            linkProps={getLockedAnchorProps(interactionLocked)}
          >
            {star.full_name}
          </CopyableRepositoryLink>
          <div className="mt-0.5 flex gap-2">
            {star.archived && (
              <span
                className="inline-flex items-center gap-1 text-xs text-warning"
                title={m.starRow.archived}
              >
                <Archive className="size-3" />
                {m.starRow.archived}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          <Meta
            label={m.repoDetail.language}
            value={star.language ?? m.common.none}
          />
          <Meta
            label={m.repoDetail.stars}
            value={
              <span className="inline-flex items-center gap-0.5 tabular-nums">
                <StarIcon className="size-3 fill-current" />
                {fmt(star.stargazers_count)}
              </span>
            }
          />
          <Meta
            label={m.repoDetail.updated}
            value={star.pushed_at ? star.pushed_at.slice(0, 10) : m.common.none}
          />
          <Meta
            label={star.viewer_has_starred === false ? m.repoDetail.librarySource : m.repoDetail.starred}
            value={star.viewer_has_starred === false
              ? m.repoDetail.ownedPublicRepository
              : star.starred_at.slice(0, 10)}
          />
        </div>

        {star.description && (
          <>
            <Separator />
            <RepositoryDetailSection title={m.repoDetail.description}>
              <p className="m-0 text-xs leading-relaxed text-foreground">
                {star.description}
              </p>
            </RepositoryDetailSection>
          </>
        )}

        {star.topics.length > 0 && (
          <>
            <Separator />
            <RepositoryDetailSection title={m.repoDetail.topics(star.topics.length)}>
              <div className="flex flex-wrap gap-1">
                {star.topics.map((topic) => (
                  <button
                    key={topic}
                    onClick={() => onToggleTag(topic)}
                    title={m.repoDetail.filterTopic}
                  >
                    <Badge
                      variant={selectedSet.has(topic) ? "tagActive" : "tag"}
                      className="cursor-pointer hover:opacity-80"
                    >
                      {topic}
                    </Badge>
                  </button>
                ))}
              </div>
            </RepositoryDetailSection>
          </>
        )}

        <RepositoryTagEditorSection
          key={`tags:${star.full_name}`}
          star={star}
          tag={tag}
          selectedTags={selectedTags}
          onToggleTag={onToggleTag}
          onDataChanged={onDataChanged}
          onMeaningfulAction={onMeaningfulAction}
        />

        <RepositoryNotesEditorSection
          key={`notes:${star.full_name}`}
          star={star}
          tag={tag}
          onDataChanged={onDataChanged}
          onMeaningfulAction={onMeaningfulAction}
        />
      </div>
    </div>
  );
}


function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="gsm-muted-count-soft">{label}</div>
      <div className="text-foreground">{value}</div>
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
